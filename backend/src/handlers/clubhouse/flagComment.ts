/**
 * Sprint 4 follow-up — community flagging for clubhouse COMMENTS.
 *
 * Closes the last leg of the Sprint 4 flagging trio. Sprint 4 added
 * flagging for governance-action comments (`handlers/comments/flag.ts`)
 * and clubhouse posts (`handlers/clubhouse/flagPost.ts`); clubhouse
 * comments were the missing primitive. This handler is a sibling of the
 * two — same shape, same threshold (`HIDE_THRESHOLD = 3`, reused from
 * `handlers/comments/flag.ts`), same atomicity reasoning. The header
 * comment on `handlers/comments/flag.ts` documents the full design
 * (threat model, self-flag gate, duplicate-flag idempotency, atomic
 * counter-then-hide) — this file calls out only the deltas.
 *
 * # Deltas vs the comments flag
 *
 *   - Resource: `clubhouse_comments` (PK=`postKey`, SK=`commentId`).
 *   - Flag-row table: `clubhouse_comment_flags` with PK=`postKey`,
 *     SK=`commentFlagKey` (= `${commentId}#${flaggerId}`). A single
 *     `Query(postKey)` enumerates every flag for every comment under
 *     the post.
 *   - Hide threshold: SAME `HIDE_THRESHOLD = 3` constant — bumping it
 *     would diverge the three flag surfaces and is a deliberate
 *     product call rather than a code drift.
 */

import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import {
  docClient,
  getItem,
  putItemIfAbsent,
  tableNames,
} from '../../lib/dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  clubhouseCommentPostKey,
  clubhouseCommentFlagKey,
  type ClubhouseCommentRowItem,
  type ClubhouseCommentFlagItem,
  type OnChainRole,
} from '../../lib/types';
import {
  extractAuthContext,
  requireOnChainRole,
} from '../../middleware/role-guard';
import { writeAuditEvent } from '../../lib/audit';
import { HIDE_THRESHOLD } from '../comments/flag';
import {
  ok,
  badRequest,
  forbidden,
  notFound,
  handleError,
} from '../_response';

/** First-in-line role from the caller's on-chain credentials.
 *  Bound onto the flag row for the audit trail. Returns undefined only
 *  if `requireOnChainRole` would have already 403'd — defence in depth. */
function pickRole(roles: ReadonlyArray<OnChainRole>): OnChainRole | undefined {
  return roles[0];
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    const drepIdRaw = event.pathParameters?.['drepId'];
    const postIdRaw = event.pathParameters?.['postId'];
    const commentIdRaw = event.pathParameters?.['commentId'];

    if (!drepIdRaw || !postIdRaw || !commentIdRaw) {
      return badRequest('drepId, postId, and commentId path parameters are required');
    }

    requireOnChainRole(authCtx, 'drep', 'spo', 'cc', 'proposer');

    const role = pickRole(authCtx.onChainRoles ?? []);
    if (!role) {
      // Defence-in-depth — `requireOnChainRole` should have thrown 403
      // above. If we ever land here it's a programming error in this
      // file, not a malicious caller.
      return forbidden('On-chain role required to flag');
    }

    const drepId = decodeURIComponent(drepIdRaw);
    const postId = decodeURIComponent(postIdRaw);
    const commentId = decodeURIComponent(commentIdRaw);
    const postKey = clubhouseCommentPostKey(drepId, postId);

    // Verify the comment exists AND fetch its author so the self-flag
    // guard can fire. The new-table read (P0-3 migration) is the source
    // of truth for clubhouse comments post-2026-05-28.
    const comment = await getItem<ClubhouseCommentRowItem>(
      tableNames.clubhouseComments,
      { postKey, commentId },
    );
    if (!comment) {
      return notFound('Clubhouse comment');
    }

    // Self-flag gate — same rationale as the two sibling handlers.
    if (comment.authorWallet === authCtx.walletAddress) {
      return badRequest('You cannot flag your own comment');
    }

    const now = new Date().toISOString();
    const flagRow: ClubhouseCommentFlagItem = {
      postKey,
      commentFlagKey: clubhouseCommentFlagKey(commentId, authCtx.walletAddress),
      commentId,
      drepId,
      postId,
      flaggerId: authCtx.walletAddress,
      role,
      createdAt: now,
    };

    const insertOutcome = await putItemIfAbsent(
      tableNames.clubhouseCommentFlags,
      flagRow as unknown as Record<string, unknown>,
      { partitionKey: 'postKey', sortKey: 'commentFlagKey' },
    );

    if (insertOutcome.outcome === 'errored') {
      throw insertOutcome.error;
    }

    if (insertOutcome.outcome === 'skipped') {
      // Duplicate flag from the same wallet on the same comment.
      // Audit for the abuse-pattern story (a sock-puppet trying twice
      // is still an interesting signal) and return 200 with a
      // distinguishable outcome so the FE renders the unified
      // "flagged" affordance.
      await writeAuditEvent({
        entityType: 'clubhouse_comment',
        entityId: commentId,
        eventType: 'clubhouse.comment.flag_dup',
        actorWallet: authCtx.walletAddress,
        metadata: { drepId, postId, role },
      });
      return ok({
        outcome: 'already_flagged',
        commentId,
      });
    }

    // Step A: atomic ADD of the denormalised counter on the parent
    // `clubhouse_comments` row. Same shape as the sibling handlers —
    // two concurrent writers both ADDing 1 end at +2, never +1. We
    // capture the new counter via `UPDATED_NEW` to decide step B.
    //
    // Note: the sibling handlers `comments/flag.ts:238` and
    // `clubhouse/flagPost.ts:134` also bump `#updatedAt = :now` in the
    // same expression. This file previously omitted that — a subtle
    // parity drift caught in the 2026-07-04 code review — so a
    // clubhouse comment that got flagged never rotated its
    // `updatedAt`, which any downstream consumer (moderation queue
    // sort, cache-key derivation) sorts on. Fixed here.
    let newCount: number | undefined;
    try {
      const updateRes = await docClient.send(
        new UpdateCommand({
          TableName: tableNames.clubhouseComments,
          Key: { postKey, commentId },
          UpdateExpression: 'ADD #flagCount :one SET #updatedAt = :now',
          ExpressionAttributeNames: {
            '#flagCount': 'flagCount',
            '#updatedAt': 'updatedAt',
          },
          ExpressionAttributeValues: { ':one': 1, ':now': now },
          ReturnValues: 'UPDATED_NEW',
        }),
      );
      const attrs = updateRes.Attributes as Record<string, unknown> | undefined;
      const c = attrs?.['flagCount'];
      if (typeof c === 'number') {
        newCount = c;
      } else if (typeof c === 'bigint') {
        newCount = Number(c);
      }
    } catch (err) {
      // The per-flagger row is already written (canonical evidence) —
      // surface the counter-update failure so an operator notices, but
      // do not roll back the flag.
      console.warn(
        `clubhouse/flagComment: counter ADD failed for postKey=${postKey} commentId=${commentId}:`,
        err,
      );
      throw err;
    }

    // Step B: if the new count crossed the threshold, conditionally
    // SET `hidden = true`. ConditionalCheckFailedException is treated
    // as "already hidden" (idempotent). Other errors are logged and
    // swallowed — the counter is correct and the next flag will retry.
    let hidden = false;
    if (newCount !== undefined && newCount >= HIDE_THRESHOLD) {
      try {
        await docClient.send(
          new UpdateCommand({
            TableName: tableNames.clubhouseComments,
            Key: { postKey, commentId },
            UpdateExpression: 'SET #hidden = :true',
            ConditionExpression:
              'attribute_not_exists(#hidden) OR #hidden = :false',
            ExpressionAttributeNames: { '#hidden': 'hidden' },
            ExpressionAttributeValues: { ':true': true, ':false': false },
          }),
        );
        hidden = true;
      } catch (err) {
        if (
          err &&
          typeof err === 'object' &&
          (err as { name?: string }).name === 'ConditionalCheckFailedException'
        ) {
          hidden = true;
        } else {
          console.warn(
            `clubhouse/flagComment: hide SET failed for postKey=${postKey} commentId=${commentId}:`,
            err,
          );
        }
      }
    }

    await writeAuditEvent({
      entityType: 'clubhouse_comment',
      entityId: commentId,
      eventType: 'clubhouse.comment.flagged',
      actorWallet: authCtx.walletAddress,
      metadata: {
        drepId,
        postId,
        role,
        flagCount: newCount,
        hidden,
      },
    });

    return ok({
      outcome: 'flagged',
      commentId,
      flagCount: newCount,
      hidden,
    });
  } catch (err) {
    console.error('clubhouse/flagComment handler error:', err);
    return handleError(err);
  }
};
