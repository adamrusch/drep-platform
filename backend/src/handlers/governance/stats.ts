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
 *     treasuryWithdrawnLovelace: "1234567890123456",  // stringified BigInt
 *     earliestSubmittedAt: "2024-09-01T...",
 *     latestSubmittedAt:   "2026-05-01T..."
 *   }
 *
 * Implementation: a Scan over `governance_actions`. The full table is ~109
 * rows today and grows on the order of dozens per epoch — well within Scan
 * cost tolerance. We project only the columns we need (`status`, `actionType`,
 * `submittedAt`, `treasuryWithdrawalLovelace`) so the wire size stays small.
 *
 * Caching: a 60-second in-memory cache keyed on the Lambda warm container.
 * Stats don't change minute-to-minute, and a 1-minute TTL aligns with the
 * governance-intake cadence — the "live count" the UI surfaces is at worst
 * one sync cycle stale, which the user accepts implicitly when the data is
 * advertised as "synced from Cardano mainnet". The cache is per-container,
 * so under heavy fan-out a fresh container will recompute on its first hit;
 * that's fine — Scan over 109 items is tens of milliseconds.
 *
 * The handler is read-only and unauthenticated, matching `/governance` (the
 * paginated list) which is also public.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { scanItems, tableNames } from '../../lib/dynamodb';
import type { GovernanceActionItem } from '../../lib/types';
import { ok, internalError } from '../_response';

interface GovernanceStats {
  /** Total number of governance actions ever stored. */
  total: number;
  /** Counts bucketed by lifecycle status. Any unknown statuses are dropped
   *  rather than silently rolled into a bucket — keeps the sum honest. */
  byStatus: Record<string, number>;
  /** Counts bucketed by `actionType`. Same dropping rule as `byStatus`. */
  byType: Record<string, number>;
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

async function computeStats(): Promise<GovernanceStats> {
  // Scan with projection: pull only the fields we aggregate on. `status` is
  // a reserved word in DynamoDB (clashes with the older STATUS_PARTITION
  // marker on a different table), so it has to be projected via an attribute
  // name placeholder. Same for `submittedAt` to keep the codepath uniform.
  let exclusiveStartKey: Record<string, unknown> | undefined;
  let total = 0;
  const byStatus: Record<string, number> = {};
  const byType: Record<string, number> = {};
  let treasuryWithdrawnLovelace = 0n;
  let earliest: string | undefined;
  let latest: string | undefined;

  // Scan loop — DynamoDB Scans page at 1MB; we drain to the end. With ~109
  // small rows, one page is enough today, but the loop guards against future
  // growth and segmented-scan rebalancing.
  do {
    const result = await scanItems<GovernanceActionItem>(tableNames.governanceActions, {
      projectionExpression:
        '#status, actionType, submittedAt, treasuryWithdrawalLovelace',
      expressionAttributeNames: { '#status': 'status' },
      ...(exclusiveStartKey ? { exclusiveStartKey } : {}),
    });

    for (const item of result.items) {
      total += 1;

      const status = typeof item.status === 'string' ? item.status : undefined;
      if (status) {
        byStatus[status] = (byStatus[status] ?? 0) + 1;
      }

      const actionType = typeof item.actionType === 'string' ? item.actionType : undefined;
      if (actionType) {
        byType[actionType] = (byType[actionType] ?? 0) + 1;
      }

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

    exclusiveStartKey = result.lastEvaluatedKey;
  } while (exclusiveStartKey);

  return {
    total,
    byStatus,
    byType,
    treasuryWithdrawnLovelace: treasuryWithdrawnLovelace.toString(),
    earliestSubmittedAt: earliest,
    latestSubmittedAt: latest,
  };
}

export const handler = async (
  _event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const now = Date.now();
    if (cache && cache.expiresAt > now) {
      return ok(cache.payload);
    }

    const payload = await computeStats();
    cache = { payload, expiresAt: now + CACHE_TTL_MS };
    return ok(payload);
  } catch (err) {
    console.error('governance/stats handler error:', err);
    return internalError('Failed to compute governance stats');
  }
};
