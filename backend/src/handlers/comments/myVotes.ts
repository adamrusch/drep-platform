/**
 * Return the authenticated caller's vote (up / down / none) on every
 * comment under one governance action. The Public Comments tab fires
 * this in parallel with the anonymous list endpoint so it can render
 * the user's own up/down button state on first paint.
 *
 * Why separate from `GET /comments/{actionId}`:
 *   - The list endpoint is CACHEABLE (the response is the same for every
 *     viewer). Adding a per-user vote map would bust the cache by viewer
 *     identity, costing us the edge-cache speedup on the hot read path.
 *   - This endpoint is auth-only and serves a small response (one entry
 *     per comment the caller has voted on). Tiny, fast, uncacheable.
 */
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { queryItems, tableNames } from '../../lib/dynamodb';
import type { CommentItem, CommentVoteItem } from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { ok, badRequest, handleError } from '../_response';

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    const actionId = event.pathParameters?.['actionId'];
    if (!actionId) {
      return badRequest('actionId path parameter is required');
    }

    const decodedActionId = decodeURIComponent(actionId);

    // Two-step lookup because vote rows are keyed by `commentId`, not
    // `actionId` — we first list every commentId under this action, then
    // do per-comment GetItem against `comment_votes`.
    //
    // Could go via the existing `walletAddress-index` GSI on `comments`,
    // but that returns comments-by-author rather than what we want
    // (votes-by-this-user-across-this-action's-comments). The two-step
    // is N+1 Gets but each is point-lookup-fast and N is ~50 in practice.
    const comments = await queryItems<CommentItem>(tableNames.comments, {
      keyConditionExpression: '#actionId = :actionId',
      expressionAttributeNames: { '#actionId': 'actionId' },
      expressionAttributeValues: { ':actionId': decodedActionId },
      limit: 1000,
    });

    const votesByCommentId: Record<string, 'up' | 'down'> = {};
    // Parallel point-lookups — fan-out within Lambda's network budget.
    await Promise.all(
      comments.items.map(async (c) => {
        try {
          const row = await queryItems<CommentVoteItem>(tableNames.commentVotes, {
            keyConditionExpression: '#commentId = :commentId AND #stakeAddress = :stakeAddress',
            expressionAttributeNames: {
              '#commentId': 'commentId',
              '#stakeAddress': 'stakeAddress',
            },
            expressionAttributeValues: {
              ':commentId': c.commentId,
              ':stakeAddress': authCtx.walletAddress,
            },
            limit: 1,
          });
          const v = row.items[0];
          if (v) votesByCommentId[c.commentId] = v.vote === 'up' ? 'up' : 'down';
        } catch (err) {
          // Best-effort — a failure here just means the UI shows no vote
          // state for this one comment, not the end of the world.
          console.warn('comments/myVotes: per-comment lookup failed:', err);
        }
      }),
    );

    return ok({ votes: votesByCommentId });
  } catch (err) {
    console.error('comments/myVotes handler error:', err);
    return handleError(err);
  }
};
