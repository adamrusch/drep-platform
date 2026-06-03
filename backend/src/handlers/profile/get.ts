import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getItem, tableNames } from '../../lib/dynamodb';
import type { UserItem } from '../../lib/types';
import { resolveIdentity } from '../../lib/identity';
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

    // DRep status: whether this wallet is a registered DRep plus the effective
    // display name (profile name → DRep name → none). The profile page uses
    // these to show a DRep badge + link.
    const identity = await resolveIdentity(decodeURIComponent(walletAddress));

    // EXPLICIT public allow-list — never rest-spread the user row. The row also
    // carries `roles`, `tokenVersion`, `delegationHistory`, session hashes, etc.
    // which must NOT be exposed on this unauthenticated, edge-cached endpoint.
    // (Delegation history has its own dedicated endpoint.) Auth-bound state
    // lives on /auth/me; this endpoint is shareable across all viewers.
    return ok(
      {
        walletAddress: decodeURIComponent(walletAddress),
        ...(user.displayName ? { displayName: user.displayName } : {}),
        ...(user.bio ? { bio: user.bio } : {}),
        ...(user.socialLinks ? { socialLinks: user.socialLinks } : {}),
        ...(user.createdAt ? { createdAt: user.createdAt } : {}),
        isDRep: identity.isDRep,
        ...(identity.drepId ? { drepId: identity.drepId } : {}),
        ...(identity.drepName ? { drepName: identity.drepName } : {}),
        ...(identity.displayName ? { resolvedDisplayName: identity.displayName } : {}),
      },
      { 'Cache-Control': 'public, max-age=30, s-maxage=30' },
    );
  } catch (err) {
    console.error('profile/get handler error:', err);
    return internalError('Failed to fetch profile');
  }
};
