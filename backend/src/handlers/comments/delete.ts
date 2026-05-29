import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getItem, deleteItem, queryItems, tableNames } from '../../lib/dynamodb';
import type { CommentItem, CommentVoteItem } from '../../lib/types';
import { extractAuthContext, requireOwner } from '../../middleware/role-guard';
import { writeAuditEvent } from '../../lib/audit';
import { noContent, badRequest, notFound, handleError } from '../_response';

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

    const decodedActionId = decodeURIComponent(actionId);
    const decodedCommentId = decodeURIComponent(commentId);

    const existing = await getItem<CommentItem>(tableNames.comments, {
      actionId: decodedActionId,
      commentId: decodedCommentId,
    });

    if (!existing) {
      return notFound('Comment');
    }

    // Only the comment AUTHOR can delete their own action comments.
    //
    // P0-4 (2026-05-28): the previous code allowed any caller holding
    // `lead_drep` globally to delete any action comment — a privilege-
    // escalation path for every wallet that ever registered a DRep
    // committee. Comments here are scoped to a governance ACTION, not
    // a DRep, so there is no natural "committee that owns this
    // comment" to scope the override against. Option (a) from the
    // audit brief was chosen: no platform moderator override exists
    // for action comments. If product later wants moderation, it
    // should be added as an explicit, audited role (not piggy-backed
    // on an unrelated committee role).
    //
    // Audit the denial BEFORE rethrowing so an incident-responder can
    // see who tried to delete what they didn't own.
    try {
      requireOwner(authCtx, existing.walletAddress);
    } catch (err) {
      await writeAuditEvent({
        entityType: 'comment',
        entityId: decodedCommentId,
        eventType: 'comment.delete_denied',
        actorWallet: authCtx.walletAddress,
        metadata: {
          actionId: decodedActionId,
          ownerWallet: existing.walletAddress,
          reason: 'not_owner',
        },
      });
      throw err;
    }

    // Best-effort vote-row cleanup. We delete the per-vote rows in
    // `comment_votes` so they don't dangle. Failure here doesn't roll
    // back the comment delete — the votes table is purely the audit
    // trail and a leftover row points to a missing parent (cheap GC for
    // a future sweep).
    try {
      const votes = await queryItems<CommentVoteItem>(tableNames.commentVotes, {
        keyConditionExpression: '#commentId = :commentId',
        expressionAttributeNames: { '#commentId': 'commentId' },
        expressionAttributeValues: { ':commentId': decodedCommentId },
        limit: 1000,
      });
      for (const v of votes.items) {
        try {
          await deleteItem(tableNames.commentVotes, {
            commentId: v.commentId,
            stakeAddress: v.stakeAddress,
          });
        } catch (err) {
          console.warn('comments/delete: failed to delete vote row, continuing:', err);
        }
      }
    } catch (err) {
      console.warn('comments/delete: failed to list vote rows, continuing:', err);
    }

    // Cascade: deleting a top-level comment also removes its replies.
    // Required so the replies don't become orphans (their parentCommentId
    // would point at a missing row, breaking the threading UI). This only
    // applies to TOP-LEVEL deletes; replies have no children of their own.
    if (existing.parentCommentId === undefined) {
      try {
        // Scoped query — we filter the action's comments to those with
        // matching parentCommentId. The `walletAddress-index` GSI is on
        // walletAddress; we don't have a parentCommentId index, but the
        // action's comment list is small (~50) so we filter in-memory.
        const siblings = await queryItems<CommentItem>(tableNames.comments, {
          keyConditionExpression: '#actionId = :actionId',
          expressionAttributeNames: { '#actionId': 'actionId' },
          expressionAttributeValues: { ':actionId': decodedActionId },
          limit: 1000,
        });
        const replies = siblings.items.filter((c) => c.parentCommentId === decodedCommentId);
        for (const r of replies) {
          try {
            await deleteItem(tableNames.comments, {
              actionId: r.actionId,
              commentId: r.commentId,
            });
            // Also wipe the reply's votes.
            const replyVotes = await queryItems<CommentVoteItem>(tableNames.commentVotes, {
              keyConditionExpression: '#commentId = :commentId',
              expressionAttributeNames: { '#commentId': 'commentId' },
              expressionAttributeValues: { ':commentId': r.commentId },
              limit: 1000,
            });
            for (const rv of replyVotes.items) {
              try {
                await deleteItem(tableNames.commentVotes, {
                  commentId: rv.commentId,
                  stakeAddress: rv.stakeAddress,
                });
              } catch (err) {
                console.warn('comments/delete: failed to delete reply vote row:', err);
              }
            }
          } catch (err) {
            console.warn('comments/delete: failed to delete reply, continuing:', err);
          }
        }
      } catch (err) {
        console.warn('comments/delete: reply cascade failed, continuing:', err);
      }
    }

    await deleteItem(tableNames.comments, {
      actionId: decodedActionId,
      commentId: decodedCommentId,
    });

    // Best-effort audit AFTER the delete succeeds. The cascade above
    // may have removed vote rows + reply rows too; we don't echo those
    // counts here — DDB's stream + PITR captures the full picture if
    // forensic detail is ever needed.
    await writeAuditEvent({
      entityType: 'comment',
      entityId: decodedCommentId,
      eventType: 'comment.deleted',
      actorWallet: authCtx.walletAddress,
      metadata: {
        actionId: decodedActionId,
        isTopLevel: existing.parentCommentId === undefined,
      },
    });

    return noContent();
  } catch (err) {
    console.error('comments/delete handler error:', err);
    return handleError(err);
  }
};
