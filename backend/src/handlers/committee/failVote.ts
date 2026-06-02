import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { extractAuthContext } from '../../middleware/role-guard';
import { writeAuditEvent } from '../../lib/audit';
import { committeeMessages } from '../../lib/committeeMessages';
import { ok, badRequest, unauthorized, forbidden, notFound, conflict, handleError } from '../_response';
import {
  approvalRuleFromProposal,
  buildTallySnapshot,
  castRowsFrom,
  getStage,
  isProposerOrLead,
  loadCommittee,
  loadProposal,
  loadVoteScopeItems,
  transitionOpenProposal,
  verifyCommitteeResign,
  voteScopeOf,
} from './_committee';

interface FailVoteBody {
  mutationNonce: string;
  mutationSignature: string;
  mutationKey: string;
}

/** Close-as-FAILED — a terminal committee decision. Proposer or lead only
 *  (their judgement call; there is no "doomed" auto-math, per D2=A). */
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

    let body: FailVoteBody;
    try {
      body = JSON.parse(event.body) as FailVoteBody;
    } catch {
      return badRequest('Invalid JSON body');
    }

    const committee = await loadCommittee(drepId);
    if (!committee) return notFound('Committee');

    const voteScope = voteScopeOf(drepId, actionId);
    const proposal = await loadProposal(voteScope);
    if (!proposal) return notFound('Proposal');
    if (proposal.status !== 'open') return conflict('This proposal is already closed');

    if (!isProposerOrLead(authCtx, committee, proposal.proposerWallet)) {
      return forbidden('Only the proposer or the lead DRep can close a proposal as failed');
    }

    const message = committeeMessages.close(
      getStage(), drepId, actionId, 'fail', body.mutationNonce, authCtx.walletAddress,
    );
    const reason = await verifyCommitteeResign(authCtx.walletAddress, body, message);
    if (reason) return unauthorized(reason);

    const items = await loadVoteScopeItems(voteScope);
    const casts = castRowsFrom(items);
    const finalTally = buildTallySnapshot(
      casts.map((c) => ({ voterWallet: c.voterWallet, vote: c.vote })),
      approvalRuleFromProposal(proposal),
    );

    const result = await transitionOpenProposal(voteScope, {
      status: 'failed',
      closedReason: 'manual_fail',
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
      metadata: { drepId, actionId, outcome: 'failed', ...finalTally },
    });

    return ok({ status: 'failed', finalTally });
  } catch (err) {
    console.error('committee/failVote error:', err);
    return handleError(err);
  }
};
