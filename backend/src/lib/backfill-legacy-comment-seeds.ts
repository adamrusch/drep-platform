/**
 * Backfill helper for the one-shot legacy-comment seed-vote script.
 * Implementation lives in `lib/` so unit tests under
 * `src/{...}/*.test.ts` can import it directly; the CLI entrypoint
 * (`scripts/backfill-legacy-comment-seeds.ts`) is a thin wrapper.
 *
 * See the script header for the full rationale; this module exports
 * the per-comment processor plus the counters interface so the test
 * suite can exercise the idempotency + upstream-failure paths.
 */

import { scanItems, tableNames, transactWrite, updateItem } from './dynamodb';
import { lookupStake } from './recognition';
import type { CommentItem, CommentVoteItem } from './types';

export interface BackfillSeedCounters {
  totalScanned: number;
  candidates: number;
  seeded: number;
  skipped: number;
  errors: number;
  /** Subset of `errors` where the upstream stake lookup failed (both
   *  Koios and Blockfrost). We log these so the operator can re-run
   *  later when upstreams recover. */
  upstreamFailures: number;
}

export function freshBackfillSeedCounters(): BackfillSeedCounters {
  return {
    totalScanned: 0,
    candidates: 0,
    seeded: 0,
    skipped: 0,
    errors: 0,
    upstreamFailures: 0,
  };
}

/**
 * Resolve the author's stake and write a seed upvote row + counter
 * update, mirroring `handlers/comments/create.ts:160-180`.
 *
 * Idempotency: the Put on the comment_votes row is conditional on
 * `attribute_not_exists(commentId)`. If the row already exists from a
 * prior run, the conditional fails, the transact rolls back, and we
 * count it as `skipped` rather than re-applying the counter delta.
 */
export async function processComment(
  comment: CommentItem,
  counters: BackfillSeedCounters,
): Promise<void> {
  // Author stake = the wallet address on the comment row. (In this
  // system the JWT subject == the stake address; comments preserve
  // the verbatim authenticated `walletAddress` from the original
  // create.)
  const stake = await lookupStake(comment.walletAddress);
  if (stake.source === null) {
    // Both upstreams failed. Don't write a zero-weight seed — that
    // would lie about the support level. Skip and let the operator
    // re-run when Koios + Blockfrost are healthy.
    counters.upstreamFailures += 1;
    counters.errors += 1;
    console.warn(
      `backfill-legacy-comment-seeds: upstream failed for actionId=${comment.actionId} commentId=${comment.commentId} wallet=${comment.walletAddress}; will retry on next run`,
    );
    return;
  }
  const seedLovelace = stake.lovelace ?? '0';
  // Bigint mirror for the counter ADD (DDB Number type — see
  // `handlers/comments/vote.ts` and the type docblock on
  // `CommentItem.supportLovelace` for why N, not S, since 2026-05-28).
  let seedLovelaceBig: bigint;
  try {
    seedLovelaceBig = BigInt(seedLovelace);
  } catch {
    seedLovelaceBig = 0n;
  }

  // First: if the existing comment row's `supportLovelace` is a legacy
  // `S` (string), convert it to `N` (number) BEFORE issuing the `ADD`.
  // Same UpdateItem pattern as `migrateLegacySupportLovelace` in
  // `vote.ts`, so the two paths stay aligned. The conditional swallow
  // covers a concurrent voter who already migrated the row.
  if (typeof comment.supportLovelace === 'string') {
    let existing: bigint;
    try {
      existing = BigInt(comment.supportLovelace);
    } catch {
      existing = 0n;
    }
    try {
      await updateItem(
        tableNames.comments,
        { actionId: comment.actionId, commentId: comment.commentId },
        'SET #supportLov = :n',
        { '#supportLov': 'supportLovelace' },
        { ':n': existing, ':sType': 'S' },
        'attribute_type(#supportLov, :sType)',
      );
    } catch (err) {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') {
        throw err;
      }
    }
  }

  const seedVote: CommentVoteItem = {
    commentId: comment.commentId,
    stakeAddress: comment.walletAddress,
    actionId: comment.actionId,
    vote: 'up',
    lovelace: seedLovelace,
    votedAt: comment.createdAt, // Backdate to the original create time.
  };

  try {
    await transactWrite([
      {
        // Conditional Put — if a row already exists for this
        // (commentId, stakeAddress) combo, the transact aborts and we
        // catch the ConditionalCheckFailed branch below.
        Put: {
          TableName: tableNames.commentVotes,
          Item: seedVote as unknown as Record<string, unknown>,
          ConditionExpression: 'attribute_not_exists(#pk)',
          ExpressionAttributeNames: { '#pk': 'commentId' },
        },
      },
      {
        // Counter mutation mirrors `buildCommentCounterUpdate` in
        // `handlers/comments/vote.ts`, using `ADD` for the BigInt
        // + headcount. `:delta` is the seed weight as a positive value
        // (an upvote adds lovelace and 1 upvote) — as a JS `bigint` so
        // the doc client marshals it to DDB `N` with full precision.
        Update: {
          TableName: tableNames.comments,
          Key: { actionId: comment.actionId, commentId: comment.commentId },
          UpdateExpression:
            'ADD #supportLov :delta, #upCount :upD SET #updatedAt = :now',
          ExpressionAttributeNames: {
            '#supportLov': 'supportLovelace',
            '#upCount': 'upvoteCount',
            '#updatedAt': 'updatedAt',
          },
          ExpressionAttributeValues: {
            ':delta': seedLovelaceBig,
            ':upD': 1,
            ':now': new Date().toISOString(),
          },
        },
      },
    ]);
    counters.seeded += 1;
  } catch (err) {
    const name = (err as { name?: string }).name;
    // ConditionalCheckFailedException on the Put side: the seed row
    // already exists. Idempotent re-run path.
    if (name === 'ConditionalCheckFailedException') {
      counters.skipped += 1;
      return;
    }
    // TransactionCanceledException: surface per-item reasons; if any
    // is a ConditionalCheckFailed treat as skip (same idempotency
    // semantic) — otherwise propagate.
    if (name === 'TransactionCanceledException') {
      const reasons = (err as { CancellationReasons?: Array<{ Code?: string }> })
        .CancellationReasons;
      if (Array.isArray(reasons) && reasons.some((r) => r?.Code === 'ConditionalCheckFailed')) {
        counters.skipped += 1;
        return;
      }
    }
    throw err;
  }
}

/**
 * Run the full backfill: scan all comments with `supportLovelace`
 * absent or zero, and process each one. Returns the final counters
 * object so the caller (CLI script) can pretty-print the totals.
 *
 * Logs progress every 100 processed rows.
 */
export async function runBackfillLegacyCommentSeeds(): Promise<BackfillSeedCounters> {
  console.log(
    `backfill-legacy-comment-seeds: target = ${tableNames.comments} (votes table = ${tableNames.commentVotes})`,
  );
  const counters = freshBackfillSeedCounters();

  // Scan every comment, filtering server-side to rows that need
  // backfilling. We accept the Scan cost because:
  //   1. The set of legacy comments is small (~hundreds today on dev)
  //      and grows by at most "comments created before this PR shipped."
  //   2. There's no GSI on `supportLovelace` and adding one for a
  //      one-shot backfill is the wrong shape.
  //
  // Filter: `attribute_not_exists(supportLovelace) OR supportLovelace =
  // :zero`. Both shapes count as "needs seeding" — older rows lack
  // the field entirely; if a future code path ever blanks it to "0"
  // we want to recover those too.
  let cursor: Record<string, unknown> | undefined;
  let page = 0;
  do {
    page += 1;
    const scanResult = await scanItems<CommentItem>(tableNames.comments, {
      filterExpression: 'attribute_not_exists(#supportLov) OR #supportLov = :zero',
      expressionAttributeNames: { '#supportLov': 'supportLovelace' },
      expressionAttributeValues: { ':zero': '0' },
      ...(cursor ? { exclusiveStartKey: cursor } : {}),
    });
    counters.totalScanned += scanResult.count;
    counters.candidates += scanResult.items.length;
    console.log(
      `backfill-legacy-comment-seeds: page ${page} — scanned ${scanResult.count} raw items, ${scanResult.items.length} candidates`,
    );

    for (const comment of scanResult.items) {
      try {
        await processComment(comment, counters);
      } catch (err) {
        counters.errors += 1;
        console.error(
          `backfill-legacy-comment-seeds: failed actionId=${comment.actionId} commentId=${comment.commentId}:`,
          err,
        );
      }

      // Progress log every 100 rows processed (success or skip).
      const processed = counters.seeded + counters.skipped + counters.errors;
      if (processed > 0 && processed % 100 === 0) {
        console.log(
          `backfill-legacy-comment-seeds: progress seeded=${counters.seeded} skipped=${counters.skipped} errors=${counters.errors} upstreamFailures=${counters.upstreamFailures}`,
        );
      }
    }

    cursor = scanResult.lastEvaluatedKey;
  } while (cursor);

  return counters;
}
