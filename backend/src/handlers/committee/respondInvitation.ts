/**
 * POST /committee/{drepId}/invitations/respond
 *
 * The invitee (authCtx.walletAddress === inviteeStake) accepts or rejects a
 * pending committee invitation. Re-signs the response with a stage-bound
 * `invitation-response` message that binds Committee + Decision into the
 * plaintext, so an Accept signature physically cannot be replayed as a
 * Reject (or vice versa).
 *
 * Accept (atomic, via transactWrite):
 *   1. INVITE row: status='pending' → 'accepted', stamp respondedAt.
 *   2. COMMITTEE row: append a `CommitteeMemberItem(active=true)` to
 *      `members[]` — preserves every existing voter check + the
 *      memberSnapshot freeze on `openProposal`. NO change to
 *      `approvalThreshold` / `intendedMemberCount` (decision B: X stands).
 *   3. committee_membership row: role='invited' → 'member'.
 *
 * Reject (atomic):
 *   1. INVITE row: 'pending' → 'rejected', stamp respondedAt.
 *   2. committee_membership row: Delete (free the slot).
 *
 * Only the invitee (by stake-address equality) may respond. The handler is
 * a no-op if the invite is not currently pending — returns 409 with the
 * current status so the UI can re-fetch.
 */
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { transactWrite, tableNames } from '../../lib/dynamodb';
import type {
  CommitteeMemberItem,
  InviteDecision,
} from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { writeAuditEvent } from '../../lib/audit';
import { committeeMessages } from '../../lib/committeeMessages';
import { ok, badRequest, unauthorized, notFound, conflict, forbidden, handleError } from '../_response';
import {
  getStage,
  inviteSk,
  loadCommittee,
  loadInvite,
  verifyCommitteeResign,
} from './_committee';

interface RespondBody {
  decision: InviteDecision;
  mutationNonce: string;
  mutationSignature: string;
  mutationKey: string;
}

const DECISIONS: InviteDecision[] = ['accept', 'reject'];

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    const drepId = event.pathParameters?.['drepId'];
    if (!drepId) return badRequest('drepId path parameter is required');
    if (!event.body) return badRequest('Request body is required');

    let body: RespondBody;
    try {
      body = JSON.parse(event.body) as RespondBody;
    } catch {
      return badRequest('Invalid JSON body');
    }
    if (!DECISIONS.includes(body.decision)) {
      return badRequest(`decision must be one of: ${DECISIONS.join(', ')}`);
    }

    const inviteeStake = authCtx.walletAddress;
    const invite = await loadInvite(drepId, inviteeStake);
    if (!invite) {
      // Either there never was an invite for this wallet on this committee,
      // or the SK suffix differs because the wallet's stake address was
      // normalised differently — either way, NOT for this caller.
      return notFound('Invitation');
    }
    // Defense-in-depth: only the invitee may respond. The auth context's
    // walletAddress IS the stake address (normalised at /auth/verify), so
    // a mismatch here means a state-of-the-world drift; surface 403.
    if (invite.inviteeStake !== inviteeStake) {
      return forbidden('Only the invitee can respond to this invitation.');
    }
    if (invite.status !== 'pending') {
      return conflict(
        `This invitation is not pending (current status: ${invite.status}).`,
      );
    }

    const committee = await loadCommittee(drepId);
    if (!committee) return notFound('Committee');

    // Re-sign required. The plaintext binds Committee + Decision so an Accept
    // signature cannot be replayed as a Reject on the same nonce.
    const message = committeeMessages.invitationResponse(
      getStage(),
      drepId,
      body.decision,
      body.mutationNonce,
      inviteeStake,
    );
    const reason = await verifyCommitteeResign(inviteeStake, body, message);
    if (reason) return unauthorized(reason);

    const now = new Date().toISOString();

    if (body.decision === 'accept') {
      // Append to members[] preserving every downstream contract:
      //   - assertCommitteeMember(authCtx, committee) — read-modify-write of
      //     members[] is fine because the append IS the change; the OCC
      //     guard below conditions on `updatedAt` to detect concurrent
      //     accepts.
      //   - `withMemberActivity` — sets `.active` live on read. We set it
      //     here too so the freshly-accepted member shows as Active
      //     immediately (the invitee just logged in to accept, so by
      //     definition their user row exists).
      const newMember: CommitteeMemberItem = {
        walletAddress: inviteeStake,
        joinedAt: now,
        role: invite.role,
        active: true,
        ...(invite.displayName ? { displayName: invite.displayName } : {}),
      };
      const expectedUpdatedAt = committee.updatedAt;
      try {
        await transactWrite([
          {
            Update: {
              TableName: tableNames.drepCommittees,
              Key: { drepId, SK: inviteSk(inviteeStake) },
              UpdateExpression: 'SET #status = :accepted, respondedAt = :now',
              ConditionExpression: '#status = :pending',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':accepted': 'accepted',
                ':pending': 'pending',
                ':now': now,
              },
            },
          },
          {
            Update: {
              TableName: tableNames.drepCommittees,
              Key: { drepId, SK: 'COMMITTEE' },
              UpdateExpression:
                'SET #members = list_append(#members, :m), #updatedAt = :now',
              ConditionExpression: expectedUpdatedAt
                ? 'attribute_exists(drepId) AND #updatedAt = :expected'
                : 'attribute_exists(drepId)',
              ExpressionAttributeNames: {
                '#members': 'members',
                '#updatedAt': 'updatedAt',
              },
              ExpressionAttributeValues: {
                ':m': [newMember],
                ':now': now,
                ...(expectedUpdatedAt ? { ':expected': expectedUpdatedAt } : {}),
              },
            },
          },
          {
            Update: {
              TableName: tableNames.committeeMembership,
              Key: { walletAddress: inviteeStake },
              UpdateExpression: 'SET #role = :member, joinedAt = :now',
              ConditionExpression: '#role = :invited AND drepId = :d',
              ExpressionAttributeNames: { '#role': 'role' },
              ExpressionAttributeValues: {
                ':member': 'member',
                ':invited': 'invited',
                ':d': drepId,
                ':now': now,
              },
            },
          },
        ]);
      } catch (err) {
        if (err && typeof err === 'object' && (err as { name?: string }).name === 'TransactionCanceledException') {
          return conflict(
            'Could not accept the invitation. Reload and try again — the committee may have changed.',
          );
        }
        throw err;
      }

      await writeAuditEvent({
        entityType: 'drep_committee',
        entityId: drepId,
        eventType: 'committee.invitation.accepted',
        actorWallet: inviteeStake,
        metadata: { drepId, role: invite.role },
      });

      return ok({ drepId, status: 'accepted', role: invite.role, joinedAt: now });
    }

    // ---- Reject ----
    try {
      await transactWrite([
        {
          Update: {
            TableName: tableNames.drepCommittees,
            Key: { drepId, SK: inviteSk(inviteeStake) },
            UpdateExpression: 'SET #status = :rejected, respondedAt = :now',
            ConditionExpression: '#status = :pending',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':rejected': 'rejected',
              ':pending': 'pending',
              ':now': now,
            },
          },
        },
        {
          Delete: {
            TableName: tableNames.committeeMembership,
            Key: { walletAddress: inviteeStake },
            ConditionExpression: '#role = :invited AND drepId = :d',
            ExpressionAttributeNames: { '#role': 'role' },
            ExpressionAttributeValues: { ':invited': 'invited', ':d': drepId },
          },
        },
      ]);
    } catch (err) {
      if (err && typeof err === 'object' && (err as { name?: string }).name === 'TransactionCanceledException') {
        return conflict(
          'Could not reject the invitation — it may have already been responded to. Reload to see the latest state.',
        );
      }
      throw err;
    }

    await writeAuditEvent({
      entityType: 'drep_committee',
      entityId: drepId,
      eventType: 'committee.invitation.rejected',
      actorWallet: inviteeStake,
      metadata: { drepId },
    });

    return ok({ drepId, status: 'rejected', respondedAt: now });
  } catch (err) {
    console.error('committee/respondInvitation error:', err);
    return handleError(err);
  }
};
