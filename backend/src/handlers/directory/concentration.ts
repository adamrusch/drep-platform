/**
 * GET /dreps/concentration — voting-power concentration donut data.
 *
 * Returns the donut view computed from the `drep_directory` PROFILE rows
 * plus the live DVT thresholds snapshot persisted by the directory sync.
 * The math itself is pure (see `lib/dreps/concentration.ts`) — this
 * handler is just the I/O glue:
 *
 *   1. Query every PROFILE row through the sparse
 *      `entityType-votingPower-index` GSI (same access path the list
 *      handler uses). Predefined DReps (Abstain / NoConfidence) are
 *      DELIBERATELY EXCLUDED from the concentration math: they hold ~9B
 *      ADA but they're protocol primitives, not registered DReps, so
 *      counting them would make every coalition trivially include them
 *      first and the donut would convey nothing.
 *   2. Read the persisted DVT thresholds row from `platform_state`
 *      (written by the directory sync). Each fractional `dvt_*` becomes
 *      an integer percent (0..100) and threshold-percent collisions are
 *      coalesced so the donut UI shows one marker that lists every
 *      action gated at that percent (e.g. 67% gates Treasury Withdrawal
 *      AND Hard Fork on mainnet today). Absent threshold fields are
 *      simply skipped.
 *   3. Compute the concentration view and respond.
 *
 * Failure modes:
 *   - DVT thresholds unavailable (sync hasn't run, or the row was reaped):
 *     the donut still renders, with no markers and `defaultThresholdPct`
 *     falling back to 67. The frontend tolerates this.
 *   - PROFILE Query fails: return 500 — without DReps the donut is
 *     meaningless.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { batchGetItems, queryItems, tableNames } from '../../lib/dynamodb';
import { computeConcentration, type Concentration } from '../../lib/dreps/concentration';
import type {
  DRepDirectoryItem,
  PlatformDrepDvtThresholdsItem,
} from '../../lib/types';
import { ok, internalError } from '../_response';

/** Default threshold for the donut when the persisted snapshot is missing
 *  or has no recognizable markers. 67% is the most common DRep threshold
 *  on mainnet (Treasury Withdrawal, Hard Fork, …) so it's the right
 *  "show me something useful" default. */
const DEFAULT_THRESHOLD_PCT = 67;

/** Same GSI the list handler uses — see `directory/list.ts` for the full
 *  rationale. The sparse GSI returns exactly the PROFILE rows, regardless
 *  of how many POWER history sub-rows live under the same partitions. */
const ENTITY_TYPE_GSI_NAME = 'entityType-votingPower-index';
const ENTITY_TYPE_PROFILE = 'DREP_PROFILE';
const MAX_QUERY_ROUNDS = 10;

/** Module-level response cache. Same shape as the list handler — the
 *  donut data shifts only on the sync cycle (every 30 min), so 30s is a
 *  comfortable TTL and matches the Cache-Control we emit. */
interface CachedConcentrationEntry {
  body: ConcentrationResponseBody;
  expiresAt: number;
}
interface ThresholdMarker {
  pct: number;
  actions: string[];
}
interface ConcentrationResponseBody {
  concentration: Concentration;
  markers: ThresholdMarker[];
  defaultThresholdPct: number;
  /** ISO-8601 of when the DVT snapshot was captured. Null when the
   *  thresholds row is missing — the frontend shows no "as of" line. */
  thresholdsAsOf: string | null;
}
const _concentrationCache = new Map<string, CachedConcentrationEntry>();
const CACHE_TTL_MS = 30_000;
const CACHE_KEY = 'singleton';

/** Test-only escape hatch matching the list handler's
 *  `_resetListCache`. Lets unit tests clear the in-memory cache between
 *  cases so a prior response doesn't short-circuit the next mock. */
export function _resetConcentrationCache(): void {
  _concentrationCache.clear();
}

/** PK on the platform_state table for the persisted DVT thresholds. Kept
 *  inline here (rather than importing from the sync) so this handler has
 *  no dependency on the sync module — symmetric with the safety-mode
 *  handler / lib pattern. */
const DREP_DVT_THRESHOLDS_STATE_KEY = 'DREP_DVT_THRESHOLDS';

/** Human-friendly action labels for each persisted DVT field. The donut
 *  surfaces these in the marker tooltip so the user sees "67% gates
 *  Treasury Withdrawal, Hard Fork" instead of bare numbers. */
const DVT_ACTION_LABELS: Record<string, string> = {
  dvt_motion_no_confidence: 'No-confidence motion',
  dvt_committee_normal: 'Update committee (normal)',
  dvt_committee_no_confidence: 'Update committee (no-confidence)',
  dvt_update_to_constitution: 'Update to constitution',
  dvt_hard_fork_initiation: 'Hard fork',
  dvt_p_p_network_group: 'Protocol params (network)',
  dvt_p_p_economic_group: 'Protocol params (economic)',
  dvt_p_p_technical_group: 'Protocol params (technical)',
  dvt_p_p_gov_group: 'Protocol params (governance)',
  dvt_treasury_withdrawal: 'Treasury withdrawal',
};

/** Build the marker list from a persisted thresholds row. Threshold percents
 *  that share a value across multiple action types are coalesced into ONE
 *  marker whose `actions[]` lists every action gated at that percent — the
 *  donut UI then renders a single marker tooltip "67% gates X, Y" rather
 *  than two stacked markers at the same position. */
export function buildMarkersFromThresholds(
  row: PlatformDrepDvtThresholdsItem | undefined,
): ThresholdMarker[] {
  if (!row) return [];
  const byPct = new Map<number, string[]>();
  for (const [field, label] of Object.entries(DVT_ACTION_LABELS)) {
    const raw = (row as Record<string, unknown>)[field];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    // Each dvt_* field is fractional in [0, 1]; convert to integer percent.
    const pct = Math.round(raw * 100);
    if (pct < 0 || pct > 100) continue;
    const existing = byPct.get(pct);
    if (existing) existing.push(label);
    else byPct.set(pct, [label]);
  }
  return Array.from(byPct.entries())
    .map(([pct, actions]) => ({ pct, actions }))
    .sort((a, b) => a.pct - b.pct);
}

/** Pick the default threshold the donut snaps to on first render. Prefer the
 *  highest persisted threshold ≤ 67% (the most common one on mainnet) so
 *  the donut lands on a meaningful position; fall back to 67 when no
 *  thresholds were persisted at all. */
export function pickDefaultThresholdPct(markers: ThresholdMarker[]): number {
  if (markers.length === 0) return DEFAULT_THRESHOLD_PCT;
  const sixtySeven = markers.find((m) => m.pct === 67);
  if (sixtySeven) return 67;
  // Otherwise prefer the highest threshold not exceeding 67 (so we don't
  // jump to a 75% slice and crop most of the ring on first render).
  const atOrBelow = markers.filter((m) => m.pct <= DEFAULT_THRESHOLD_PCT);
  if (atOrBelow.length > 0) return atOrBelow[atOrBelow.length - 1]!.pct;
  // All markers above 67 — return the lowest so the user starts at the
  // tightest coalition the protocol cares about.
  return markers[0]!.pct;
}

/** Query every PROFILE row through the sparse GSI — same pattern as the
 *  list handler. Returns the full set; the concentration math sorts. */
async function queryAllProfiles(): Promise<DRepDirectoryItem[]> {
  const accumulated: DRepDirectoryItem[] = [];
  let cursor: Record<string, unknown> | undefined;
  for (let round = 0; round < MAX_QUERY_ROUNDS; round++) {
    const page = await queryItems<DRepDirectoryItem>(tableNames.drepDirectory, {
      indexName: ENTITY_TYPE_GSI_NAME,
      keyConditionExpression: '#et = :entityType',
      expressionAttributeNames: { '#et': 'entityType' },
      expressionAttributeValues: { ':entityType': ENTITY_TYPE_PROFILE },
      ...(cursor ? { exclusiveStartKey: cursor } : {}),
    });
    accumulated.push(...page.items);
    if (!page.lastEvaluatedKey) break;
    cursor = page.lastEvaluatedKey;
  }
  return accumulated;
}

export const handler = async (
  _event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  // Same Cache-Control as the list handler so CloudFront can cache.
  const cacheHeaders = { 'Cache-Control': 'public, max-age=30, s-maxage=30' };
  try {
    const now = Date.now();
    const cached = _concentrationCache.get(CACHE_KEY);
    if (cached && cached.expiresAt > now) {
      return ok(cached.body, cacheHeaders);
    }

    // Read the persisted DVT thresholds row and the full PROFILE set in
    // parallel — they don't depend on each other and the threshold read is
    // a single GetItem so the wall-clock saving is tiny but free.
    const [profiles, thresholdsRows] = await Promise.all([
      queryAllProfiles(),
      batchGetItems<PlatformDrepDvtThresholdsItem>(tableNames.platformState, [
        { stateKey: DREP_DVT_THRESHOLDS_STATE_KEY },
      ]),
    ]);
    const thresholds = thresholdsRows[0];

    // Exclude predefined DReps from the concentration math. They hold ~9B
    // ADA between them but are protocol primitives (Abstain / NoConfidence
    // aren't registered DReps), so counting them would make every coalition
    // trivially include them first and the donut would convey nothing
    // about the long-tail concentration the user actually cares about.
    // Retired DReps already carry `votingPower='0'` (set by the sync) so
    // they contribute nothing to the math — no extra filter needed.
    const eligible = profiles
      .filter((p) => !p.isPredefined)
      .map((p) => {
        let power: bigint;
        try {
          power = BigInt(p.votingPower);
        } catch {
          power = 0n;
        }
        return {
          drepId: p.drepId,
          name:
            typeof p.givenName === 'string' && p.givenName.trim().length > 0
              ? p.givenName
              : null,
          power,
        };
      });

    const concentration = computeConcentration(eligible);
    const markers = buildMarkersFromThresholds(thresholds);
    const defaultThresholdPct = pickDefaultThresholdPct(markers);
    const thresholdsAsOf = thresholds?.capturedAt ?? null;

    const body: ConcentrationResponseBody = {
      concentration,
      markers,
      defaultThresholdPct,
      thresholdsAsOf,
    };

    _concentrationCache.set(CACHE_KEY, { body, expiresAt: now + CACHE_TTL_MS });
    return ok(body, cacheHeaders);
  } catch (err) {
    console.error('directory/concentration handler error:', err);
    return internalError('Failed to compute DRep voting power concentration');
  }
};
