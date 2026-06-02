import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getItem, transactWrite, tableNames } from '../../lib/dynamodb';
import type { CommitteeMemberItem, CommitteeMembershipItem, UserItem } from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { writeAuditEvent } from '../../lib/audit';
import { committeeMessages } from '../../lib/committeeMessages';
import { normalizeToStakeAddress } from '../../lib/cardanoAddress';
import { created, badRequest, unauthorized, notFound, conflict, handleError } from '../_response';
import { assertCommitteeLead, getStage, loadCommittee, verifyCommitteeResign } from './_committee';

interface AddMemberBody {
  /** Payment OR stake address — normalised to the stake identity server-side. */
  walletAddress: string;
  displayName?: string;
  role?: 'committee_member' | 'trusted_delegator';
  /** Re-specified X of N (N = member count AFTER this add). Required: every
   *  membership change must restate the consensus rule. */
  approvalThreshold: number;
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

    // The signed message binds the RAW address the Chair typed (the frontend
    // signs the same string); we normalise separately for storage.
    const rawInput = body.walletAddress?.trim();
    if (!rawInput) return badRequest('walletAddress is required');
    const stake = normalizeToStakeAddress(rawInput);
    if (!stake) {
      return badRequest('That is not a valid Cardano payment or stake address.');
    }
    const role = body.role ?? 'committee_member';
    if (role !== 'committee_member' && role !== 'trusted_delegator') {
      return badRequest('role must be committee_member or trusted_delegator');
    }

    const committee = await loadCommittee(drepId);
    if (!committee) return notFound('Committee');
    assertCommitteeLead(authCtx, committee);

    if (committee.members?.some((m) => m.walletAddress === stake)) {
      return conflict('That address is already a member of this committee');
    }

    // Every membership change must restate X of N. N here is the NEW size.
    const newMemberCount = (committee.members?.length ?? 0) + 1;
    const X = body.approvalThreshold;
    if (typeof X !== 'number' || !Number.isInteger(X) || X < 1 || X > newMemberCount) {
      return badRequest(
        `approvalThreshold (X) must be a whole number between 1 and ${newMemberCount} (the new committee size).`,
      );
    }

    const message = committeeMessages.member(
      getStage(), drepId, 'add', rawInput, body.mutationNonce, authCtx.walletAddress,
    );
    const reason = await verifyCommitteeResign(authCtx.walletAddress, body, message);
    if (reason) return unauthorized(reason);

    // Active = the new member's stake address has logged into the platform.
    const userRow = await getItem<UserItem>(tableNames.users, { walletAddress: stake, SK: 'PROFILE' });

    const now = new Date().toISOString();
    const member: CommitteeMemberItem = {
      walletAddress: stake,
      joinedAt: now,
      role: role === 'trusted_delegator' ? 'trusted_delegator' : 'committee_member',
      active: Boolean(userRow),
      ...(body.displayName ? { displayName: body.displayName } : {}),
    };
    const membershipRow: CommitteeMembershipItem = {
      walletAddress: stake,
      drepId,
      role: 'member',
      joinedAt: now,
    };

    try {
      // Atomic: claim the wallet's single membership slot (fails if it already
      // belongs to ANY committee), append it to the roster, AND restate X of N.
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
            UpdateExpression:
              'SET #members = list_append(#members, :m), #approvalThreshold = :x, #updatedAt = :now',
            ExpressionAttributeNames: {
              '#members': 'members',
              '#approvalThreshold': 'approvalThreshold',
              '#updatedAt': 'updatedAt',
            },
            ExpressionAttributeValues: { ':m': [member], ':x': X, ':now': now },
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
      metadata: { targetWallet: stake, role: member.role, active: member.active, approvalThreshold: X },
    });

    return created(member);
  } catch (err) {
    console.error('committee/addMember error:', err);
    return handleError(err);
  }
};
