import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { generateMutationNonce } from '../../lib/auth';
import { extractAuthContext } from '../../middleware/role-guard';
import { ok, unauthorized, internalError } from '../_response';

/**
 * POST /auth/mutation-nonce
 *
 * Issues a single-use mutation nonce bound to the authenticated wallet.
 * The frontend signs the returned `message` with CIP-30 signData and submits
 * `{ mutationNonce, mutationSignature, mutationKey }` alongside any mutating
 * write (e.g. POST /comments/{actionId}). The nonce is consumed atomically
 * server-side on validation.
 */
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    const { nonce, message, expiresAt } = await generateMutationNonce(authCtx.walletAddress);

    return ok({ nonce, message, expiresAt });
  } catch (err) {
    if (err instanceof Error && err.name === 'AuthorizationError') {
      return unauthorized(err.message);
    }
    console.error('mutationNonce handler error:', err);
    return internalError('Failed to issue mutation nonce');
  }
};
