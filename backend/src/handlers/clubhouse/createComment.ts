import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ulid } from 'ulid';
import { getItem, putItem, tableNames } from '../../lib/dynamodb';
import type { ClubhousePostItem, ClubhouseCommentItem } from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { ok, badRequest, notFound, handleError } from '../_response';

interface CreateClubhouseCommentBody {
  body: string;
  /** Optional — when present, this comment is a reply to the named
   *  comment. Clubhouse rules allow 2 levels of nesting
   *  (top-level → reply → sub-reply); this is one level deeper than
   *  Public Comments. 3-deep is rejected with 400. */
  parentCommentId?: string;
}

/**
 * Compute the nesting depth of a chain ending at the given comment.
 *   - depth 0 → top-level (no `parentCommentId`)
 *   - depth 1 → reply to a top-level comment
 *   - depth 2 → sub-reply to a reply
 *
 * The Clubhouse surface caps depth at 2. A NEW reply with
 * `parentCommentId === X` would land at `depthOf(X) + 1` — so we reject
 * if `depthOf(parent) >= 2`. Implementation walks at most 2 hops, since
 * any deeper chain would already have been rejected at write time.
 */
function depthOfChain(
  comments: ClubhouseCommentItem[],
  commentId: string,
): number {
  // Build a lookup once — clubhouse posts cap at a handful of comments
  // typically; even with 100s of comments the O(N) scan is negligible
  // compared to the DDB Get this avoids.
  const byId = new Map<string, ClubhouseCommentItem>();
  for (const c of comments) byId.set(c.commentId, c);
  let depth = 0;
  let cursor = byId.get(commentId);
  // Cap the walk at 3 hops defensively — if persisted data is corrupted
  // and we end up with a cycle, we don't want an infinite loop. Any
  // legitimate row should resolve in <= 2 hops.
  for (let i = 0; i < 3 && cursor?.parentCommentId; i++) {
    depth += 1;
    cursor = byId.get(cursor.parentCommentId);
    if (!cursor) break;
  }
  return depth;
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    const drepId = event.pathParameters?.['drepId'];
    const postId = event.pathParameters?.['postId'];

    if (!drepId || !postId) {
      return badRequest('drepId and postId path parameters are required');
    }

    if (!event.body) {
      return badRequest('Request body is required');
    }

    let reqBody: CreateClubhouseCommentBody;
    try {
      reqBody = JSON.parse(event.body) as CreateClubhouseCommentBody;
    } catch {
      return badRequest('Invalid JSON body');
    }

    if (!reqBody.body || reqBody.body.trim().length === 0) {
      return badRequest('body is required');
    }
    if (reqBody.body.length > 5_000) {
      return badRequest('body exceeds maximum length of 5,000 characters');
    }
    if (reqBody.parentCommentId !== undefined && typeof reqBody.parentCommentId !== 'string') {
      return badRequest('parentCommentId must be a string when provided');
    }

    const post = await getItem<ClubhousePostItem>(tableNames.clubhousePosts, {
      drepId: decodeURIComponent(drepId),
      postId: decodeURIComponent(postId),
    });

    if (!post) {
      return notFound('Clubhouse post');
    }

    // ---- Depth guard (Clubhouse: 2 levels) ----
    // Replies on the Clubhouse surface allow ONE level deeper than the
    // Public Comments surface — top-level → reply → sub-reply. A reply
    // pointing at a comment whose chain depth is already 2 would create
    // a depth-3 comment, which we reject with 400.
    //
    // The post stores comments in an inline `comments[]` array, so we
    // can resolve the parent chain entirely from the in-memory post —
    // no extra DDB Gets needed.
    if (reqBody.parentCommentId !== undefined) {
      const parent = post.comments.find(
        (c) => c.commentId === reqBody.parentCommentId,
      );
      if (!parent) {
        return notFound('Parent comment');
      }
      const parentDepth = depthOfChain(post.comments, parent.commentId);
      // A new reply targeting `parent` lands at depth `parentDepth + 1`.
      // We allow depths 1 and 2; reject anything that would become 3.
      if (parentDepth >= 2) {
        return badRequest('Replies nested deeper than 2 levels are not allowed');
      }
    }

    const commentId = ulid();
    const now = new Date().toISOString();

    const newComment: ClubhouseCommentItem = {
      commentId,
      authorWallet: authCtx.walletAddress,
      body: reqBody.body.trim(),
      createdAt: now,
      ...(reqBody.parentCommentId ? { parentCommentId: reqBody.parentCommentId } : {}),
    };

    const updatedPost: ClubhousePostItem = {
      ...post,
      comments: [...post.comments, newComment],
      updatedAt: now,
    };

    await putItem(tableNames.clubhousePosts, updatedPost as unknown as Record<string, unknown>);

    return ok(newComment);
  } catch (err) {
    console.error('clubhouse/createComment handler error:', err);
    return handleError(err);
  }
};
