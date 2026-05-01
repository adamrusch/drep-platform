import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ulid } from 'ulid';
import { putItem, getItem, updateItem, tableNames } from '../../lib/dynamodb';
import type { DRepCommitteeItem, CommitteeMemberItem } from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { created, badRequest, conflict, internalError, handleError } from '../_response';

interface RegisterDRepBody {
  committeeName: string;
  description: string;
  onChainMetadata?: Record<string, unknown>;
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);

    if (!event.body) {
      return badRequest('Request body is required');
    }

    let body: RegisterDRepBody;
    try {
      body = JSON.parse(event.body) as RegisterDRepBody;
    } catch {
      return badRequest('Invalid JSON body');
    }

    if (!body.committeeName || body.committeeName.trim().length === 0) {
      return badRequest('committeeName is required');
    }
    if (!body.description || body.description.trim().length === 0) {
      return badRequest('description is required');
    }

    // Check if this wallet already leads a committee
    const existing = await getItem(tableNames.drepCommittees, {
      drepId: authCtx.walletAddress,
      SK: 'COMMITTEE',
    });
    if (existing) {
      return conflict('You have already registered a DRep committee');
    }

    const drepId = ulid();
    const now = new Date().toISOString();

    const leadMember: CommitteeMemberItem = {
      walletAddress: authCtx.walletAddress,
      joinedAt: now,
      role: 'lead_drep',
    };

    const committee: DRepCommitteeItem = {
      drepId,
      SK: 'COMMITTEE',
      leadWallet: authCtx.walletAddress,
      committeeName: body.committeeName.trim(),
      description: body.description.trim(),
      onChainMetadata: body.onChainMetadata,
      members: [leadMember],
      createdAt: now,
      updatedAt: now,
    };

    await putItem(tableNames.drepCommittees, committee as unknown as Record<string, unknown>);

    // Elevate user role to lead_drep
    const rolesSet = new Set([...authCtx.roles, 'lead_drep']);
    await updateItem(
      tableNames.users,
      { walletAddress: authCtx.walletAddress, SK: 'PROFILE' },
      'SET #roles = :roles, #drepId = :drepId, #updatedAt = :now',
      { '#roles': 'roles', '#drepId': 'drepId', '#updatedAt': 'updatedAt' },
      { ':roles': Array.from(rolesSet), ':drepId': drepId, ':now': now },
    );

    return created(committee);
  } catch (err) {
    console.error('drep/register handler error:', err);
    return handleError(err);
  }
};
