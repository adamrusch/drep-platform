import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ulid } from 'ulid';
import { putItem, queryItems, updateItem, tableNames } from '../../lib/dynamodb';
import type { DRepCommitteeItem, CommitteeMemberItem } from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { writeAuditEvent } from '../../lib/audit';
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

    // Reject if this wallet already leads a committee.
    //
    // NB: committees are keyed by a generated ULID `drepId`, NOT by the lead's
    // wallet — so the dedup check MUST go through the `leadWallet-index` GSI.
    // (The previous getItem on {drepId: walletAddress} was a no-op: that PK is
    // never written, so it never matched and a wallet could register unlimited
    // committees.) Full "one committee per wallet, total" — including
    // membership on someone else's committee — is enforced atomically via the
    // dedicated committee_membership table in a later Phase 2 step.
    const existingLed = await queryItems(tableNames.drepCommittees, {
      indexName: 'leadWallet-index',
      keyConditionExpression: 'leadWallet = :w',
      expressionAttributeValues: { ':w': authCtx.walletAddress },
      limit: 1,
    });
    if (existingLed.count > 0) {
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

    // Best-effort audit AFTER the committee + role elevation land.
    // This is one of the load-bearing events for governance forensics —
    // it ties a wallet to the moment it became a lead DRep, which
    // gates committee-scoped privileges everywhere else.
    await writeAuditEvent({
      entityType: 'drep_committee',
      entityId: drepId,
      eventType: 'drep.committee.registered',
      actorWallet: authCtx.walletAddress,
      metadata: {
        leadWallet: authCtx.walletAddress,
      },
    });

    return created(committee);
  } catch (err) {
    console.error('drep/register handler error:', err);
    return handleError(err);
  }
};
