/**
 * Cast / change / remove a vote on a comment (or reply).
 *
 * # Why this lives here, not on the clubhouse-poll pattern
 *
 * Clubhouse poll votes are uniform (one option toggle = ±1 to a counter).
 * Comment votes are stake-weighted: each vote carries the voter's wallet
 * stake in lovelace, snapshotted at vote time, and the support level is
 * `sum(up.lovelace) - sum(down.lovelace)`.
 *
 * # Schema decision (separate `comment_votes` table + denormalized counter)
 *
 * We chose a separate `comment_votes` table over a `Map<stakeAddress, vote>`
 * blob on the comment row because:
 *   1. DynamoDB items max out at 400KB. A popular comment with ~5000 voters
 *      averaging 60 bytes/entry = 300KB, well into the "near-cap" region.
 *   2. Recasting a vote becomes a read-modify-write of the entire blob
 *      (and a conditional check on the version) — clumsy and contention-
 *      prone.
 * AND a denormalized `supportLovelace` counter on the `comments` row
 * (rather than sum-on-read) because:
 *   1. List endpoint serves ~50 comments in one Query; sum-on-read would
 *      fan out into 50 sub-Queries.
 *   2. The counter only updates on vote changes (cold path); list reads
 *      are warm.
 * Atomicity is preserved via `transactWrite`: we Put the new vote row +
 * Update the comments-row delta in one transaction. The two can never
 * drift more than one in-flight transaction.
 *
 * # Recast atomicity
 *
 * Recasting requires knowing the PRIOR vote (so the counter delta is
 * `new - old`). DynamoDB transactions don't support read-then-write in a
 * single call, so we:
 *   1. GetItem the prior vote row (eventually consistent — single user,
 *      ~zero contention against themselves).
 *   2. Compute the delta.
 *   3. `transactWrite` with a `ConditionCheck` that the prior row's
 *      `lovelace` + `vote` still match what we read. On condition fail,
 *      we surface 409 — caller retries.
 *
 * # Auth
 *
 * Authenticated only. The auth context gives us the voter's stake
 * address (the wallet they authenticated with). NO mutation-nonce flow
 * here — voting is high-frequency low-stakes (same trade-off as the
 * clubhouse poll-vote handler). The JWT cookie + the per-(comment,
 * stakeAddress) uniqueness key are sufficient.
 *
 * # Author seed-vote
 *
 * The seed upvote on a fresh comment was already written by the create
 * handler. Removing it requires deleting the whole comment — we reject a
 * "remove" from the comment author against their own comment because the
 * design treats the seed as part of authorship.
 */
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { getItem, tableNames, transactWrite } from '../../lib/dynamodb';

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];
import type { CommentItem, CommentVoteItem } from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { lookupStake } from '../../lib/recognition';
import { ok, badRequest, unauthorized, notFound, conflict, internalError, handleError } from '../_response';

interface VoteBody {
  /** `'up'` / `'down'` to cast or change a vote, `'none'` to remove. */
  vote: 'up' | 'down' | 'none';
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    const actionId = event.pathParameters?.['actionId'];
    const commentId = event.pathParameters?.['commentId'];

    if (!actionId || !commentId) {
      return badRequest('actionId and commentId path parameters are required');
    }
    if (!authCtx.walletAddress) {
      // Belt-and-braces — the authorizer would have rejected anonymous
      // requests already. Surface a clean 401 if the context is somehow
      // missing the stake address.
      return unauthorized('Authenticated wallet stake address required');
    }
    if (!event.body) {
      return badRequest('Request body is required');
    }

    let parsed: VoteBody;
    try {
      parsed = JSON.parse(event.body) as VoteBody;
    } catch {
      return badRequest('Invalid JSON body');
    }

    if (parsed.vote !== 'up' && parsed.vote !== 'down' && parsed.vote !== 'none') {
      return badRequest("vote must be one of 'up', 'down', 'none'");
    }

    const decodedActionId = decodeURIComponent(actionId);
    const decodedCommentId = decodeURIComponent(commentId);

    const comment = await getItem<CommentItem>(tableNames.comments, {
      actionId: decodedActionId,
      commentId: decodedCommentId,
    });
    if (!comment) return notFound('Comment');

    // Authors cannot remove their own seed vote — see module header.
    // Changing it (up → down) is also blocked since "down on my own
    // comment" doesn't make sense as a UX; if they want to retract,
    // they delete the comment.
    if (comment.walletAddress === authCtx.walletAddress) {
      return badRequest(
        'Comment authors cannot vote on their own comment. Delete the comment to retract.',
      );
    }

    // Read the caller's prior vote (if any). Eventually-consistent read
    // is fine — a user racing themselves across two tabs to vote on the
    // SAME comment is implausible and would resolve to the last write.
    const priorVote = await getItem<CommentVoteItem>(tableNames.commentVotes, {
      commentId: decodedCommentId,
      stakeAddress: authCtx.walletAddress,
    });

    // Idempotent: voting the same direction with the same lovelace is a
    // no-op. We deliberately don't refresh the snapshot on idempotent
    // recasts — the user expects "I already voted up, nothing changed."
    if (priorVote && parsed.vote === priorVote.vote) {
      return ok(await readCommentForResponse(decodedActionId, decodedCommentId));
    }

    // ---- Remove vote path ----
    if (parsed.vote === 'none') {
      if (!priorVote) {
        // Nothing to remove — treat as success (idempotent).
        return ok(comment);
      }
      const priorLovelace = safeBigInt(priorVote.lovelace);
      const delta = priorVote.vote === 'up' ? -priorLovelace : priorLovelace;
      const upDelta = priorVote.vote === 'up' ? -1 : 0;
      const downDelta = priorVote.vote === 'down' ? -1 : 0;

      try {
        await transactWrite([
          {
            // Optimistic-concurrency guard: refuse the transact if the
            // prior row's lovelace/vote changed under us between the Get
            // and the transact. On condition fail we surface 409 and the
            // client can retry. In practice this never trips outside of
            // pathological cases (same user voting from two tabs at the
            // same millisecond).
            ConditionCheck: {
              TableName: tableNames.commentVotes,
              Key: {
                commentId: decodedCommentId,
                stakeAddress: authCtx.walletAddress,
              },
              ConditionExpression: '#vote = :prevVote AND #lov = :prevLov',
              ExpressionAttributeNames: { '#vote': 'vote', '#lov': 'lovelace' },
              ExpressionAttributeValues: {
                ':prevVote': priorVote.vote,
                ':prevLov': priorVote.lovelace,
              },
            },
          },
          {
            Delete: {
              TableName: tableNames.commentVotes,
              Key: {
                commentId: decodedCommentId,
                stakeAddress: authCtx.walletAddress,
              },
            },
          },
          ...buildCommentCounterUpdate(decodedActionId, decodedCommentId, delta, upDelta, downDelta),
        ]);
      } catch (err) {
        if (isConditionalCheckFailure(err)) {
          return conflict('Vote changed concurrently; please retry');
        }
        throw err;
      }
      return ok(await readCommentForResponse(decodedActionId, decodedCommentId));
    }

    // ---- Cast / change vote path ----
    //
    // Snapshot the voter's CURRENT stake from Koios (Blockfrost fallback).
    // If both upstreams fail we hard-reject — silently recording a zero-
    // weight vote would distort the support level and is worse than
    // surfacing the outage to the caller. Same rationale as the existing
    // recognition both-failed semantic.
    const stake = await lookupStake(authCtx.walletAddress);
    if (stake.source === null) {
      return internalError('Could not resolve voter stake (Koios + Blockfrost both unreachable)');
    }
    const newLovelace = stake.lovelace ?? '0';
    const newLovelaceBig = safeBigInt(newLovelace);
    const now = new Date().toISOString();

    let priorContribution = 0n;
    if (priorVote) {
      const priorL = safeBigInt(priorVote.lovelace);
      priorContribution = priorVote.vote === 'up' ? priorL : -priorL;
    }
    const newContribution = parsed.vote === 'up' ? newLovelaceBig : -newLovelaceBig;
    const delta = newContribution - priorContribution;

    let upDelta = 0;
    let downDelta = 0;
    if (priorVote?.vote === 'up') upDelta -= 1;
    if (priorVote?.vote === 'down') downDelta -= 1;
    if (parsed.vote === 'up') upDelta += 1;
    if (parsed.vote === 'down') downDelta += 1;

    const newVoteRow: CommentVoteItem = {
      commentId: decodedCommentId,
      stakeAddress: authCtx.walletAddress,
      actionId: decodedActionId,
      vote: parsed.vote,
      lovelace: newLovelace,
      votedAt: now,
    };

    try {
      await transactWrite([
        // Optimistic concurrency: the prior row (if any) must look
        // exactly the way it did at our Get. The condition shape differs
        // for "no prior vote" vs "prior vote present" — we use
        // `attribute_not_exists` in the no-prior case.
        priorVote
          ? {
              ConditionCheck: {
                TableName: tableNames.commentVotes,
                Key: {
                  commentId: decodedCommentId,
                  stakeAddress: authCtx.walletAddress,
                },
                ConditionExpression: '#vote = :prevVote AND #lov = :prevLov',
                ExpressionAttributeNames: { '#vote': 'vote', '#lov': 'lovelace' },
                ExpressionAttributeValues: {
                  ':prevVote': priorVote.vote,
                  ':prevLov': priorVote.lovelace,
                },
              },
            }
          : {
              ConditionCheck: {
                TableName: tableNames.commentVotes,
                Key: {
                  commentId: decodedCommentId,
                  stakeAddress: authCtx.walletAddress,
                },
                ConditionExpression: 'attribute_not_exists(#pk)',
                ExpressionAttributeNames: { '#pk': 'commentId' },
              },
            },
        {
          Put: {
            TableName: tableNames.commentVotes,
            Item: newVoteRow as unknown as Record<string, unknown>,
          },
        },
        ...buildCommentCounterUpdate(decodedActionId, decodedCommentId, delta, upDelta, downDelta),
      ]);
    } catch (err) {
      if (isConditionalCheckFailure(err)) {
        return conflict('Vote changed concurrently; please retry');
      }
      throw err;
    }
    return ok(await readCommentForResponse(decodedActionId, decodedCommentId));
  } catch (err) {
    console.error('comments/vote handler error:', err);
    return handleError(err);
  }
};

/**
 * Build the `Update` action that mutates the parent comment's
 * `supportLovelace` BigInt and headcount counters atomically with the
 * vote row write.
 *
 * `supportLovelace` is stored as a stringified BigInt (to preserve
 * precision past 2^53), so DynamoDB's native `ADD` cannot be used —
 * BigInt arithmetic lives in JS-land. We pre-compute the new value here
 * and write it via a SET expression. This is correct because the
 * containing transaction's ConditionCheck on the vote row gates against
 * a stale read: if another voter raced us, the ConditionCheck on THEIR
 * row would fail their transact, not ours, so our read of the comments
 * counter (implicit in the pre-computed value) is the relevant one.
 *
 * Wait — actually our own pre-computed value is based on what we read
 * from the prior vote, NOT from a fresh read of the counter. We need a
 * different concurrency story for the counter. See below.
 */
function buildCommentCounterUpdate(
  actionId: string,
  commentId: string,
  delta: bigint,
  upDelta: number,
  downDelta: number,
): TransactItem[] {
  // We use DynamoDB's `ADD` on a STRING attribute is not supported, so we
  // store `supportLovelace` numerically by encoding deltas in a separate
  // numeric attribute that we then read back into a BigInt on response.
  //
  // BUT: the cleaner approach is to keep `supportLovelace` as a NUMBER on
  // the wire (DynamoDB Number is arbitrary-precision decimal — up to 38
  // significant digits — which comfortably fits any lovelace amount on
  // mainnet). The JS document client unmarshals it as a `string` already
  // because we have `wrapNumbers: false`, so on read we just get the
  // string form back. `ADD` on numeric attributes IS supported.
  //
  // So: write delta as a NUMBER, let DynamoDB add it, and read it back as
  // the string form via `wrapNumbers: false`. The Item type still types
  // `supportLovelace` as a string — it is on the JS side.
  //
  // Lovelace max: 45e9 ADA × 1e6 = 4.5e16, far under DynamoDB's 38-digit
  // decimal cap. Sum across all voters can theoretically be higher but
  // won't ever exceed 2x total supply (you can't have more upvotes than
  // total existing lovelace).
  return [
    {
      Update: {
        TableName: tableNames.comments,
        Key: { actionId, commentId },
        UpdateExpression:
          'ADD #supportLov :delta, #upCount :upD, #downCount :downD SET #updatedAt = :now',
        ExpressionAttributeNames: {
          '#supportLov': 'supportLovelace',
          '#upCount': 'upvoteCount',
          '#downCount': 'downvoteCount',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          // DynamoDB accepts a string for numeric attributes; the SDK
          // will marshal it as a Number. `delta.toString()` keeps full
          // precision. The `ADD` action handles missing attributes as
          // zero, so this works on rows written before the counter
          // landed (old comments rolled-in).
          ':delta': delta.toString(),
          ':upD': upDelta,
          ':downD': downDelta,
          ':now': new Date().toISOString(),
        },
      },
    },
  ];
}

async function readCommentForResponse(actionId: string, commentId: string): Promise<CommentItem | undefined> {
  return getItem<CommentItem>(tableNames.comments, { actionId, commentId });
}

function safeBigInt(s: string | undefined | null): bigint {
  if (!s) return 0n;
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}

function isConditionalCheckFailure(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: string }).name;
  // Single-item conditional check failure throws ConditionalCheckFailedException.
  // Transact failure aggregates per-item failures into TransactionCanceledException
  // with a CancellationReasons array — when ANY ConditionCheck inside the
  // transact fails, the cancellation reason carries `Code: 'ConditionalCheckFailed'`.
  if (name === 'ConditionalCheckFailedException') return true;
  if (name === 'TransactionCanceledException') {
    const reasons = (err as { CancellationReasons?: Array<{ Code?: string }> })
      .CancellationReasons;
    if (Array.isArray(reasons)) {
      return reasons.some((r) => r?.Code === 'ConditionalCheckFailed');
    }
    // Older SDK error shape: `.message` includes "ConditionalCheckFailed".
    const msg = (err as { message?: string }).message;
    if (typeof msg === 'string' && msg.includes('ConditionalCheckFailed')) return true;
  }
  return false;
}
