import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getItem, deleteItem, tableNames } from '../../lib/dynamodb';
import type { ClubhousePostItem } from '../../lib/types';
import { extractAuthContext, requireOwnerOrRole } from '../../middleware/role-guard';
import { noContent, badRequest, notFound, internalError, handleError } from '../_response';

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

    const existing = await getItem<ClubhousePostItem>(tableNames.clubhousePosts, {
      drepId: decodeURIComponent(drepId),
      postId: decodeURIComponent(postId),
    });

    if (!existing) {
      return notFound('Clubhouse post');
    }

    requireOwnerOrRole(authCtx, existing.authorWallet, 'lead_drep');

    await deleteItem(tableNames.clubhousePosts, {
      drepId: decodeURIComponent(drepId),
      postId: decodeURIComponent(postId),
    });

    return noContent();
  } catch (err) {
    console.error('clubhouse/deletePost handler error:', err);
    return handleError(err);
  }
};
