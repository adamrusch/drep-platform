import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getItem, transactWrite, tableNames } from '../../lib/dynamodb';
import type {
  CommitteeInviteItem,
  CommitteeMembershipItem,
  UserItem,
} from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { writeAuditEvent } from '../../lib/audit';
import { committeeMessages } from '../../lib/committeeMessages';
import { normalizeToStakeAddress } from '../../lib/cardanoAddress';
import { created, badRequest, unauthorized, notFound, conflict, handleError } from '../_response';
import {
  assertCommitteeLead,
  getStage,
  inviteSk,
  loadCommittee,
  loadInvite,
  verifyCommitteeResign,
} from './_committee';

interface AddMemberBody {
  /** Payment OR stake address — normalised to the stake identity server-side. */
  walletAddress: string;
  displayName?: string;
  role?: 'committee_member' | 'trusted_delegator';
  /** Re-specified X of N. Under decision B, N is the new INTENDED size
   *  (current intendedMemberCount + 1) — the Chair's intended threshold over
   *  the new intended roster. Required: every membership change must restate
   *  the consensus rule. */
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

    // Already an accepted member?
    if (committee.members?.some((m) => m.walletAddress === stake)) {
      return conflict('That address is already a member of this committee');
    }

    // Already invited (any status) to THIS committee? Surface a clear 409 —
    // the Chair can revoke a pending invite first if they want to re-issue.
    const existingInvite = await loadInvite(drepId, stake);
    if (existingInvite) {
      if (existingInvite.status === 'pending') {
        return conflict('That address has already been invited to this committee (pending).');
      }
      if (existingInvite.status === 'accepted') {
        return conflict('That address is already a member of this committee');
      }
      // For rejected / revoked: also surface a clear message — the Chair
      // would need an admin pathway to re-invite. (Out of scope for F1.)
      return conflict(
        `That address has already declined or had a previous invitation revoked (status: ${existingInvite.status}). Re-inviting them is not yet supported.`,
      );
    }

    // Decision B — every membership change restates X over the new INTENDED N
    // (chair + every invited address, regardless of accept progress). When the
    // committee row is missing `intendedMemberCount` (legacy row), fall back
    // to the current accepted count, which preserves the pre-invitation
    // behaviour for rows that pre-date the feature.
    const currentIntendedN = committee.intendedMemberCount ?? committee.members?.length ?? 0;
    const newIntendedN = currentIntendedN + 1;
    const X = body.approvalThreshold;
    if (typeof X !== 'number' || !Number.isInteger(X) || X < 1 || X > newIntendedN) {
      return badRequest(
        `approvalThreshold (X) must be a whole number between 1 and ${newIntendedN} (the new intended committee size).`,
      );
    }

    const message = committeeMessages.member(
      getStage(), drepId, 'add', rawInput, body.mutationNonce, authCtx.walletAddress,
    );
    const reason = await verifyCommitteeResign(authCtx.walletAddress, body, message);
    if (reason) return unauthorized(reason);

    // Honor `autoDeclineInvites` on the invitee's user row (best-effort —
    // missing user row → treat as not auto-declining).
    const userRow = await getItem<UserItem>(tableNames.users, { walletAddress: stake, SK: 'PROFILE' });
    const autoDecline = userRow?.autoDeclineInvites === true;

    const now = new Date().toISOString();
    const invite: CommitteeInviteItem = {
      drepId,
      SK: inviteSk(stake),
      inviteeStake: stake,
      status: autoDecline ? 'rejected' : 'pending',
      role: role === 'trusted_delegator' ? 'trusted_delegator' : 'committee_member',
      invitedBy: authCtx.walletAddress,
      invitedAt: now,
      ...(autoDecline ? { respondedAt: now } : {}),
      ...(body.displayName ? { displayName: body.displayName } : {}),
    };

    // Build the transaction:
    //   - Write the INVITE row (conditional on no existing row — protects
    //     against a parallel "Chair clicked twice" race).
    //   - Restate X / intendedMemberCount / updatedAt on the COMMITTEE row.
    //   - Claim the wallet's single membership slot with role='invited'
    //     UNLESS the invitee auto-declines (in which case the slot is NOT
    //     claimed — they remain free to participate elsewhere).
    const txItems: Array<Record<string, unknown>> = [
      {
        Put: {
          TableName: tableNames.drepCommittees,
          Item: invite as unknown as Record<string, unknown>,
          ConditionExpression: 'attribute_not_exists(drepId) AND attribute_not_exists(SK)',
        },
      },
      {
        Update: {
          TableName: tableNames.drepCommittees,
          Key: { drepId, SK: 'COMMITTEE' },
          UpdateExpression:
            'SET #approvalThreshold = :x, #intendedMemberCount = :n, #updatedAt = :now',
          ExpressionAttributeNames: {
            '#approvalThreshold': 'approvalThreshold',
            '#intendedMemberCount': 'intendedMemberCount',
            '#updatedAt': 'updatedAt',
          },
          ExpressionAttributeValues: { ':x': X, ':n': newIntendedN, ':now': now },
        },
      },
    ];
    if (!autoDecline) {
      const membershipRow: CommitteeMembershipItem = {
        walletAddress: stake,
        drepId,
        role: 'invited',
        joinedAt: now,
      };
      txItems.push({
        Put: {
          TableName: tableNames.committeeMembership,
          Item: membershipRow as unknown as Record<string, unknown>,
          ConditionExpression: 'attribute_not_exists(walletAddress)',
        },
      });
    }

    try {
      await transactWrite(txItems);
    } catch (err) {
      if (err && typeof err === 'object' && (err as { name?: string }).name === 'TransactionCanceledException') {
        return conflict('That wallet already belongs to a DRep committee, or was invited to this one in parallel.');
      }
      throw err;
    }

    await writeAuditEvent({
      entityType: 'drep_committee',
      entityId: drepId,
      eventType: 'committee.member.invited',
      actorWallet: authCtx.walletAddress,
      metadata: {
        targetWallet: stake,
        role: invite.role,
        status: invite.status,
        autoDeclined: autoDecline,
        intendedMemberCount: newIntendedN,
        approvalThreshold: X,
      },
    });

    return created(invite);
  } catch (err) {
    console.error('committee/addMember error:', err);
    return handleError(err);
  }
};
