import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getItem, putItem, tableNames } from '../../lib/dynamodb';
import type { DRepCommitteeItem } from '../../lib/types';
import { extractAuthContext, requireRole } from '../../middleware/role-guard';
import { ok, badRequest, forbidden, notFound, internalError, handleError } from '../_response';

interface UpdateDRepBody {
  committeeName?: string;
  description?: string;
  onChainMetadata?: Record<string, unknown>;
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    const drepId = event.pathParameters?.['drepId'];

    if (!drepId) {
      return badRequest('drepId path parameter is required');
    }

    requireRole(authCtx, 'lead_drep', 'committee_member');

    if (!event.body) {
      return badRequest('Request body is required');
    }

    let body: UpdateDRepBody;
    try {
      body = JSON.parse(event.body) as UpdateDRepBody;
    } catch {
      return badRequest('Invalid JSON body');
    }

    const existing = await getItem<DRepCommitteeItem>(tableNames.drepCommittees, {
      drepId: decodeURIComponent(drepId),
      SK: 'COMMITTEE',
    });

    if (!existing) {
      return notFound('DRep committee');
    }

    // Only the lead wallet can update
    if (existing.leadWallet !== authCtx.walletAddress) {
      return forbidden('Only the lead DRep can update the committee');
    }

    const updated: DRepCommitteeItem = {
      ...existing,
      ...(body.committeeName ? { committeeName: body.committeeName.trim() } : {}),
      ...(body.description ? { description: body.description.trim() } : {}),
      ...(body.onChainMetadata !== undefined ? { onChainMetadata: body.onChainMetadata } : {}),
      updatedAt: new Date().toISOString(),
    };

    await putItem(tableNames.drepCommittees, updated as unknown as Record<string, unknown>);

    return ok(updated);
  } catch (err) {
    console.error('drep/update handler error:', err);
    return handleError(err);
  }
};
