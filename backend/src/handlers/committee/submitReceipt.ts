import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { putItem, tableNames } from '../../lib/dynamodb';
import type { CommitteeSubmissionItem } from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { writeAuditEvent } from '../../lib/audit';
import { committeeMessages } from '../../lib/committeeMessages';
import { ok, badRequest, unauthorized, forbidden, notFound, conflict, handleError } from '../_response';
import { canBroadcastGovernanceVote } from '../../lib/stage';
import {
  assertCommitteeLead,
  getStage,
  loadCommittee,
  loadProposal,
  loadRationaleFinal,
  signatureSnapshot,
  verifyCommitteeResign,
  voteScopeOf,
} from './_committee';

interface ReceiptBody {
  txHash: string;
  override?: boolean;
  mutationNonce: string;
  mutationSignature: string;
  mutationKey: string;
  /**
   * Acknowledgement that the caller understands this is a REAL mainnet
   * vote. REQUIRED on stages where `canBroadcastGovernanceVote` is true and
   * the stage is `'test'` — because test.drep.tools is wired to mainnet, a
   * receipt on test means a real DRep vote was just cast. Must be the
   * boolean literal `true` (not "true", not 1) to count.
   */
  confirmedRealMainnetVote?: boolean;
}

/**
 * Record an on-chain vote submission receipt. Permission to record is the
 * same as permission to broadcast — gated by `canBroadcastGovernanceVote`:
 *   - prod  → any lead may record (this is exactly the old behaviour).
 *   - test  → restricted to `platform_admin` (the same wall as the
 *             broadcast path; the receipt-only route can't be used to
 *             persist a "fictional" txHash on test as a non-admin).
 *
 * The recorded `broadcastStage` reflects the stage the receipt was
 * recorded on (`'prod'` or `'test'`), so an audit reader can see at a
 * glance which environment cast each vote. A `'test'` stage receipt is
 * still a record of a REAL mainnet vote — the stage marker just attributes
 * provenance.
 *
 * On test, a `realMainnetVoteOnTest: true` audit row is written BEFORE the
 * normal "submitted" row so the audit trail records the safety-critical
 * intent even if the post-write path errors. Lead only.
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

    if (!canBroadcastGovernanceVote(authCtx)) {
      return forbidden(
        getStage() === 'test'
          ? 'On-chain submission on the test environment is restricted to platform admins (test casts REAL mainnet votes). This feature is not yet available for your account.'
          : 'On-chain vote submissions can only be recorded from the production environment',
      );
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

    // On `test`, require an explicit safety acknowledgement. The wire shape
    // must be the boolean literal `true` — accepting "true"/1/other truthy
    // forms would defeat the "deliberate, intentional click" guarantee
    // this gate exists to enforce. On prod, the field is irrelevant (the
    // production stage's whole purpose IS casting real mainnet votes).
    if (getStage() === 'test' && body.confirmedRealMainnetVote !== true) {
      return badRequest(
        'confirmedRealMainnetVote=true is required on the test environment — recording a vote here writes a real mainnet vote receipt.',
      );
    }

    const committee = await loadCommittee(drepId);
    if (!committee) return notFound('Committee');
    assertCommitteeLead(authCtx, committee);

    // Recording a permanent on-chain receipt is a privileged mutation — require
    // a fresh CIP-30 re-sign bound to THIS txHash (not just the session cookie),
    // so a leaked cookie can't record a bogus submission.
    const message = committeeMessages.submitReceipt(
      getStage(), drepId, actionId, body.txHash, body.mutationNonce, authCtx.walletAddress,
    );
    const reason = await verifyCommitteeResign(authCtx.walletAddress, body, message);
    if (reason) return unauthorized(reason);

    const voteScope = voteScopeOf(drepId, actionId);
    const proposal = await loadProposal(voteScope);
    if (!proposal) return notFound('Proposal');
    if (proposal.status !== 'passed') return conflict('Only a passed proposal can be submitted on-chain');

    const final = await loadRationaleFinal(voteScope);
    const now = new Date().toISOString();
    const stage = getStage();
    const submission: CommitteeSubmissionItem = {
      voteScope,
      itemKey: 'SUBMISSION',
      drepId,
      actionId,
      position: proposal.proposedPosition,
      txHash: body.txHash.toLowerCase(),
      // Record the stage we recorded the receipt on. On `'test'` this is
      // STILL a real mainnet vote — the marker only tells an audit reader
      // which deploy environment the human-driver clicked from. Pinning
      // this to `'prod'` would lose that provenance.
      broadcastStage: stage,
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

    // Pre-write audit row on `test`. Recording a real mainnet vote from the
    // test environment is a security-relevant event by itself — the row
    // captures intent BEFORE the write, so even if the conditional Put
    // racing with another receipt 409s, we have a trace of "a platform
    // admin clicked through the safety acknowledgement on the test env at
    // this exact time". `writeAuditEvent` is best-effort (never throws).
    if (stage === 'test') {
      await writeAuditEvent({
        entityType: 'committee_vote',
        entityId: voteScope,
        eventType: 'committee.vote.realMainnetVoteOnTest',
        actorWallet: authCtx.walletAddress,
        metadata: {
          drepId,
          actionId,
          txHash: submission.txHash,
          position: proposal.proposedPosition,
          realMainnetVoteOnTest: true,
        },
      });
    }

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
      metadata: {
        drepId,
        actionId,
        txHash: submission.txHash,
        position: proposal.proposedPosition,
        broadcastStage: stage,
        signature: signatureSnapshot(body, message).mutationSignature,
        ...(stage === 'test' ? { realMainnetVoteOnTest: true } : {}),
      },
    });

    return ok({ txHash: submission.txHash, position: proposal.proposedPosition });
  } catch (err) {
    console.error('committee/submitReceipt error:', err);
    return handleError(err);
  }
};
