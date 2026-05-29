#!/usr/bin/env npx tsx
/**
 * P0-3 Phase 7 cleanup — REMOVE the residual inline `comments` attribute
 * from every `clubhouse_posts` row that still carries it.
 *
 * # Why this script exists
 *
 * Phase 6 (2026-05-28) stopped writing to the legacy inline
 * `comments[]` field on the post row — new comments live ONLY in the
 * `clubhouse_comments` table now. But existing post rows in production
 * still carry the (empty) attribute from the dual-write window. Phase 7
 * strips it.
 *
 * Production has ZERO historical comments (the clubhouse-comment
 * feature was never used pre-migration), so the inline arrays are
 * uniformly `[]`. This script is pure hygiene: it removes the
 * vestigial attribute so the row schema matches the post-Phase-6 type
 * (`comments?` instead of `comments`).
 *
 * # Idempotency
 *
 * Each row update is `UpdateExpression: 'REMOVE #c'` with
 * `ExpressionAttributeNames: {'#c': 'comments'}`. Re-running against a
 * row whose `comments` attribute is already gone is a no-op (DynamoDB
 * silently succeeds REMOVE of an absent attribute). Safe to re-run
 * any number of times.
 *
 * # Run-once, OWNER-DRIVEN
 *
 * This script is NOT auto-run. The owner invokes it manually post-
 * deploy after they've confirmed the Phase 6 ApiStack deploy is
 * healthy:
 *
 *   AWS_PROFILE=drep-platform AWS_REGION=us-east-1 STAGE=dev \
 *     npx tsx backend/scripts/cleanup-inline-comments.ts --dry-run
 *
 *   AWS_PROFILE=drep-platform AWS_REGION=us-east-1 STAGE=dev \
 *     npx tsx backend/scripts/cleanup-inline-comments.ts
 *
 * # What this script does NOT do
 *
 *   - Does not touch `clubhouse_comments` rows (those are the source
 *     of truth post-Phase-6).
 *   - Does not delete posts. Only REMOVEs one attribute per row.
 *   - Does not retry transient DDB errors aggressively — single attempt
 *     per write, errors are logged, re-run picks them up (idempotent).
 *
 * # Cost
 *
 * Per row: one UpdateItem (1 WRU). Production has ~7360 posts → ~7400
 * WRU one-shot → ~$0.01 on PAY_PER_REQUEST. Negligible.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
  type ScanCommandInput,
  type UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb';

const STAGE = process.env['STAGE'] ?? 'dev';
const TABLE_PREFIX = `drep-platform-${STAGE}-`;
const CLUBHOUSE_POSTS_TABLE =
  process.env['CLUBHOUSE_POSTS_TABLE'] ?? `${TABLE_PREFIX}clubhouse_posts`;
const REGION = process.env['AWS_REGION'] ?? 'us-east-1';

const DRY_RUN = process.argv.includes('--dry-run');

const rawClient = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(rawClient, {
  marshallOptions: { removeUndefinedValues: true, convertEmptyValues: false },
  unmarshallOptions: { wrapNumbers: false },
});

interface ClubhousePostRow {
  drepId: string;
  postId: string;
  comments?: unknown;
  [key: string]: unknown;
}

interface Counters {
  postsScanned: number;
  postsWithInlineAttribute: number;
  attributesRemoved: number;
  errored: number;
}

async function loadAllPosts(): Promise<ClubhousePostRow[]> {
  console.log(`cleanup-inline-comments: scanning ${CLUBHOUSE_POSTS_TABLE}`);
  const out: ClubhousePostRow[] = [];
  let lastKey: Record<string, unknown> | undefined;
  let pages = 0;
  do {
    const params: ScanCommandInput = {
      TableName: CLUBHOUSE_POSTS_TABLE,
      // Slim projection: we only need the keys + the comments attribute
      // (to know whether the row needs stripping). Skipping the body
      // / poll data / etc. keeps the scan cost low even on large tables.
      ProjectionExpression: '#drepId, #postId, #comments',
      ExpressionAttributeNames: {
        '#drepId': 'drepId',
        '#postId': 'postId',
        '#comments': 'comments',
      },
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    };
    const result = await docClient.send(new ScanCommand(params));
    out.push(...((result.Items ?? []) as ClubhousePostRow[]));
    lastKey = result.LastEvaluatedKey;
    pages++;
  } while (lastKey);
  console.log(
    `cleanup-inline-comments: scanned ${out.length} posts in ${pages} page(s)`,
  );
  return out;
}

async function removeInlineComments(
  drepId: string,
  postId: string,
): Promise<'removed' | 'errored'> {
  if (DRY_RUN) return 'removed';
  const update: UpdateCommandInput = {
    TableName: CLUBHOUSE_POSTS_TABLE,
    Key: { drepId, postId },
    UpdateExpression: 'REMOVE #c',
    ExpressionAttributeNames: { '#c': 'comments' },
  };
  try {
    await docClient.send(new UpdateCommand(update));
    return 'removed';
  } catch (err) {
    console.error(
      `cleanup-inline-comments: REMOVE failed drepId=${drepId} postId=${postId}:`,
      err,
    );
    return 'errored';
  }
}

async function main(): Promise<void> {
  console.log(
    `cleanup-inline-comments: stage=${STAGE} region=${REGION}` +
      (DRY_RUN ? ' DRY-RUN' : ''),
  );

  const posts = await loadAllPosts();
  const counters: Counters = {
    postsScanned: posts.length,
    postsWithInlineAttribute: 0,
    attributesRemoved: 0,
    errored: 0,
  };

  let processed = 0;
  for (const post of posts) {
    // Only act on rows that actually carry the attribute — re-runs hit
    // every row in the table, but only the ones that still have the
    // inline field actually need an UpdateItem. Skipping the others
    // avoids ~7000 no-op writes on the second pass.
    const stillHasInline = Object.prototype.hasOwnProperty.call(post, 'comments');
    if (stillHasInline) {
      counters.postsWithInlineAttribute++;
      const outcome = await removeInlineComments(post.drepId, post.postId);
      if (outcome === 'removed') counters.attributesRemoved++;
      else counters.errored++;
    }
    processed++;
    if (processed % 100 === 0) {
      console.log(
        `cleanup-inline-comments: ${processed}/${posts.length} posts processed ` +
          `(stripped=${counters.attributesRemoved}, errored=${counters.errored})`,
      );
    }
  }

  console.log('cleanup-inline-comments: done');
  console.log(`  postsScanned              = ${counters.postsScanned}`);
  console.log(`  postsWithInlineAttribute  = ${counters.postsWithInlineAttribute}`);
  console.log(
    `  attributesRemoved         = ${counters.attributesRemoved}` +
      (DRY_RUN ? ' (DRY-RUN — no writes issued)' : ''),
  );
  console.log(`  errored                   = ${counters.errored}`);

  if (counters.errored > 0) {
    console.error('cleanup-inline-comments: completed with errors — re-run to retry (idempotent)');
    process.exit(1);
  }
}

// Defer execution if imported (the idempotency tests import the module
// to inspect helpers without running the main loop).
if (process.env['VITEST'] !== 'true' && require.main === module) {
  main().catch((err) => {
    console.error('cleanup-inline-comments: fatal error:', err);
    process.exit(1);
  });
}
