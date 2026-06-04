import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { transactWrite, tableNames } from '../../lib/dynamodb';
import { extractAuthContext } from '../../middleware/role-guard';
import { writeAuditEvent } from '../../lib/audit';
import { committeeMessages } from '../../lib/committeeMessages';
import { ok, badRequest, unauthorized, notFound, conflict, handleError } from '../_response';
import {
  assertCommitteeLead,
  getStage,
  loadCommittee,
  MIN_COMMITTEE_MEMBERS,
  verifyCommitteeResign,
} from './_committee';

interface RemoveMemberBody {
  /** Re-specified X of N (N = member count AFTER this removal). Required. */
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

    // A committee may never drop below the minimum size of ACCEPTED members.
    const newMemberCount = (committee.members?.length ?? 0) - 1;
    if (newMemberCount < MIN_COMMITTEE_MEMBERS) {
      return conflict(
        `A committee must keep at least ${MIN_COMMITTEE_MEMBERS} members. Removing this member would leave ${newMemberCount}.`,
      );
    }

    // Decision B: restate X over the new INTENDED N. Removing an accepted
    // member shrinks intendedN by 1 as well (they no longer count toward
    // the Chair's intended roster). For legacy rows without
    // `intendedMemberCount`, fall back to the accepted count, mirroring the
    // pre-invitation contract.
    const currentIntendedN = committee.intendedMemberCount ?? committee.members?.length ?? 0;
    const newIntendedN = Math.max(0, currentIntendedN - 1);
    const X = body.approvalThreshold;
    if (typeof X !== 'number' || !Number.isInteger(X) || X < 1 || X > newIntendedN) {
      return badRequest(
        `approvalThreshold (X) must be a whole number between 1 and ${newIntendedN} (the new intended committee size).`,
      );
    }

    const message = committeeMessages.member(
      getStage(), drepId, 'remove', target, body.mutationNonce, authCtx.walletAddress,
    );
    const reason = await verifyCommitteeResign(authCtx.walletAddress, body, message);
    if (reason) return unauthorized(reason);

    const now = new Date().toISOString();
    const newMembers = (committee.members ?? []).filter((m) => m.walletAddress !== target);

    // The roster mutation is a read-modify-write (DynamoDB can't drop a list
    // element by value), so guard it with optimistic concurrency: condition the
    // write on the committee's `updatedAt` still matching what we just read. If
    // a concurrent addMember/removeMember changed the roster in between, the
    // condition fails and we 409 instead of silently clobbering their change
    // (which would otherwise strand a member: membership slot taken, roster
    // missing them). Falls back to existence-only for legacy rows with no
    // `updatedAt`.
    const expectedUpdatedAt = committee.updatedAt;
    try {
      await transactWrite([
        {
          Update: {
            TableName: tableNames.drepCommittees,
            Key: { drepId, SK: 'COMMITTEE' },
            UpdateExpression:
              'SET #members = :m, #approvalThreshold = :x, #intendedMemberCount = :n, #updatedAt = :now',
            ConditionExpression: expectedUpdatedAt
              ? 'attribute_exists(drepId) AND #updatedAt = :expected'
              : 'attribute_exists(drepId)',
            ExpressionAttributeNames: {
              '#members': 'members',
              '#approvalThreshold': 'approvalThreshold',
              '#intendedMemberCount': 'intendedMemberCount',
              '#updatedAt': 'updatedAt',
            },
            ExpressionAttributeValues: {
              ':m': newMembers,
              ':x': X,
              ':n': newIntendedN,
              ':now': now,
              ...(expectedUpdatedAt ? { ':expected': expectedUpdatedAt } : {}),
            },
          },
        },
        {
          Delete: {
            TableName: tableNames.committeeMembership,
            Key: { walletAddress: target },
          },
        },
      ]);
    } catch (err) {
      if (err && typeof err === 'object' && (err as { name?: string }).name === 'TransactionCanceledException') {
        return conflict('The committee roster changed while you were removing a member. Reload and try again.');
      }
      throw err;
    }

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
