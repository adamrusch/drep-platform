import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getItem, tableNames } from '../../lib/dynamodb';
import type { UserItem } from '../../lib/types';
import { ok, badRequest, notFound, internalError } from '../_response';

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  try {
    const walletAddress = event.pathParameters?.['walletAddress'];
    if (!walletAddress) {
      return badRequest('walletAddress path parameter is required');
    }

    const user = await getItem<UserItem>(tableNames.users, {
      walletAddress: decodeURIComponent(walletAddress),
      SK: 'PROFILE',
    });

    if (!user) {
      return notFound('User profile');
    }

    // Strip sensitive fields
    const {
      sessionTokenHash: _s,
      sessionExpiry: _e,
      ...publicProfile
    } = user;

    // Public profile is shareable across all viewers — safe to edge-cache.
    // Auth-bound state lives on /auth/me; this endpoint never returns
    // session-specific content even when the caller is signed in.
    return ok(publicProfile, { 'Cache-Control': 'public, max-age=30, s-maxage=30' });
  } catch (err) {
    console.error('profile/get handler error:', err);
    return internalError('Failed to fetch profile');
  }
};
