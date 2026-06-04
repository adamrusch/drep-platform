/**
 * POST /me/invitations/decline-all
 *
 * Reject every pending committee invitation for the authenticated wallet.
 * Distinct from the `autoDeclineInvites` profile toggle:
 *
 *   - `autoDeclineInvites` (PUT /profile) BLOCKS FUTURE invites — every
 *     new invitation issued to this wallet is auto-rejected at creation
 *     with no membership slot claimed.
 *   - `decline-all` (this endpoint) operates on the CURRENT pending set —
 *     it touches every existing pending invitation now. Toggling the
 *     profile flag does NOT mass-reject existing invites; this endpoint
 *     is the explicit user action for that.
 *
 * Implementation: query the sparse `inviteeStake-status-index` GSI for
 * every pending invite belonging to the caller, then for each one issue
 * the same atomic transactWrite that `respondInvitation.ts` uses for a
 * reject (no signature required — JWT-auth is enough: only the owner of
 * the wallet can decline their own pending invites and the action is
 * defensive, not consequential to the chain).
 *
 * Returns the count of invites successfully rejected. Best-effort per
 * invite: a TransactionCanceledException on one row (the chair revoked
 * in parallel, or the wallet accepted a different invite that conflicts
 * with the slot delete) does NOT roll back the others.
 */
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { transactWrite, tableNames } from '../../lib/dynamodb';
import { extractAuthContext } from '../../middleware/role-guard';
import { writeAuditEvent } from '../../lib/audit';
import { ok, handleError } from '../_response';
import { inviteSk, listPendingInvitesForWallet } from '../committee/_committee';

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    const inviteeStake = authCtx.walletAddress;

    const pending = await listPendingInvitesForWallet(inviteeStake);
    const now = new Date().toISOString();
    let rejected = 0;
    const failures: string[] = [];

    for (const invite of pending) {
      try {
        await transactWrite([
          {
            Update: {
              TableName: tableNames.drepCommittees,
              Key: { drepId: invite.drepId, SK: inviteSk(inviteeStake) },
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
              ExpressionAttributeValues: { ':invited': 'invited', ':d': invite.drepId },
            },
          },
        ]);
        rejected++;
      } catch (err) {
        if (err && typeof err === 'object' && (err as { name?: string }).name === 'TransactionCanceledException') {
          // Drift — the invite changed state between the GSI Query and the
          // tx, or the slot was already claimed by another committee. Skip
          // and continue with the rest.
          failures.push(invite.drepId);
          continue;
        }
        throw err;
      }
    }

    if (rejected > 0 || failures.length > 0) {
      await writeAuditEvent({
        entityType: 'user_profile',
        entityId: inviteeStake,
        eventType: 'committee.invitations.declined_all',
        actorWallet: inviteeStake,
        metadata: { rejected, skipped: failures.length },
      });
    }

    return ok({ rejected, skipped: failures.length });
  } catch (err) {
    console.error('profile/declineAllInvitations error:', err);
    return handleError(err);
  }
};
