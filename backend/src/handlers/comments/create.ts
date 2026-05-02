import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ulid } from 'ulid';
import { putItem, getItem, tableNames } from '../../lib/dynamodb';
import type { CommentItem } from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import {
  validateMutationNonce,
  verifyWalletSignature,
  buildMutationMessage,
} from '../../lib/auth';
import { created, badRequest, unauthorized, notFound, internalError, handleError } from '../_response';

interface CreateCommentBody {
  body: string;
  isPublic: boolean;
  mutationNonce: string;
  mutationSignature: string;
  mutationKey: string;
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    const actionId = event.pathParameters?.['actionId'];

    if (!actionId) {
      return badRequest('actionId path parameter is required');
    }

    if (!event.body) {
      return badRequest('Request body is required');
    }

    let body: CreateCommentBody;
    try {
      body = JSON.parse(event.body) as CreateCommentBody;
    } catch {
      return badRequest('Invalid JSON body');
    }

    if (!body.body || typeof body.body !== 'string' || body.body.trim().length === 0) {
      return badRequest('body is required and must be non-empty');
    }
    if (body.body.length > 10_000) {
      return badRequest('body exceeds maximum length of 10,000 characters');
    }
    if (typeof body.isPublic !== 'boolean') {
      return badRequest('isPublic must be a boolean');
    }
    if (!body.mutationNonce || !body.mutationSignature || !body.mutationKey) {
      return badRequest('mutationNonce, mutationSignature, and mutationKey are required');
    }

    // Validate mutation nonce
    const nonceResult = await validateMutationNonce(body.mutationNonce, authCtx.walletAddress);
    if (!nonceResult.valid) {
      return unauthorized(nonceResult.reason ?? 'Invalid mutation nonce');
    }

    // Verify mutation signature. `buildMutationMessage` is the single source
    // of truth for the signed-message format — the nonce issuer uses the
    // same helper, so the byte string we verify here matches exactly what
    // the wallet signed.
    const mutationMessage = buildMutationMessage(body.mutationNonce, authCtx.walletAddress);
    const sigResult = verifyWalletSignature(authCtx.walletAddress, mutationMessage, {
      signature: body.mutationSignature,
      key: body.mutationKey,
    });
    if (!sigResult.valid) {
      return unauthorized(sigResult.reason ?? 'Invalid mutation signature');
    }

    // Verify governance action exists
    const actionExists = await getItem(tableNames.governanceActions, {
      actionId: decodeURIComponent(actionId),
      SK: 'ACTION',
    });
    if (!actionExists) {
      return notFound('Governance action');
    }

    const isDRep = authCtx.roles.includes('lead_drep') || authCtx.roles.includes('committee_member');
    const now = new Date().toISOString();
    const commentId = ulid();

    const commentItem: CommentItem = {
      actionId: decodeURIComponent(actionId),
      commentId,
      walletAddress: authCtx.walletAddress,
      body: body.body.trim(),
      isPublic: body.isPublic,
      isDRep,
      createdAt: now,
      updatedAt: now,
    };

    await putItem(tableNames.comments, commentItem as unknown as Record<string, unknown>);

    return created(commentItem);
  } catch (err) {
    console.error('comments/create handler error:', err);
    return handleError(err);
  }
};
