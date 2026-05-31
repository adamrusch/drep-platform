import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { putItem, tableNames } from '../../lib/dynamodb';
import type { CommitteeSubmissionItem } from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { writeAuditEvent } from '../../lib/audit';
import { ok, badRequest, forbidden, notFound, conflict, handleError } from '../_response';
import {
  assertCommitteeLead,
  getStage,
  loadCommittee,
  loadProposal,
  loadRationaleFinal,
  voteScopeOf,
} from './_committee';

interface ReceiptBody {
  txHash: string;
  override?: boolean;
}

/**
 * Record an on-chain vote submission receipt. PROD-ONLY — a non-prod stage
 * cannot record a mainnet submission, the backstop for D1 (test does everything
 * up to broadcast but never actually submits). Lead only.
 */
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    const drepId = event.pathParameters?.['drepId'];
    const actionIdRaw = event.pathParameters?.['actionId'];
    if (!drepId || !actionIdRaw) return badRequest('drepId and actionId path parameters are required');
    const actionId = decodeURIComponent(actionIdRaw);

    if (getStage() !== 'prod') {
      return forbidden('On-chain vote submissions can only be recorded from the production environment');
    }

    if (!event.body) return badRequest('Request body is required');
    let body: ReceiptBody;
    try {
      body = JSON.parse(event.body) as ReceiptBody;
    } catch {
      return badRequest('Invalid JSON body');
    }
    if (!body.txHash || !/^[0-9a-fA-F]{64}$/.test(body.txHash)) {
      return badRequest('txHash must be a 64-char hex transaction hash');
    }

    const committee = await loadCommittee(drepId);
    if (!committee) return notFound('Committee');
    assertCommitteeLead(authCtx, committee);

    const voteScope = voteScopeOf(drepId, actionId);
    const proposal = await loadProposal(voteScope);
    if (!proposal) return notFound('Proposal');
    if (proposal.status !== 'passed') return conflict('Only a passed proposal can be submitted on-chain');

    const final = await loadRationaleFinal(voteScope);
    const now = new Date().toISOString();
    const submission: CommitteeSubmissionItem = {
      voteScope,
      itemKey: 'SUBMISSION',
      drepId,
      actionId,
      position: proposal.proposedPosition,
      txHash: body.txHash.toLowerCase(),
      broadcastStage: 'prod',
      submittedBy: authCtx.walletAddress,
      submittedAt: now,
      ...(final?.anchorHash ? { anchorHash: final.anchorHash } : {}),
      ...(final?.ipfsUri ? { anchorUrl: final.ipfsUri } : {}),
      // Snapshot the exact canonical bytes that produced `anchorHash` onto the
      // immutable SUBMISSION row. The FINAL row is frozen once this exists (see
      // finalizeRationale), but snapshotting makes the submission a fully
      // self-contained record-of-what-mainnet-saw: its canonicalJson hashes to
      // its anchorHash regardless of anything else in the table.
      ...(final?.canonicalJson ? { canonicalJson: final.canonicalJson } : {}),
      ...(final ? {} : { rationaleOverridden: true }),
    };

    // Conditional Put — first receipt wins; a duplicate submission 409s.
    try {
      await putItem(
        tableNames.committeeVotes,
        submission as unknown as Record<string, unknown>,
        'attribute_not_exists(itemKey)',
      );
    } catch (err) {
      if (err && typeof err === 'object' && (err as { name?: string }).name === 'ConditionalCheckFailedException') {
        return conflict('This vote has already been submitted on-chain');
      }
      throw err;
    }

    await writeAuditEvent({
      entityType: 'committee_vote',
      entityId: voteScope,
      eventType: 'committee.vote.submitted',
      actorWallet: authCtx.walletAddress,
      metadata: { drepId, actionId, txHash: submission.txHash, position: proposal.proposedPosition },
    });

    return ok({ txHash: submission.txHash, position: proposal.proposedPosition });
  } catch (err) {
    console.error('committee/submitReceipt error:', err);
    return handleError(err);
  }
};
