import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { extractAuthContext } from '../../middleware/role-guard';
import { requirePlatformAdmin } from '../../lib/platformAdmin';
import { clearSafetyMode } from '../../lib/safetyMode';
import { writeAuditEvent } from '../../lib/audit';
import { ok, handleError } from '../_response';

/** Clear the Sybil safety-mode latch early (POST /admin/safety-mode/clear). */
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    requirePlatformAdmin(authCtx);

    await clearSafetyMode(authCtx.walletAddress, Date.now());

    await writeAuditEvent({
      entityType: 'platform',
      entityId: 'SAFETY_MODE',
      eventType: 'admin.safety_mode.cleared',
      actorWallet: authCtx.walletAddress,
      metadata: {},
    });

    return ok({ cleared: true });
  } catch (err) {
    console.error('admin/clearSafetyMode error:', err);
    return handleError(err);
  }
};
