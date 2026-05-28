/**
 * GET /governance/stats — aggregated counts and totals across every
 * governance action ever stored. Powers the "Governance History" reference
 * page and the dashboard summary widgets.
 *
 * Response shape (mirrors the brief):
 *   {
 *     total: 109,
 *     byStatus: { active, enacted, dropped, expired },
 *     byType:   { TreasuryWithdrawals, InfoAction, ParameterChange, ... },
 *     byMetadataSource: { 'on-chain-anchor': N, 'proposal-pillar': N, ... },
 *     treasuryWithdrawnLovelace: "1234567890123456",  // stringified BigInt
 *     earliestSubmittedAt: "2024-09-01T...",
 *     latestSubmittedAt:   "2026-05-01T..."
 *   }
 *
 * Implementation: four parallel `Query`s against `status-submittedAt-index`
 * (one per lifecycle status). Each Query pages internally to drain the GSI.
 *
 * # Why Query, not Scan
 *
 * The previous implementation did a full-table `Scan` (with projection) on
 * every cold container. At today's ~109 rows that's tens of milliseconds
 * and a handful of RCU; the cost is genuinely fine TODAY. The reason for
 * Query is scalability — Scan reads (and bills for) every item in the
 * table regardless of how many it returns, and `governance_actions` grows
 * monotonically on the order of dozens per epoch. A Query against the
 * existing `status-submittedAt-index` GSI reads only the rows under each
 * status partition, with cost proportional to data returned rather than
 * data stored.
 *
 * The GSI already exists (see `infra/lib/database-stack.ts` —
 * `status-submittedAt-index`, PK=`status`, SK=`submittedAt`, projection
 * type ALL) and is used by `handlers/governance/list.ts`. We piggyback on
 * it for free.
 *
 * # Why 4 parallel Queries, not one Scan
 *
 * Cost comparison (Cardano mainnet as of 2026-05-28, ~109 actions):
 *
 *   - Scan with projection: bills for every item examined. ~109 small
 *     rows × ~250B each = ~27KB read → ~7 RCU. One round-trip.
 *   - Per-status Queries: bills for items returned. 4 partitions × ~30
 *     rows each = same ~7 RCU total. Four round-trips (issued in
 *     parallel via Promise.all), so latency is bounded by the slowest
 *     single Query, typically ~10-15ms.
 *
 * The 4-way fan-out has negligibly more RCU than the Scan at TODAY's
 * scale, equal latency in practice (DDB Queries against a single GSI
 * partition are reliably fast), and avoids the linear-in-table-size
 * blow-up the Scan would hit once we accumulate thousands of actions.
 *
 * Caching: a 60-second in-memory cache keyed on the Lambda warm container.
 * Stats don't change minute-to-minute, and a 1-minute TTL aligns with the
 * governance-intake cadence — the "live count" the UI surfaces is at worst
 * one sync cycle stale, which the user accepts implicitly when the data is
 * advertised as "synced from Cardano mainnet". The cache is per-container,
 * so under heavy fan-out a fresh container will recompute on its first hit;
 * that's fine — even four parallel Queries complete in well under 100ms.
 *
 * The handler is read-only and unauthenticated, matching `/governance` (the
 * paginated list) which is also public.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { queryItems, tableNames } from '../../lib/dynamodb';
import type { GovernanceActionItem, GovernanceActionStatus } from '../../lib/types';
import { ok, internalError } from '../_response';

interface GovernanceStats {
  /** Total number of governance actions ever stored. */
  total: number;
  /** Counts bucketed by lifecycle status. Unknown statuses (e.g. a future
   *  state the type doesn't enumerate yet) are NOT collected here — only
   *  the four canonical statuses below are surveyed. If a new status ever
   *  shows up on-chain it must be added to `STATUSES` for the bucket to
   *  appear. */
  byStatus: Record<string, number>;
  /** Counts bucketed by `actionType`. Any unknown actionTypes are dropped
   *  rather than silently rolled into a bucket — keeps the sum honest. */
  byType: Record<string, number>;
  /** Counts bucketed by `metadataSource`. Keys are `on-chain-anchor` /
   *  `proposal-pillar` / `none`. Surfaces metadata-coverage health: a
   *  growing `none` bucket means more anchors we can't retrieve, which
   *  the multi-gateway IPFS fallback is intended to keep at zero. */
  byMetadataSource: Record<string, number>;
  /** Sum of `treasuryWithdrawalLovelace` across ENACTED TreasuryWithdrawals
   *  ONLY. Active / dropped / expired treasury withdrawals haven't moved
   *  any ADA — including them would overstate the figure. Stringified
   *  BigInt: total ADA in lovelace can pass 2^53 once aggregated. */
  treasuryWithdrawnLovelace: string;
  /** Earliest `submittedAt` ISO-8601 across all rows. Undefined when the
   *  table is empty. Useful as "since governance went live". */
  earliestSubmittedAt?: string;
  /** Latest `submittedAt` ISO-8601 across all rows. */
  latestSubmittedAt?: string;
}

interface CachedStats {
  expiresAt: number;
  payload: GovernanceStats;
}

/** Per-container cache. Module-scope so warm invocations reuse it. */
let cache: CachedStats | null = null;
const CACHE_TTL_MS = 60_000;

/**
 * Every lifecycle status we expect to find on-chain. Must match
 * `GovernanceActionStatus` in `lib/types.ts`. If a new status is added
 * there (e.g. CIP-1694 amendment, or a future Cardano upgrade), append it
 * here so the stats handler surveys it.
 */
const STATUSES: readonly GovernanceActionStatus[] = [
  'active',
  'enacted',
  'dropped',
  'expired',
] as const;

/**
 * Drain the entire `status-submittedAt-index` partition for one status,
 * returning every item. Pagination is internal — the caller gets a single
 * concatenated array.
 *
 * Exported only for testability (the test suite mocks `queryItems` and
 * asserts the per-status fan-out works correctly).
 */
export async function queryAllForStatus(
  status: GovernanceActionStatus,
): Promise<GovernanceActionItem[]> {
  const acc: GovernanceActionItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  // Safety cap: DDB Query auto-pages at 1MB. The GSI projection is ALL,
  // so a 1MB page = roughly 4000 items at ~250B each. We loop until
  // LastEvaluatedKey is absent. The hard cap below guards against a
  // pathological loop if the projection ever balloons — at 50 pages we
  // would have read ~200k items, well past anything plausible.
  for (let page = 0; page < 50; page++) {
    const result = await queryItems<GovernanceActionItem>(
      tableNames.governanceActions,
      {
        indexName: 'status-submittedAt-index',
        keyConditionExpression: '#status = :status',
        expressionAttributeNames: { '#status': 'status' },
        expressionAttributeValues: { ':status': status },
        ...(exclusiveStartKey ? { exclusiveStartKey } : {}),
      },
    );
    acc.push(...result.items);
    exclusiveStartKey = result.lastEvaluatedKey;
    if (!exclusiveStartKey) return acc;
  }
  // Reaching here means we hit the safety cap. Log and return what we
  // have; the dashboard is best-effort and partial data is more useful
  // than a 500.
  console.warn(
    `governance/stats: queryAllForStatus(${status}) hit 50-page safety cap`,
  );
  return acc;
}

/**
 * Pure aggregator — given the full set of rows (drained from all four
 * status partitions), compute the response payload. Exported for
 * testability; the handler wires it together with the per-status fan-out.
 */
export function aggregateStats(items: GovernanceActionItem[]): GovernanceStats {
  let total = 0;
  const byStatus: Record<string, number> = {};
  const byType: Record<string, number> = {};
  const byMetadataSource: Record<string, number> = {};
  let treasuryWithdrawnLovelace = 0n;
  let earliest: string | undefined;
  let latest: string | undefined;

  for (const item of items) {
    total += 1;

    const status = typeof item.status === 'string' ? item.status : undefined;
    if (status) {
      byStatus[status] = (byStatus[status] ?? 0) + 1;
    }

    const actionType = typeof item.actionType === 'string' ? item.actionType : undefined;
    if (actionType) {
      byType[actionType] = (byType[actionType] ?? 0) + 1;
    }

    // Coverage bucket. Older rows without a `metadataSource` stamp (synced
    // before enrichmentVersion 5) collapse into a `legacy` bucket rather
    // than `none` — they may have valid body fields, just no source tag.
    const metadataSource =
      typeof item.metadataSource === 'string' && item.metadataSource.length > 0
        ? item.metadataSource
        : 'legacy';
    byMetadataSource[metadataSource] = (byMetadataSource[metadataSource] ?? 0) + 1;

    // Treasury sum: include ONLY enacted TreasuryWithdrawals. Active
    // withdrawals haven't been ratified, dropped/expired ones never will
    // be — counting any of those would lie about realized treasury spend.
    if (
      status === 'enacted' &&
      actionType === 'TreasuryWithdrawals' &&
      typeof item.treasuryWithdrawalLovelace === 'string'
    ) {
      try {
        treasuryWithdrawnLovelace += BigInt(item.treasuryWithdrawalLovelace);
      } catch {
        // Malformed value on a single row shouldn't break the aggregation —
        // log and skip.
        console.warn(
          'governance/stats: unparseable treasuryWithdrawalLovelace on',
          item.actionId,
        );
      }
    }

    const submittedAt =
      typeof item.submittedAt === 'string' && !item.submittedAt.startsWith('1970-01-01')
        ? item.submittedAt
        : undefined;
    if (submittedAt) {
      // ISO-8601 strings sort lexicographically as chronological order
      // (provided Z-suffixed UTC, which our sync emits). No Date parse needed.
      if (!earliest || submittedAt < earliest) earliest = submittedAt;
      if (!latest || submittedAt > latest) latest = submittedAt;
    }
  }

  return {
    total,
    byStatus,
    byType,
    byMetadataSource,
    treasuryWithdrawnLovelace: treasuryWithdrawnLovelace.toString(),
    earliestSubmittedAt: earliest,
    latestSubmittedAt: latest,
  };
}

async function computeStats(): Promise<GovernanceStats> {
  // Fan out one Query per status, in parallel. The GSI projection is ALL,
  // so each row arrives with every attribute we need to aggregate —
  // matching the projection the previous Scan path used (status,
  // actionType, submittedAt, treasuryWithdrawalLovelace, metadataSource)
  // and then some.
  const perStatusItems = await Promise.all(
    STATUSES.map((status) => queryAllForStatus(status)),
  );
  // Flatten in declaration order for deterministic test fixtures. Order
  // doesn't affect the aggregated counts or sums.
  const allItems = perStatusItems.flat();
  return aggregateStats(allItems);
}

export const handler = async (
  _event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  // CloudFront in front of the API caches this response for 60s on the
  // shared edge. The Lambda-level cache (60s) is still useful — it absorbs
  // bursts during a CloudFront miss/cold-edge.
  const cacheHeaders = {
    'Cache-Control': 'public, max-age=60, s-maxage=60',
  };

  try {
    const now = Date.now();
    if (cache && cache.expiresAt > now) {
      return ok(cache.payload, cacheHeaders);
    }

    const payload = await computeStats();
    cache = { payload, expiresAt: now + CACHE_TTL_MS };
    return ok(payload, cacheHeaders);
  } catch (err) {
    console.error('governance/stats handler error:', err);
    return internalError('Failed to compute governance stats');
  }
};

// Exported for tests — allows the test suite to reset the cache between
// test cases without resorting to module-state reflection.
export function __resetStatsCacheForTests(): void {
  cache = null;
}
