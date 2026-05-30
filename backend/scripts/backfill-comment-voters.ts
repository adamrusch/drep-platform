#!/usr/bin/env npx tsx
/**
 * One-shot backfill: seed `comment_voters` registry from every distinct
 * voting wallet already present in `comment_votes` (Batch REVAL,
 * 2026-05-29).
 *
 * # Why this script exists
 *
 * The 3-hourly stake re-validation sweep enumerates voters from the
 * `comment_voters` registry. The live vote-write paths (vote handler +
 * create handler seed-upvote) maintain the registry going forward, but
 * any historical votes that existed before THIS PR shipped need to be
 * seeded so the first sweep picks them up.
 *
 * Today's prod has zero historical votes, so this script is effectively
 * a no-op. Dev / staging may have test votes that DO need seeding;
 * future prod (if this PR ever ships against a populated table) will
 * also.
 *
 * # Idempotency
 *
 * Conditional `PutItem` with `attribute_not_exists(stakeAddress)`. A
 * second run of the script after a successful first run hits the
 * condition and skips every existing registry row — counter values
 * are preserved, no double-counting. A registry row created by the
 * live write path AFTER the backfill scan but BEFORE the backfill Put
 * also gets the same conditional skip (live row wins).
 *
 * # Usage
 *
 *   AWS_PROFILE=drep-platform AWS_REGION=us-east-1 STAGE=dev \
 *     npx tsx backend/scripts/backfill-comment-voters.ts --dry-run
 *
 *   AWS_PROFILE=drep-platform AWS_REGION=us-east-1 STAGE=dev \
 *     npx tsx backend/scripts/backfill-comment-voters.ts
 *
 * # Architecture
 *
 * Implementation lives in `src/lib/backfill-comment-voters.ts` so the
 * test suite under `src/sync/*.idempotency.test.ts` can import the
 * helpers directly (tsconfig.json's `rootDir=src` excludes the
 * `scripts/` directory). This file is the thin CLI wrapper.
 */

import { runBackfillCommentVoters } from '../src/lib/backfill-comment-voters';

const DRY_RUN = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  const counters = await runBackfillCommentVoters({ dryRun: DRY_RUN });
  console.log('backfill-comment-voters: done');
  console.log(`  voteRowsScanned   = ${counters.voteRowsScanned}`);
  console.log(`  distinctVoters    = ${counters.distinctVoters}`);
  console.log(
    `  registryWritten   = ${counters.registryWritten}` +
      (DRY_RUN ? ' (DRY-RUN — no writes issued)' : ''),
  );
  console.log(`  registrySkipped   = ${counters.registrySkipped}`);
  console.log(`  errors            = ${counters.errors}`);
  if (counters.errors > 0) {
    console.error(
      'backfill-comment-voters: completed with errors — re-run later to retry (idempotent)',
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('backfill-comment-voters: fatal error:', err);
  process.exit(2);
});
