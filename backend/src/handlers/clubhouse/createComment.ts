import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ulid } from 'ulid';
import { getItem, putItem, tableNames } from '../../lib/dynamodb';
import type { ClubhousePostItem, ClubhouseCommentItem } from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { ok, badRequest, notFound, internalError, handleError } from '../_response';

interface CreateClubhouseCommentBody {
  body: string;
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

    const post = await getItem<ClubhousePostItem>(tableNames.clubhousePosts, {
      drepId: decodeURIComponent(drepId),
      postId: decodeURIComponent(postId),
    });

    if (!post) {
      return notFound('Clubhouse post');
    }

    const commentId = ulid();
    const now = new Date().toISOString();

    const newComment: ClubhouseCommentItem = {
      commentId,
      authorWallet: authCtx.walletAddress,
      body: reqBody.body.trim(),
      createdAt: now,
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
