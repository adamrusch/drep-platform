import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { transactWrite, tableNames } from '../../lib/dynamodb';
import type { CommitteeMemberItem, CommitteeMembershipItem } from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { writeAuditEvent } from '../../lib/audit';
import { committeeMessages } from '../../lib/committeeMessages';
import { created, badRequest, unauthorized, notFound, conflict, handleError } from '../_response';
import { assertCommitteeLead, getStage, loadCommittee, verifyCommitteeResign } from './_committee';

interface AddMemberBody {
  walletAddress: string;
  displayName?: string;
  role?: 'committee_member' | 'trusted_delegator';
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
    if (!drepId) return badRequest('drepId path parameter is required');
    if (!event.body) return badRequest('Request body is required');

    let body: AddMemberBody;
    try {
      body = JSON.parse(event.body) as AddMemberBody;
    } catch {
      return badRequest('Invalid JSON body');
    }

    const target = body.walletAddress?.trim();
    if (!target) return badRequest('walletAddress is required');
    const role = body.role ?? 'committee_member';
    if (role !== 'committee_member' && role !== 'trusted_delegator') {
      return badRequest('role must be committee_member or trusted_delegator');
    }

    const committee = await loadCommittee(drepId);
    if (!committee) return notFound('Committee');
    assertCommitteeLead(authCtx, committee);

    if (committee.members?.some((m) => m.walletAddress === target)) {
      return conflict('That wallet is already a member of this committee');
    }

    const message = committeeMessages.member(
      getStage(), drepId, 'add', target, body.mutationNonce, authCtx.walletAddress,
    );
    const reason = await verifyCommitteeResign(authCtx.walletAddress, body, message);
    if (reason) return unauthorized(reason);

    const now = new Date().toISOString();
    const member: CommitteeMemberItem = {
      walletAddress: target,
      joinedAt: now,
      role: role === 'trusted_delegator' ? 'trusted_delegator' : 'committee_member',
      ...(body.displayName ? { displayName: body.displayName } : {}),
    };
    const membershipRow: CommitteeMembershipItem = {
      walletAddress: target,
      drepId,
      role: 'member',
      joinedAt: now,
    };

    try {
      // Atomic: claim the wallet's single membership slot (fails if it already
      // belongs to ANY committee) AND append it to this committee's roster.
      await transactWrite([
        {
          Put: {
            TableName: tableNames.committeeMembership,
            Item: membershipRow as unknown as Record<string, unknown>,
            ConditionExpression: 'attribute_not_exists(walletAddress)',
          },
        },
        {
          Update: {
            TableName: tableNames.drepCommittees,
            Key: { drepId, SK: 'COMMITTEE' },
            UpdateExpression: 'SET #members = list_append(#members, :m), #updatedAt = :now',
            ExpressionAttributeNames: { '#members': 'members', '#updatedAt': 'updatedAt' },
            ExpressionAttributeValues: { ':m': [member], ':now': now },
          },
        },
      ]);
    } catch (err) {
      if (err && typeof err === 'object' && (err as { name?: string }).name === 'TransactionCanceledException') {
        return conflict('That wallet already belongs to a DRep committee');
      }
      throw err;
    }

    await writeAuditEvent({
      entityType: 'drep_committee',
      entityId: drepId,
      eventType: 'committee.member.added',
      actorWallet: authCtx.walletAddress,
      metadata: { targetWallet: target, role: member.role },
    });

    return created(member);
  } catch (err) {
    console.error('committee/addMember error:', err);
    return handleError(err);
  }
};
