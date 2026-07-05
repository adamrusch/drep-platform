import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { extractAuthContext } from '../../middleware/role-guard';
import { requirePlatformAdmin } from '../../lib/platformAdmin';
import { getSafetyMode, isSafetyModeActive } from '../../lib/safetyMode';
import { nowSec } from '../../lib/time';
import { ok, handleError } from '../_response';

/** Safety-mode status for the admin panel (GET /admin/safety-mode). */
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    requirePlatformAdmin(authCtx);

    const item = await getSafetyMode();
    const active = isSafetyModeActive(item, nowSec());

    return ok({
      active,
      triggeredAt: item?.triggeredAt ?? null,
      expiresAt: item?.expiresAt ?? null,
      triggeredByCount: item?.triggeredByCount ?? null,
    });
  } catch (err) {
    console.error('admin/getSafetyMode error:', err);
    return handleError(err);
  }
};
