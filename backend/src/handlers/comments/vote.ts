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
import { getItem, tableNames, transactWrite, updateItem } from '../../lib/dynamodb';

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];
import type { CommentItem, CommentVoteItem } from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { lookupStake } from '../../lib/recognition';
import { writeAuditEvent } from '../../lib/audit';
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

    // Lazy migration of legacy `supportLovelace` rows.
    //
    // Prior to the 2026-05-28 P0-2 fix, `supportLovelace` was stored as a
    // DynamoDB String (`S`) because the original counter-update path SET
    // the field rather than `ADD`-ing to it. After the flip to `ADD :delta`
    // (with `:delta` as a real numeric N), an existing row with an `S`-
    // typed `supportLovelace` would cause DDB to throw `ValidationException:
    // Type mismatch for attribute to update`. We detect this here and run
    // a one-shot conditional UpdateItem that REPLACES the `S` value with
    // an equivalent `N` value (using `attribute_type` to gate the rewrite
    // against a concurrent voter who already migrated it). After this
    // succeeds — or harmlessly fails on conditional-check — the
    // transactWrite below sees an `N` and `ADD` works.
    if (typeof comment.supportLovelace === 'string') {
      await migrateLegacySupportLovelace(
        decodedActionId,
        decodedCommentId,
        comment.supportLovelace,
      );
    }

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
      // Best-effort audit. `priorVote.vote` is the direction being
      // retracted; `actionId` lets a query group every vote on a
      // governance action regardless of which comment it landed on.
      await writeAuditEvent({
        entityType: 'comment_vote',
        entityId: decodedCommentId,
        eventType: 'comment.voted',
        actorWallet: authCtx.walletAddress,
        metadata: {
          actionId: decodedActionId,
          voteDirection: 'none',
          priorVote: priorVote.vote,
        },
      });
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
    // Best-effort audit on cast / change. `priorVote` may be absent
    // (first vote) — the metadata reflects that with `priorVote: null`.
    await writeAuditEvent({
      entityType: 'comment_vote',
      entityId: decodedCommentId,
      eventType: 'comment.voted',
      actorWallet: authCtx.walletAddress,
      metadata: {
        actionId: decodedActionId,
        voteDirection: parsed.vote,
        priorVote: priorVote?.vote ?? null,
      },
    });
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
 * Concurrency: `supportLovelace` is a DynamoDB Number attribute updated
 * with `ADD :delta` — atomic at the DDB layer, so two voters writing in
 * parallel each contribute their own delta without one clobbering the
 * other (unlike read-modify-write SET). The vote-row ConditionCheck in
 * the surrounding transactWrite handles same-voter idempotency.
 *
 * Precision: `:delta` is a JS `bigint`, marshalled by the doc client
 * directly as a DDB Number with full precision (up to DDB's 38-digit
 * decimal cap, vs JS's 2^53 safe-int limit). The `wrapNumbers` function
 * in `dynamodb.ts` reads it back as `bigint` when the value exceeds
 * `Number.MAX_SAFE_INTEGER`, otherwise as a JS `number`. `safeBigInt`
 * accepts all three input shapes (string from legacy `S` rows, number
 * for small new totals, bigint for large new totals).
 *
 * Lovelace max: 45e9 ADA × 1e6 = 4.5e16, far under DynamoDB's 38-digit
 * decimal cap. Sum across all voters won't ever exceed 2x total supply
 * (you can't have more upvotes than total existing lovelace).
 */
function buildCommentCounterUpdate(
  actionId: string,
  commentId: string,
  delta: bigint,
  upDelta: number,
  downDelta: number,
): TransactItem[] {
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
          // Pass the raw bigint — the doc-client marshaller emits a real
          // DDB `N` with full precision. Previously this code did
          // `delta.toString()` which the marshaller emitted as `S`,
          // causing every `ADD` to throw `ValidationException: An operand
          // in the update expression has an incorrect data type`. That
          // was the P0-2 bug fixed on 2026-05-28.
          ':delta': delta,
          ':upD': upDelta,
          ':downD': downDelta,
          ':now': new Date().toISOString(),
        },
      },
    },
  ];
}

/**
 * Convert a comment row whose `supportLovelace` is a legacy `S` (string)
 * to the new `N` (number) representation, so the subsequent `ADD :delta`
 * doesn't throw `ValidationException: Type mismatch for attribute to
 * update`.
 *
 * The UpdateItem is gated by `attribute_type(#supportLov, :sType)` so a
 * concurrent voter who already migrated this row doesn't get its `N`
 * value clobbered with our re-derived value. ConditionalCheckFailed in
 * that case is benign — we swallow it and let the caller proceed.
 *
 * Any other error propagates so the calling handler returns 5xx; that's
 * preferable to silently dropping the vote on a real DDB outage.
 */
async function migrateLegacySupportLovelace(
  actionId: string,
  commentId: string,
  currentStringValue: string,
): Promise<void> {
  let asBig: bigint;
  try {
    asBig = BigInt(currentStringValue);
  } catch {
    // Malformed legacy data — reset to zero rather than carrying the
    // bad value forward. ADD will then start the counter at zero.
    asBig = 0n;
  }
  try {
    await updateItem(
      tableNames.comments,
      { actionId, commentId },
      'SET #supportLov = :n',
      { '#supportLov': 'supportLovelace' },
      { ':n': asBig, ':sType': 'S' },
      // Only rewrite when the field is still an `S` — a concurrent voter
      // who already migrated it shouldn't have their `N` value clobbered.
      'attribute_type(#supportLov, :sType)',
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      // Another voter raced us and already migrated. Fine — proceed.
      return;
    }
    throw err;
  }
}

async function readCommentForResponse(actionId: string, commentId: string): Promise<CommentItem | undefined> {
  return getItem<CommentItem>(tableNames.comments, { actionId, commentId });
}

/**
 * Coerce a `supportLovelace`-shaped field to `bigint` regardless of how
 * the SDK unmarshalled it.
 *
 * After the 2026-05-28 P0-2 fix the field is a DDB `N` and can come
 * back as either `number` (for values ≤ MAX_SAFE_INTEGER) or `bigint`
 * (for values past it, via the smart unmarshall in `dynamodb.ts`).
 * Legacy `S`-typed rows still come back as `string` until the lazy
 * migration in this handler (or the broadened backfill script) flips
 * them to `N`.
 */
function safeBigInt(s: string | number | bigint | undefined | null): bigint {
  if (s === undefined || s === null || s === '') return 0n;
  if (typeof s === 'bigint') return s;
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
