import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getItem, updateItem, tableNames } from '../../lib/dynamodb';
import type { UserItem } from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { requirePlatformAdmin } from '../../lib/platformAdmin';
import { writeAuditEvent } from '../../lib/audit';
import { ok, badRequest, notFound, conflict, handleError } from '../_response';

/**
 * Grant (POST) or revoke (DELETE) the platform_admin role on a wallet.
 * platform_admin only. POST /admin/roles/{walletAddress}.
 */
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    requirePlatformAdmin(authCtx);

    const targetRaw = event.pathParameters?.['walletAddress'];
    if (!targetRaw) return badRequest('walletAddress path parameter is required');
    const target = decodeURIComponent(targetRaw);

    const method = event.requestContext.http.method;
    const grant = method === 'POST';

    if (!grant && target === authCtx.walletAddress) {
      return conflict('You cannot revoke your own platform_admin role');
    }

    const user = await getItem<UserItem>(tableNames.users, { walletAddress: target, SK: 'PROFILE' });
    if (!user) return notFound('User');

    const roles = new Set(user.roles ?? []);
    if (grant) roles.add('platform_admin');
    else roles.delete('platform_admin');

    await updateItem(
      tableNames.users,
      { walletAddress: target, SK: 'PROFILE' },
      'SET #roles = :roles, #updatedAt = :now',
      { '#roles': 'roles', '#updatedAt': 'updatedAt' },
      { ':roles': Array.from(roles), ':now': new Date().toISOString() },
    );

    await writeAuditEvent({
      entityType: 'platform',
      entityId: target,
      eventType: grant ? 'admin.role.granted' : 'admin.role.revoked',
      actorWallet: authCtx.walletAddress,
      metadata: { targetWallet: target, role: 'platform_admin' },
    });

    return ok({ walletAddress: target, roles: Array.from(roles) });
  } catch (err) {
    console.error('admin/setRole error:', err);
    return handleError(err);
  }
};
