/**
 * DELETE /committee/{drepId}/invitations/{walletAddress}
 *
 * Lead-only path that revokes a PENDING invitation the Chair issued. Frees
 * the wallet's membership slot so they can be invited by another committee
 * (or re-invited later by this one once that's supported).
 *
 * Mirrors removeMember.ts on the auth side: lead-only + re-sign with the
 * existing `member` signed-message verb ('remove' action). The shape is
 * deliberately identical to the existing remove path so the frontend hook
 * can reuse `useMutationSign` with the same message builder.
 *
 * Atomic via transactWrite:
 *   - INVITE row: status='pending' → 'revoked', stamp respondedAt.
 *   - committee_membership row (role='invited'): Delete.
 *
 * No-op for non-pending invites — surfaces 409 with the current status so
 * the UI can re-fetch and reconcile.
 */
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { transactWrite, tableNames } from '../../lib/dynamodb';
import { extractAuthContext } from '../../middleware/role-guard';
import { writeAuditEvent } from '../../lib/audit';
import { committeeMessages } from '../../lib/committeeMessages';
import { ok, badRequest, unauthorized, notFound, conflict, handleError } from '../_response';
import {
  assertCommitteeLead,
  getStage,
  inviteSk,
  loadCommittee,
  loadInvite,
  verifyCommitteeResign,
} from './_committee';

interface RevokeBody {
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
    if (!drepId || !targetRaw) {
      return badRequest('drepId and walletAddress path parameters are required');
    }
    const target = decodeURIComponent(targetRaw);
    if (!event.body) return badRequest('Request body (re-sign) is required');

    let body: RevokeBody;
    try {
      body = JSON.parse(event.body) as RevokeBody;
    } catch {
      return badRequest('Invalid JSON body');
    }

    const committee = await loadCommittee(drepId);
    if (!committee) return notFound('Committee');
    assertCommitteeLead(authCtx, committee);

    const invite = await loadInvite(drepId, target);
    if (!invite) return notFound('Invitation');
    if (invite.status !== 'pending') {
      return conflict(
        `This invitation is not pending (current status: ${invite.status}).`,
      );
    }

    // Reuse the existing `member` signed message with action='remove' — the
    // semantic is the same (a Chair-authorized removal of a wallet from
    // their committee, just before acceptance). Frontend signs the
    // byte-identical message via `useMutationSign`.
    const message = committeeMessages.member(
      getStage(), drepId, 'remove', target, body.mutationNonce, authCtx.walletAddress,
    );
    const reason = await verifyCommitteeResign(authCtx.walletAddress, body, message);
    if (reason) return unauthorized(reason);

    const now = new Date().toISOString();

    try {
      await transactWrite([
        {
          Update: {
            TableName: tableNames.drepCommittees,
            Key: { drepId, SK: inviteSk(target) },
            UpdateExpression: 'SET #status = :revoked, respondedAt = :now',
            ConditionExpression: '#status = :pending',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':revoked': 'revoked',
              ':pending': 'pending',
              ':now': now,
            },
          },
        },
        {
          Delete: {
            TableName: tableNames.committeeMembership,
            Key: { walletAddress: target },
            ConditionExpression: '#role = :invited AND drepId = :d',
            ExpressionAttributeNames: { '#role': 'role' },
            ExpressionAttributeValues: { ':invited': 'invited', ':d': drepId },
          },
        },
      ]);
    } catch (err) {
      if (err && typeof err === 'object' && (err as { name?: string }).name === 'TransactionCanceledException') {
        return conflict(
          'Could not revoke the invitation — it may have already been accepted, rejected, or revoked. Reload to see the latest state.',
        );
      }
      throw err;
    }

    await writeAuditEvent({
      entityType: 'drep_committee',
      entityId: drepId,
      eventType: 'committee.invitation.revoked',
      actorWallet: authCtx.walletAddress,
      metadata: { drepId, targetWallet: target },
    });

    return ok({ drepId, target, status: 'revoked', respondedAt: now });
  } catch (err) {
    console.error('committee/revokeInvitation error:', err);
    return handleError(err);
  }
};
