#!/usr/bin/env npx tsx
/**
 * One-shot backfill for the P0-3 Clubhouse-comments de-inlining
 * migration (2026-05-28). Scans every row in `clubhouse_posts`, and
 * for each inline comment found on the row's `comments[]` array:
 *
 *   1. Writes a per-row copy to `clubhouse_comments` with a
 *      `ConditionExpression: attribute_not_exists(commentId)` so a
 *      re-run is idempotent — already-backfilled rows skip cleanly.
 *      `depth` is computed from the in-memory inline array (safe,
 *      offline) and persisted so the live `createComment` handler
 *      never has to recompute it.
 *
 *   2. Sets the denormalized `commentCount` counter on the post to
 *      `comments.length`. Also sets `lastReplyAt` to the maximum
 *      `createdAt` across the inline comments when one exists.
 *      Writes go through an `UpdateItem` so we don't clobber other
 *      fields (poll votes, pin flag, etc.).
 *
 * # Stuck-post pre-check
 *
 * Oracle flagged the "post item is over 400KB and write-locked" case
 * (item (h) in the design doc) as a remediation candidate the owner
 * must decide on. This script DOES NOT silently `REMOVE` the inline
 * `comments[]` attribute on stuck posts — destructive cleanup is
 * Phase 7. Instead, every post whose inline payload is "near or over
 * 400KB" is surfaced in the final report so the owner can decide:
 *
 *   - Sometimes the right call is to `REMOVE comments` after the
 *     backfill verifies (Phase 7 territory — needs Phase 6 first so
 *     the inline write stops).
 *   - Sometimes the right call is to hand-prune a specific spam
 *     comment.
 *
 * The "near 400KB" threshold is set generously low (350KB) so the
 * pre-check catches posts that are close to the cap, not just those
 * that have already hit it. Items under that threshold are silent.
 *
 * # Deploy ordering
 *
 *   1. `cdk deploy DatabaseStack` — provisions the new
 *      `clubhouse_comments` table.
 *   2. `cdk deploy ApiStack` — ships the new handler code (dual-write
 *      enabled, read path serves `commentCount` from the post row,
 *      listComments endpoint live).
 *   3. Run this script:
 *      `AWS_PROFILE=drep-platform AWS_REGION=us-east-1 STAGE=dev \
 *         npx tsx backend/scripts/backfill-clubhouse-comments.ts`
 *      Add `--dry-run` to print the plan without writing anything.
 *   4. Verify counts match. Until Phases 6/7 ship, the inline write
 *      stays alive as a rollback safety net.
 *
 * # Cost estimate
 *
 * Today: ~5 active clubhouses × ~50 posts × ~10 comments median
 *   = ~2500 conditional Puts + ~250 UpdateItems. PAY_PER_REQUEST:
 *   ~$0.005. Negligible. Worst case (one or two stuck posts at the
 *   400KB cap with ~80 comments × 5KB each): ~80 extra writes per
 *   stuck post, still pennies.
 *
 * # What this script does NOT do
 *
 *   - Does not modify `clubhouse_posts.comments[]` (the inline array
 *     stays in place as the dual-write source of truth until Phase 7).
 *   - Does not delete stuck posts. It reports them.
 *   - Does not retry transient DDB errors aggressively — single
 *     attempt per write, errors are logged, re-run picks them up.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
  PutCommand,
  UpdateCommand,
  type ScanCommandInput,
  type PutCommandInput,
  type UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb';
// Testable helpers (computeDepths, postKey, etc.) live in
// `backend/src/lib/backfill-clubhouse-comments.ts` so the vitest
// suite can drive them without crossing the rootDir boundary that
// excludes `scripts/`. Pattern mirrors `backfill-legacy-comment-seeds`.
import {
  STUCK_POST_SIZE_THRESHOLD_BYTES,
  clubhouseCommentsPostKeyFor,
  computeClubhouseCommentDepths,
  estimateClubhousePostRowSize,
  maxClubhouseCommentCreatedAt,
  type InlineCommentForBackfill,
} from '../src/lib/backfill-clubhouse-comments';

const STAGE = process.env['STAGE'] ?? 'dev';
const TABLE_PREFIX = `drep-platform-${STAGE}-`;
const CLUBHOUSE_POSTS_TABLE =
  process.env['CLUBHOUSE_POSTS_TABLE'] ?? `${TABLE_PREFIX}clubhouse_posts`;
const CLUBHOUSE_COMMENTS_TABLE =
  process.env['CLUBHOUSE_COMMENTS_TABLE'] ?? `${TABLE_PREFIX}clubhouse_comments`;
const REGION = process.env['AWS_REGION'] ?? 'us-east-1';

const DRY_RUN = process.argv.includes('--dry-run');

const rawClient = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(rawClient, {
  marshallOptions: { removeUndefinedValues: true, convertEmptyValues: false },
  unmarshallOptions: { wrapNumbers: false },
});

// Alias to the lib's shared type — preserves the original local name
// inside the script for diff-readability.
type InlineComment = InlineCommentForBackfill;

interface ClubhousePostRow {
  drepId: string;
  postId: string;
  comments?: InlineComment[];
  commentCount?: number;
  // Other fields are not touched by this script.
  [key: string]: unknown;
}

interface Counters {
  postsScanned: number;
  postsWithComments: number;
  commentsTotal: number;
  commentsWritten: number;
  commentsSkipped: number;
  commentsErrored: number;
  countersUpdated: number;
  countersErrored: number;
  stuckPosts: Array<{ drepId: string; postId: string; sizeBytes: number; commentCount: number }>;
}

// Helpers (postKeyFor, computeDepths, maxCreatedAt, estimateRowSize)
// are imported from `src/lib/backfill-clubhouse-comments.ts` so they
// can be unit-tested directly without crossing rootDir.
const postKeyFor = clubhouseCommentsPostKeyFor;
const computeDepths = computeClubhouseCommentDepths;
const maxCreatedAt = maxClubhouseCommentCreatedAt;
const estimateRowSize = estimateClubhousePostRowSize;

async function loadAllPosts(): Promise<ClubhousePostRow[]> {
  console.log(`backfill-clubhouse-comments: scanning ${CLUBHOUSE_POSTS_TABLE}`);
  const out: ClubhousePostRow[] = [];
  let lastKey: Record<string, unknown> | undefined;
  let pages = 0;
  do {
    const params: ScanCommandInput = {
      TableName: CLUBHOUSE_POSTS_TABLE,
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    };
    const result = await docClient.send(new ScanCommand(params));
    out.push(...((result.Items ?? []) as ClubhousePostRow[]));
    lastKey = result.LastEvaluatedKey;
    pages++;
  } while (lastKey);
  console.log(
    `backfill-clubhouse-comments: scanned ${out.length} posts in ${pages} page(s)`,
  );
  return out;
}

async function writeCommentRow(
  drepId: string,
  postId: string,
  comment: InlineComment,
  depth: 0 | 1 | 2,
): Promise<'written' | 'skipped' | 'errored'> {
  if (DRY_RUN) return 'written';
  const item = {
    postKey: postKeyFor(drepId, postId),
    commentId: comment.commentId,
    drepId,
    postId,
    authorWallet: comment.authorWallet,
    body: comment.body,
    createdAt: comment.createdAt,
    depth,
    ...(comment.authorDisplayName ? { authorDisplayName: comment.authorDisplayName } : {}),
    ...(comment.parentCommentId ? { parentCommentId: comment.parentCommentId } : {}),
  };
  const params: PutCommandInput = {
    TableName: CLUBHOUSE_COMMENTS_TABLE,
    Item: item,
    ConditionExpression: 'attribute_not_exists(commentId)',
  };
  try {
    await docClient.send(new PutCommand(params));
    return 'written';
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return 'skipped';
    }
    console.error(
      `backfill-clubhouse-comments: write failed drepId=${drepId} postId=${postId} commentId=${comment.commentId}:`,
      err,
    );
    return 'errored';
  }
}

async function setCommentCountAndLastReplyAt(
  drepId: string,
  postId: string,
  count: number,
  lastReplyAt: string | undefined,
): Promise<'ok' | 'errored'> {
  if (DRY_RUN) return 'ok';
  // SET both fields in a single Update — atomic against any concurrent
  // ADD :one from the live handler. The live handler's ADD on a
  // counter we just SET is well-defined: the counter ends at
  // `count + numLiveAddsBeforeWeRan`. The SET overwrite is safe as
  // long as the backfill runs ONCE per migration — a re-run would
  // overwrite live increments. (We accept this on the second run; the
  // counter resyncs against truth.)
  const update: UpdateCommandInput = {
    TableName: CLUBHOUSE_POSTS_TABLE,
    Key: { drepId, postId },
    UpdateExpression: lastReplyAt
      ? 'SET #cc = :count, #lra = :lra'
      : 'SET #cc = :count',
    ExpressionAttributeNames: lastReplyAt
      ? { '#cc': 'commentCount', '#lra': 'lastReplyAt' }
      : { '#cc': 'commentCount' },
    ExpressionAttributeValues: lastReplyAt
      ? { ':count': count, ':lra': lastReplyAt }
      : { ':count': count },
  };
  try {
    await docClient.send(new UpdateCommand(update));
    return 'ok';
  } catch (err) {
    console.error(
      `backfill-clubhouse-comments: counter Update failed drepId=${drepId} postId=${postId}:`,
      err,
    );
    return 'errored';
  }
}

async function processPost(post: ClubhousePostRow, counters: Counters): Promise<void> {
  counters.postsScanned++;

  // Stuck-post pre-check fires regardless of whether the row has
  // comments — the size check is purely about the row's DDB footprint.
  const sizeBytes = estimateRowSize(post);
  const comments = Array.isArray(post.comments) ? post.comments : [];

  if (sizeBytes > STUCK_POST_SIZE_THRESHOLD_BYTES) {
    counters.stuckPosts.push({
      drepId: post.drepId,
      postId: post.postId,
      sizeBytes,
      commentCount: comments.length,
    });
  }

  if (comments.length === 0) {
    // Empty-comments posts still need `commentCount: 0` if the
    // attribute is absent (older rows written before the migration).
    if (post.commentCount === undefined) {
      const outcome = await setCommentCountAndLastReplyAt(
        post.drepId,
        post.postId,
        0,
        undefined,
      );
      if (outcome === 'ok') counters.countersUpdated++;
      else counters.countersErrored++;
    }
    return;
  }

  counters.postsWithComments++;
  counters.commentsTotal += comments.length;
  const depths = computeDepths(comments);

  for (const comment of comments) {
    const depth = depths.get(comment.commentId) ?? 0;
    const outcome = await writeCommentRow(post.drepId, post.postId, comment, depth);
    if (outcome === 'written') counters.commentsWritten++;
    else if (outcome === 'skipped') counters.commentsSkipped++;
    else counters.commentsErrored++;
  }

  // Set the denormalized counter on the post — `commentCount =
  // comments.length` and `lastReplyAt = max(createdAt)`. Re-runs
  // overwrite both, which is fine for a one-shot backfill (the live
  // handler's `ADD :one` resumes after this point).
  const outcome = await setCommentCountAndLastReplyAt(
    post.drepId,
    post.postId,
    comments.length,
    maxCreatedAt(comments),
  );
  if (outcome === 'ok') counters.countersUpdated++;
  else counters.countersErrored++;
}

async function main(): Promise<void> {
  console.log(
    `backfill-clubhouse-comments: stage=${STAGE} region=${REGION}` +
      (DRY_RUN ? ' DRY-RUN' : ''),
  );

  const posts = await loadAllPosts();
  const counters: Counters = {
    postsScanned: 0,
    postsWithComments: 0,
    commentsTotal: 0,
    commentsWritten: 0,
    commentsSkipped: 0,
    commentsErrored: 0,
    countersUpdated: 0,
    countersErrored: 0,
    stuckPosts: [],
  };

  let processed = 0;
  for (const post of posts) {
    await processPost(post, counters);
    processed++;
    if (processed % 100 === 0) {
      console.log(
        `backfill-clubhouse-comments: ${processed}/${posts.length} posts processed ` +
          `(comments: written=${counters.commentsWritten}, skipped=${counters.commentsSkipped}, errored=${counters.commentsErrored}; ` +
          `counters: updated=${counters.countersUpdated}, errored=${counters.countersErrored})`,
      );
    }
  }

  console.log('backfill-clubhouse-comments: done');
  console.log(`  postsScanned       = ${counters.postsScanned}`);
  console.log(`  postsWithComments  = ${counters.postsWithComments}`);
  console.log(`  commentsTotal      = ${counters.commentsTotal}`);
  console.log(`  commentsWritten    = ${counters.commentsWritten}`);
  console.log(
    `  commentsSkipped    = ${counters.commentsSkipped} (already backfilled — idempotent re-run)`,
  );
  console.log(`  commentsErrored    = ${counters.commentsErrored}`);
  console.log(`  countersUpdated    = ${counters.countersUpdated}`);
  console.log(`  countersErrored    = ${counters.countersErrored}`);
  console.log(`  stuckPosts (>=${STUCK_POST_SIZE_THRESHOLD_BYTES} bytes) = ${counters.stuckPosts.length}`);

  if (counters.stuckPosts.length > 0) {
    console.log('');
    console.log(
      'backfill-clubhouse-comments: STUCK-POST REPORT — these posts are at',
    );
    console.log(
      `  or near the DynamoDB 400KB item cap. The migration's per-row writes`,
    );
    console.log(
      `  are already in place for them, but the inline \`comments[]\` array`,
    );
    console.log(
      `  on the post row will remain until Phase 7 (REMOVE attribute). The`,
    );
    console.log(
      `  owner should decide whether to hand-prune any specific post here:`,
    );
    for (const p of counters.stuckPosts) {
      console.log(
        `    - drepId=${p.drepId} postId=${p.postId} sizeBytes=${p.sizeBytes} commentCount=${p.commentCount}`,
      );
    }
  }

  if (counters.commentsErrored > 0 || counters.countersErrored > 0) {
    console.error('backfill-clubhouse-comments: completed with errors — re-run to retry');
    process.exit(1);
  }
}

// Defer execution if imported (the idempotency tests import the module
// to inspect helpers without running the main loop).
if (process.env['VITEST'] !== 'true' && require.main === module) {
  main().catch((err) => {
    console.error('backfill-clubhouse-comments: fatal error:', err);
    process.exit(1);
  });
}

// Re-export the lib helpers under the old script-local names so any
// past or future external caller of the script module keeps working.
export {
  computeDepths,
  maxCreatedAt,
  estimateRowSize,
  postKeyFor,
};
export { STUCK_POST_SIZE_THRESHOLD_BYTES };
