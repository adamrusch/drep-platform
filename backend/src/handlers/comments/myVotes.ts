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
import { batchGetItems, queryItems, tableNames } from '../../lib/dynamodb';
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
    // look up the caller's vote on each.
    //
    // Could go via the existing `walletAddress-index` GSI on `comments`,
    // but that returns comments-by-author rather than what we want
    // (votes-by-this-user-across-this-action's-comments). The two-step
    // is unavoidable; the single round-trip below replaces the previous
    // N parallel Queries with one BatchGetItem call.
    const comments = await queryItems<CommentItem>(tableNames.comments, {
      keyConditionExpression: '#actionId = :actionId',
      expressionAttributeNames: { '#actionId': 'actionId' },
      expressionAttributeValues: { ':actionId': decodedActionId },
      limit: 1000,
    });

    const votesByCommentId: Record<string, 'up' | 'down'> = {};
    if (comments.items.length > 0) {
      // Single BatchGet against the composite-key `comment_votes` table
      // (PK=commentId, SK=stakeAddress). Replaces the previous Promise.all
      // of N separate Queries — at 50 comments under a popular action
      // that's 50 round-trips → 1 round-trip + same payload. The
      // `batchGetItems` helper chunks at 100 keys per request, retries
      // UnprocessedKeys with linear backoff, and returns only the rows
      // that exist (missing keys are simply absent).
      //
      // Failure semantics match the previous implementation: any error
      // bubbles to `handleError` and the caller sees a 5xx. We do NOT
      // partial-resolve on per-key failure (BatchGet doesn't expose that
      // granularity), but the retry logic in the helper already covers
      // transient DDB throttling — which was the failure mode the
      // previous per-Query `console.warn` was actually catching.
      const keys = comments.items.map((c) => ({
        commentId: c.commentId,
        stakeAddress: authCtx.walletAddress,
      }));
      const voteRows = await batchGetItems<CommentVoteItem>(tableNames.commentVotes, keys);
      for (const v of voteRows) {
        if (typeof v.commentId !== 'string') continue;
        // Vote string is `'up' | 'down'` per the type, but we defensively
        // coerce: any unrecognized value falls back to 'down' to preserve
        // the prior handler's behavior exactly.
        votesByCommentId[v.commentId] = v.vote === 'up' ? 'up' : 'down';
      }
    }

    return ok({ votes: votesByCommentId });
  } catch (err) {
    console.error('comments/myVotes handler error:', err);
    return handleError(err);
  }
};
