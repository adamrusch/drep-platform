import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { extractAuthContext } from '../../middleware/role-guard';
import { writeAuditEvent } from '../../lib/audit';
import { committeeMessages } from '../../lib/committeeMessages';
import { ok, badRequest, unauthorized, notFound, conflict, handleError } from '../_response';
import {
  approvalRuleFromProposal,
  assertCommitteeMember,
  buildTallySnapshot,
  castRowsFrom,
  getStage,
  loadCommittee,
  loadProposal,
  loadVoteScopeItems,
  transitionOpenProposal,
  verifyCommitteeResign,
  voteScopeOf,
} from './_committee';

interface CloseVoteBody {
  mutationNonce: string;
  mutationSignature: string;
  mutationKey: string;
}

/** Close-as-PASSED. Any committee member may do this WHILE the proposal is
 *  currently passing (quorum met + supermajority). */
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    const drepId = event.pathParameters?.['drepId'];
    const actionIdRaw = event.pathParameters?.['actionId'];
    if (!drepId || !actionIdRaw) return badRequest('drepId and actionId path parameters are required');
    const actionId = decodeURIComponent(actionIdRaw);
    if (!event.body) return badRequest('Request body is required');

    let body: CloseVoteBody;
    try {
      body = JSON.parse(event.body) as CloseVoteBody;
    } catch {
      return badRequest('Invalid JSON body');
    }

    const committee = await loadCommittee(drepId);
    if (!committee) return notFound('Committee');
    assertCommitteeMember(authCtx, committee);

    const voteScope = voteScopeOf(drepId, actionId);
    const proposal = await loadProposal(voteScope);
    if (!proposal) return notFound('Proposal');
    if (proposal.status !== 'open') return conflict('This proposal is already closed');

    const items = await loadVoteScopeItems(voteScope);
    const casts = castRowsFrom(items);
    const rule = approvalRuleFromProposal(proposal);
    const finalTally = buildTallySnapshot(
      casts.map((c) => ({ voterWallet: c.voterWallet, vote: c.vote })),
      rule,
    );
    if (!finalTally.approved) {
      return conflict(
        `This proposal is not "Committee Approved" yet — it needs ${rule.approvalThreshold} of ${rule.memberCount} members to vote Agree before it can be closed as passed.`,
      );
    }

    const message = committeeMessages.close(
      getStage(), drepId, actionId, 'pass', body.mutationNonce, authCtx.walletAddress,
    );
    const reason = await verifyCommitteeResign(authCtx.walletAddress, body, message);
    if (reason) return unauthorized(reason);

    const result = await transitionOpenProposal(voteScope, {
      status: 'passed',
      closedReason: 'manual_pass',
      closedByWallet: authCtx.walletAddress,
      finalTally,
    });
    if (result === 'not_open') {
      return conflict('This proposal was just closed by someone else');
    }

    await writeAuditEvent({
      entityType: 'committee_vote',
      entityId: voteScope,
      eventType: 'committee.vote.closed',
      actorWallet: authCtx.walletAddress,
      metadata: { drepId, actionId, outcome: 'passed', ...finalTally },
    });

    return ok({ status: 'passed', finalPosition: proposal.proposedPosition, finalTally });
  } catch (err) {
    console.error('committee/closeVote error:', err);
    return handleError(err);
  }
};
