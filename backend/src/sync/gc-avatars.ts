/**
 * Daily avatar GC sweep (Sprint 5 follow-up, 2026-06-10).
 *
 * # The gap this closes
 *
 * Sprint 5 introduced the content-addressed DRep avatar pipeline:
 * `storeDrepAvatars` downloads each DRep's CIP-119 image once and stores
 * it in S3 keyed by `avatars/<sha256-of-bytes>`. As DReps rotate their
 * avatars (or de-link them altogether) the prior S3 objects become
 * unreferenced — no PROFILE row carries their hash anymore. Without a
 * sweep those orphans accumulate forever.
 *
 * `gcDrepAvatars` (in `lib/dreps/avatarStore.ts`) already implements the
 * delete logic — it walks the bucket inventory, intersects with the
 * referenced-hash set from the DDB PROFILE rows, and removes objects
 * older than the 24h grace window. It was unit-tested but never
 * scheduled. This file is the EventBridge Lambda entrypoint that fires
 * it daily.
 *
 * # Cadence
 *
 * Daily. Avatar churn moves at the DRep registration / metadata cadence
 * (~dozens of changes per day across mainnet's ~1600 DReps), so a 24h
 * granularity comfortably keeps the bucket bounded without burning S3
 * Delete calls every hour. 04:00 UTC chosen to slot AFTER the daily
 * 02:00 / 02:30 / 03:00 Koios passes — the bucket-list call does not
 * compete with the Koios RPS budget, but spacing keeps CloudWatch alarm
 * windows distinguishable per-Lambda.
 *
 * # Cost
 *
 * One `ListObjectsV2` walk (paginated, ~1500 objects steady-state →
 * single page) + a DDB `Query` per PROFILE-page to build the referenced
 * set + one `DeleteObjects` batch (capped at 200 deletions/run by the
 * `gcDrepAvatars` `deleteLimit` parameter, which the backlog drains
 * over). At steady state the deletion count is single-digit/day; cost
 * is pennies/month.
 *
 * # Failure modes
 *
 * Hard top-level errors return an empty result; the EventBridge target
 * ignores the body but the Lambda `Errors` metric → CloudWatch alarm
 * picks up real failures. Best-effort structured end-of-pass log line
 * mirrors `revalidate-onchain-roles.ts`'s style.
 *
 * # Silently disabled without AVATAR_S3_BUCKET
 *
 * Same convention as `drep-directory.ts`'s avatar-store pass: if the
 * env var isn't set (a stage that hasn't deployed the bucket yet) the
 * sweep no-ops cleanly. Lets the infra stack roll out without a
 * deploy-order hazard.
 */
import type { ScheduledEvent, Context } from 'aws-lambda';
import { gcDrepAvatars, s3AvatarBucket } from '../lib/dreps/avatarStore';

export interface GcAvatarsResult {
  /** Objects walked in this pass — the full `avatars/` inventory. */
  scanned: number;
  /** Objects deleted (orphaned past the 24h grace window). */
  deleted: number;
  /** `true` when AVATAR_S3_BUCKET was unset and the sweep no-opped. */
  skipped: boolean;
}

function emptyResult(skipped = false): GcAvatarsResult {
  return { scanned: 0, deleted: 0, skipped };
}

/**
 * Run one GC pass.
 *
 * Exported for unit-testing the wiring layer without going through the
 * Lambda `handler` envelope. The default `nowMs` is `Date.now()` —
 * tests pass an explicit value to control the grace-window decision.
 */
export async function runGcAvatars(nowMs: number = Date.now()): Promise<GcAvatarsResult> {
  const bucketName = process.env['AVATAR_S3_BUCKET'];
  if (!bucketName) {
    console.log('gc-avatars: AVATAR_S3_BUCKET unset; sweep skipped');
    return emptyResult(true);
  }
  try {
    const bucket = s3AvatarBucket(bucketName);
    const r = await gcDrepAvatars({ bucket, nowMs });
    console.log(
      `gc-avatars: pass complete — scanned=${r.scanned} deleted=${r.deleted}`,
    );
    return { scanned: r.scanned, deleted: r.deleted, skipped: false };
  } catch (err) {
    // Let the Lambda error metric surface this — re-throw so EventBridge
    // sees the failure and the `Errors > 0` CloudWatch alarm fires.
    console.error(
      'gc-avatars: pass failed:',
      err instanceof Error ? err.message : err,
    );
    throw err;
  }
}

export const handler = async (
  _event: ScheduledEvent,
  _context: Context,
): Promise<GcAvatarsResult> => {
  return runGcAvatars();
};
