#!/usr/bin/env npx tsx
/**
 * One-shot backfill: seed `supportLovelace` + author upvote rows on
 * legacy comments that pre-date the stake-weighted comment voting
 * feature (PR #1, Batch A path; the seed-vote logic in
 * `handlers/comments/create.ts` was introduced AFTER those comments
 * landed).
 *
 * # The problem this fixes
 *
 * `comments` created BEFORE the create handler started writing a
 * `supportLovelace` snapshot + a paired `comment_votes` author seed
 * row carry no support level: the UI renders `supportLovelace: 0`
 * and `upvoteCount: 0` until someone manually upvotes them. New
 * users browsing old threads see "0" against established comments
 * by recognized contributors, which is misleading.
 *
 * Fix: walk every `comments` row that lacks `supportLovelace` (or
 * has `supportLovelace = '0'`), look up the author's stake on
 * Koios + Blockfrost fallback, and write the seed upvote row +
 * counter mutation that the live create handler would have
 * written at the time. Same shape as
 * `handlers/comments/create.ts` lines 130-180.
 *
 * # Idempotency
 *
 * The Put against `comment_votes` is conditional on
 * `attribute_not_exists(commentId)`, so a re-run that hits an
 * already-seeded comment is a no-op. The counter update is paired
 * inside a `transactWrite` with that ConditionCheck — if the seed
 * exists already, neither write fires. Safe to re-run any number
 * of times.
 *
 * # Not auto-run
 *
 * Manual only. Do NOT add this to any CI/CD pipeline. The script
 * makes one Koios call per affected comment author (subject to the
 * 60s in-Lambda cache for repeated authors), which is fine for a
 * one-shot but would compound poorly under repeated automated runs.
 *
 * # Usage
 *
 *   AWS_REGION=us-east-1 \
 *     DYNAMODB_TABLE_PREFIX=drep-platform-dev- \
 *     npx tsx backend/scripts/backfill-legacy-comment-seeds.ts
 *
 * Progress is logged every 100 rows processed:
 *
 *   {seeded, skipped, errors}  — seeded = wrote a fresh seed,
 *                                 skipped = idempotent re-run hit,
 *                                 errors = Koios + DDB combined.
 *
 * # Architecture
 *
 * The implementation lives in `src/lib/backfill-legacy-comment-seeds.ts`
 * so it can be imported by the test suite (which is restricted by
 * `tsconfig.json:rootDir=src`). This file is a thin CLI wrapper
 * that invokes the library function and pretty-prints the totals.
 */

import { runBackfillLegacyCommentSeeds } from '../src/lib/backfill-legacy-comment-seeds';

async function main(): Promise<void> {
  const counters = await runBackfillLegacyCommentSeeds();
  console.log('backfill-legacy-comment-seeds: done');
  console.log(`  totalScanned      = ${counters.totalScanned}`);
  console.log(`  candidates        = ${counters.candidates}`);
  console.log(`  seeded            = ${counters.seeded}`);
  console.log(`  skipped           = ${counters.skipped}`);
  console.log(`  errors            = ${counters.errors}`);
  console.log(`  upstreamFailures  = ${counters.upstreamFailures}`);
  if (counters.errors > 0) {
    console.error(
      'backfill-legacy-comment-seeds: completed with errors — re-run later to retry failed rows (script is idempotent)',
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('backfill-legacy-comment-seeds: fatal error:', err);
  process.exit(2);
});
