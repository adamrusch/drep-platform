/**
 * DRep voting power history sync — populates per-DRep epoch-by-epoch
 * voting-power snapshots into the `drep_directory` table under
 * `SK='POWER#${epochNo zero-padded}'` rows.
 *
 * # Why this sync exists
 *
 * The directory detail page renders a sparkline of each DRep's voting
 * power over time. Without this sync the sparkline showed a placeholder.
 * Koios `/drep_voting_power_history` exposes one row per epoch a DRep
 * has been registered in, with the snapshot power they held at the
 * epoch boundary — exactly what the chart wants.
 *
 * # Cadence
 *
 * Daily. Voting-power snapshots only update at epoch boundaries (~every
 * 5 days on mainnet), so 24-hour cadence is more than enough — the
 * sparkline will update within at most one day of the new epoch starting.
 *
 * # Cost
 *
 * One Koios call per active DRep per day. ~1500 active DReps × 1 =
 * 1500 calls/day, well under Koios's anonymous-tier 10 RPS limit (we
 * insert a small sleep to spread the burst over ~5 min).
 *
 * Per-row storage: each DRep accumulates ~73 rows/year (one per epoch).
 * After 1 year on mainnet's ~1500 DReps that's ~110k items × ~200B =
 * ~22MB. After 5 years: ~110MB. Well within DynamoDB partition limits
 * (10GB per item-collection); each DRep's history lives under its own
 * partition (`drepId`) so no hot-partition risk.
 *
 * # Idempotency
 *
 * Per-epoch rows use conditional Put on `attribute_not_exists(SK)`. A
 * historical epoch's snapshot is monotonic: once written, it never
 * changes (the underlying ledger state is immutable). On every cycle
 * we re-issue conditional Puts for the full history of every DRep; the
 * vast majority are no-op skips. The cost of a skip is 1 WCU each;
 * 1500 DReps × ~73 rows = ~110k WCU/day = ~$0.14/day. Cheap.
 *
 * # Failure modes
 *
 * Per-DRep failure is isolated — one DRep's Koios call failing does
 * not abort the rest. Total-cycle errors are reported via the result
 * object but the EventBridge target ignores them; the next day's cycle
 * picks up what was missed.
 *
 * # New row shape
 *
 * | Field          | Type | Role                                                 |
 * |----------------|------|------------------------------------------------------|
 * | `drepId`       | S    | PK — same as the `PROFILE` row                       |
 * | `SK`           | S    | `POWER#${zero-padded epoch_no}` (e.g. `POWER#000515`) |
 * | `epochNo`      | N    | Epoch this snapshot represents                       |
 * | `amount`       | S    | Voting power in lovelace, stringified BigInt         |
 * | `capturedAt`   | S    | ISO-8601 of the sync run that wrote this row         |
 *
 * # Future work (documented as backlog, not in scope this sprint)
 *
 * Frontend wiring: the directory detail handler (`directory/get.ts`)
 * should fetch `POWER#`-prefixed items alongside the `PROFILE` row and
 * expose them on the response as `votingPowerHistory`. The frontend
 * Sparkline component reads that field. This is a small follow-up PR;
 * the sync alone is harmless without it.
 */

import type { ScheduledEvent, Context } from 'aws-lambda';
import {
  listAllDReps,
  fetchDRepPowerHistory,
  KoiosError,
} from '../lib/koios';
import { putItemIfAbsent, tableNames } from '../lib/dynamodb';

export interface PowerHistorySyncResult {
  totalDReps: number;
  rowsWritten: number;
  rowsSkipped: number;
  rowsErrored: number;
  drepsErrored: number;
}

/** Epoch number zero-pad width. Mainnet is at epoch ~515 today; 6 digits
 *  covers all of history past + the next ~1000 years of epochs. */
const EPOCH_PAD = 6;

/** Concurrent in-flight Koios calls. Stays comfortably under the
 *  anonymous-tier ~10 RPS cap while still finishing ~1500 DReps in
 *  ~5 min of wall-clock (vs >10 min for a sequential walk).
 *
 *  Tried sequential with 200ms sleep between calls first; that was
 *  600+s wall-clock on 1021 DReps and hit the Lambda 10-min timeout.
 *  Concurrency-based pacing is both faster and more bandwidth-efficient
 *  because we're not idle-sleeping between calls. */
const POWER_CONCURRENCY = 5;

/** Predefined DReps — same set the directory sync filters out. */
const PREDEFINED_DREP_IDS = new Set<string>([
  'drep_always_abstain',
  'drep_always_no_confidence',
]);

function padEpoch(n: number): string {
  const s = String(n);
  return s.length >= EPOCH_PAD ? s : '0'.repeat(EPOCH_PAD - s.length) + s;
}

export async function runPowerHistorySync(): Promise<PowerHistorySyncResult> {
  const result: PowerHistorySyncResult = {
    totalDReps: 0,
    rowsWritten: 0,
    rowsSkipped: 0,
    rowsErrored: 0,
    drepsErrored: 0,
  };

  let listing;
  try {
    listing = await listAllDReps();
  } catch (err) {
    if (err instanceof KoiosError) {
      console.warn('Power-history sync: drep_list unavailable; aborting cycle', err.message);
    } else {
      console.error('Power-history sync: drep_list threw:', err);
    }
    result.drepsErrored = 1;
    return result;
  }

  // Only currently-registered DReps. Retired DReps have a frozen history
  // and we already captured everything they had — no point re-fetching
  // them every day. We still keep their previously-written rows; they
  // just stop accumulating new entries.
  const activeIds = listing
    .filter((d) => d.registered && !PREDEFINED_DREP_IDS.has(d.drep_id))
    .map((d) => d.drep_id);

  result.totalDReps = activeIds.length;
  if (activeIds.length === 0) {
    console.log('Power-history sync: no active DReps; nothing to do');
    return result;
  }

  console.log(`Power-history sync: fetching history for ${activeIds.length} DReps`);
  const capturedAt = new Date().toISOString();

  // Concurrency-based pacing — five lanes each pulling DReps from a
  // shared cursor. Each lane completes one Koios call + a small
  // DynamoDB write burst before pulling the next ID, naturally rate-
  // limiting at ~5 simultaneous in-flight Koios connections without
  // idle sleeps. Per-DRep failures are isolated.
  let cursor = 0;
  const lane = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= activeIds.length) return;
      const drepId = activeIds[i]!;
      const rows = await fetchDRepPowerHistory(drepId);
      if (rows === null) {
        result.drepsErrored++;
        continue;
      }
      if (rows.length === 0) continue;
      // Write each (epoch, amount) row. Conditional Put on
      // attribute_not_exists(SK) means we only pay WCU for genuinely new
      // rows; re-attempted snapshots return "skipped" at 1 WCU each.
      for (const row of rows) {
        if (typeof row.epoch_no !== 'number' || !Number.isFinite(row.epoch_no)) continue;
        if (typeof row.amount !== 'string' || row.amount.length === 0) continue;
        try {
          BigInt(row.amount);
        } catch {
          continue;
        }
        const item = {
          drepId,
          SK: `POWER#${padEpoch(row.epoch_no)}`,
          epochNo: row.epoch_no,
          amount: row.amount,
          capturedAt,
        };
        const putResult = await putItemIfAbsent(tableNames.drepDirectory, item, {
          partitionKey: 'drepId',
          sortKey: 'SK',
        });
        if (putResult.outcome === 'written') {
          result.rowsWritten++;
        } else if (putResult.outcome === 'skipped') {
          result.rowsSkipped++;
        } else {
          result.rowsErrored++;
          if (putResult.error) {
            console.warn(`Power-history sync: put failed for ${drepId}@${row.epoch_no}:`, putResult.error);
          }
        }
      }
    }
  };
  await Promise.all(Array.from({ length: POWER_CONCURRENCY }, () => lane()));

  console.log(
    `Power-history sync complete: dreps=${result.totalDReps} ` +
      `rowsWritten=${result.rowsWritten} rowsSkipped=${result.rowsSkipped} ` +
      `rowsErrored=${result.rowsErrored} drepsErrored=${result.drepsErrored}`,
  );
  return result;
}

/**
 * EventBridge scheduled handler. Cadence owned by SchedulerStack — daily
 * (one cycle every 24 hours). See file header for the rationale.
 */
export const handler = async (
  _event: ScheduledEvent,
  _context: Context,
): Promise<PowerHistorySyncResult> => {
  return runPowerHistorySync();
};
