/**
 * GET /auth/me
 *
 * Returns the authenticated user's profile + roles + drepId, derived from
 * the JWT cookie. The frontend calls this on mount to determine sign-in
 * state and roles for conditional rendering.
 *
 * Sensitive fields (`sessionTokenHash`, `sessionExpiry`) are stripped before
 * the response is serialized.
 *
 * Cache headers explicitly forbid sharing: this endpoint MUST NOT be cached
 * by any intermediate proxy or CloudFront. The `/auth/*` CloudFront behavior
 * is already on a no-cache passthrough; the explicit `private, no-store`
 * header makes accidental sharing a bug instead of a silent leak.
 */
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getItem, tableNames } from '../../lib/dynamodb';
import type { UserItem } from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { ok, unauthorized, notFound, internalError } from '../_response';

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);

    const user = await getItem<UserItem>(tableNames.users, {
      walletAddress: authCtx.walletAddress,
      SK: 'PROFILE',
    });

    if (!user) {
      return notFound('User');
    }

    // Strip sensitive fields before returning
    const { sessionTokenHash: _sessionTokenHash, sessionExpiry: _sessionExpiry, ...safeUser } = user;

    return ok(
      {
        ...safeUser,
        walletAddress: authCtx.walletAddress,
        roles: authCtx.roles,
        drepId: authCtx.drepId,
      },
      // Defense in depth: this endpoint is auth-bound and MUST NOT be
      // shared between users. The CloudFront distribution in front of
      // the API has /auth/* on a no-cache behavior, but emitting an
      // explicit `private, no-store` header makes it a bug if any
      // shared cache (intermediate proxy, browser bf-cache) ever picks
      // it up.
      {
        'Cache-Control': 'private, no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
      },
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'AuthorizationError') {
      return unauthorized(err.message);
    }
    console.error('me handler error:', err);
    return internalError('Failed to fetch user');
  }
};
