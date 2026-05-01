import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getItem, deleteItem, tableNames } from '../../lib/dynamodb';
import type { CommentItem } from '../../lib/types';
import { extractAuthContext, requireOwnerOrRole } from '../../middleware/role-guard';
import { noContent, badRequest, notFound, internalError, handleError } from '../_response';

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

    const existing = await getItem<CommentItem>(tableNames.comments, {
      actionId: decodeURIComponent(actionId),
      commentId: decodeURIComponent(commentId),
    });

    if (!existing) {
      return notFound('Comment');
    }

    // Only the comment owner or a lead_drep can delete
    requireOwnerOrRole(authCtx, existing.walletAddress, 'lead_drep');

    await deleteItem(tableNames.comments, {
      actionId: decodeURIComponent(actionId),
      commentId: decodeURIComponent(commentId),
    });

    return noContent();
  } catch (err) {
    console.error('comments/delete handler error:', err);
    return handleError(err);
  }
};
