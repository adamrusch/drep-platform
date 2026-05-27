/**
 * One-shot backfill for `pool_metadata` table.
 *
 * The daily sync `backend/src/sync/pool-metadata.ts` is already
 * idempotent — its first invocation populates every row. This script
 * exists to let an operator force-fill the table immediately after the
 * `pool_metadata` table lands in CDK, without waiting for the next
 * 03:00 UTC EventBridge tick.
 *
 * # Usage
 *
 *   AWS_REGION=us-east-1 \
 *     DYNAMODB_TABLE_PREFIX=drep-platform-dev- \
 *     npx tsx backend/scripts/backfill-pool-metadata.ts
 *
 * Safe to re-run: the underlying sync uses BatchGet + compare-then-
 * write, so a repeated invocation against a warm table writes zero
 * rows.
 *
 * # Why this is a thin wrapper
 *
 * `runPoolMetadataSync` does the full job — listing every pool,
 * fetching metadata in batches, writing differential rows. The CLI
 * just calls it and prints the result. Keeping the logic in the
 * sync module means the backfill behavior cannot drift from
 * production cycles.
 */

import { runPoolMetadataSync } from '../src/sync/pool-metadata';

async function main(): Promise<void> {
  console.log('Pool metadata backfill: starting');
  const result = await runPoolMetadataSync();
  console.log('Pool metadata backfill: done');
  console.log(JSON.stringify(result, null, 2));
  if (result.errors > 0) {
    console.warn(`Pool metadata backfill: ${result.errors} errors (see warnings above)`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Pool metadata backfill: fatal error', err);
  process.exit(2);
});
