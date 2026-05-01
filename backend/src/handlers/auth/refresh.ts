import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { issueJWT, buildSetCookieHeader } from '../../lib/auth';
import { extractAuthContext } from '../../middleware/role-guard';
import { ok, unauthorized, internalError } from '../_response';

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);

    const { token, expiresAt } = await issueJWT(
      authCtx.walletAddress,
      authCtx.roles,
      'normal',
      authCtx.drepId,
    );

    const cookieHeader = buildSetCookieHeader(token, 'normal');

    return ok(
      {
        walletAddress: authCtx.walletAddress,
        roles: authCtx.roles,
        sessionType: 'normal',
        expiresAt,
      },
      [cookieHeader],
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'AuthorizationError') {
      return unauthorized(err.message);
    }
    console.error('refresh handler error:', err);
    return internalError('Failed to refresh session');
  }
};
