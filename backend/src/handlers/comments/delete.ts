import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getItem, deleteItem, queryItems, tableNames } from '../../lib/dynamodb';
import type { CommentItem, CommentVoteItem } from '../../lib/types';
import { extractAuthContext, requireOwnerOrRole } from '../../middleware/role-guard';
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

    // Only the comment owner or a lead_drep can delete
    requireOwnerOrRole(authCtx, existing.walletAddress, 'lead_drep');

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

    return noContent();
  } catch (err) {
    console.error('comments/delete handler error:', err);
    return handleError(err);
  }
};
