import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { extractAuthContext, requireRole } from '../../middleware/role-guard';
import { ok, forbidden, internalError, handleError } from '../_response';
import { runGovernanceIntake } from '../../sync/governance-intake';

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    requireRole(authCtx, 'lead_drep');

    const result = await runGovernanceIntake();

    return ok({
      synced: result.synced,
      skipped: result.skipped,
      errors: result.errors,
      syncedAt: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AuthorizationError') {
      return forbidden(err.message);
    }
    console.error('governance/sync handler error:', err);
    return handleError(err);
  }
};
