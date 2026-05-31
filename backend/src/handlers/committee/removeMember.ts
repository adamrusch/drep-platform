import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { transactWrite, tableNames } from '../../lib/dynamodb';
import { extractAuthContext } from '../../middleware/role-guard';
import { writeAuditEvent } from '../../lib/audit';
import { committeeMessages } from '../../lib/committeeMessages';
import { ok, badRequest, unauthorized, notFound, conflict, handleError } from '../_response';
import { assertCommitteeLead, getStage, loadCommittee, verifyCommitteeResign } from './_committee';

interface RemoveMemberBody {
  mutationNonce: string;
  mutationSignature: string;
  mutationKey: string;
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    const drepId = event.pathParameters?.['drepId'];
    const targetRaw = event.pathParameters?.['walletAddress'];
    if (!drepId || !targetRaw) return badRequest('drepId and walletAddress path parameters are required');
    const target = decodeURIComponent(targetRaw);
    if (!event.body) return badRequest('Request body (re-sign) is required');

    let body: RemoveMemberBody;
    try {
      body = JSON.parse(event.body) as RemoveMemberBody;
    } catch {
      return badRequest('Invalid JSON body');
    }

    const committee = await loadCommittee(drepId);
    if (!committee) return notFound('Committee');
    assertCommitteeLead(authCtx, committee);

    if (target === committee.leadWallet) {
      return conflict('The lead DRep cannot be removed from their own committee');
    }
    const idx = committee.members?.findIndex((m) => m.walletAddress === target) ?? -1;
    if (idx < 0) return notFound('Committee member');

    const message = committeeMessages.member(
      getStage(), drepId, 'remove', target, body.mutationNonce, authCtx.walletAddress,
    );
    const reason = await verifyCommitteeResign(authCtx.walletAddress, body, message);
    if (reason) return unauthorized(reason);

    const now = new Date().toISOString();
    const newMembers = (committee.members ?? []).filter((m) => m.walletAddress !== target);

    // Atomic: rewrite the roster (read-modify-write — DynamoDB can't drop a
    // list element by value) AND release the wallet's membership slot.
    await transactWrite([
      {
        Update: {
          TableName: tableNames.drepCommittees,
          Key: { drepId, SK: 'COMMITTEE' },
          UpdateExpression: 'SET #members = :m, #updatedAt = :now',
          ConditionExpression: 'attribute_exists(drepId)',
          ExpressionAttributeNames: { '#members': 'members', '#updatedAt': 'updatedAt' },
          ExpressionAttributeValues: { ':m': newMembers, ':now': now },
        },
      },
      {
        Delete: {
          TableName: tableNames.committeeMembership,
          Key: { walletAddress: target },
        },
      },
    ]);

    await writeAuditEvent({
      entityType: 'drep_committee',
      entityId: drepId,
      eventType: 'committee.member.removed',
      actorWallet: authCtx.walletAddress,
      metadata: { targetWallet: target },
    });

    return ok({ removed: target, members: newMembers });
  } catch (err) {
    console.error('committee/removeMember error:', err);
    return handleError(err);
  }
};
