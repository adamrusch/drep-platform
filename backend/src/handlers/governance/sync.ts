import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { extractAuthContext, requireRole } from '../../middleware/role-guard';
import { ok, forbidden, handleError } from '../_response';
import { runGovernanceIntake } from '../../sync/governance-intake';

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    // Break-glass admin tool only. The sync is normally scheduler-driven; this
    // HTTP trigger fans out expensive Koios/IPFS/GitHub work, so it must NOT be
    // reachable by every wallet that ever registered a committee (lead_drep).
    requireRole(authCtx, 'platform_admin');

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
