import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { extractAuthContext } from '../../middleware/role-guard';
import { writeAuditEvent } from '../../lib/audit';
import { committeeMessages } from '../../lib/committeeMessages';
import { ok, badRequest, unauthorized, forbidden, notFound, conflict, handleError } from '../_response';
import {
  getStage,
  isProposerOrLead,
  loadCommittee,
  loadProposal,
  transitionOpenProposal,
  verifyCommitteeResign,
  voteScopeOf,
} from './_committee';

interface WithdrawBody {
  mutationNonce: string;
  mutationSignature: string;
  mutationKey: string;
}

/** Withdraw an open proposal (NOT a committee decision — just removes it from
 *  play). Proposer or lead only. The row is flipped to 'withdrawn' and stays,
 *  so a fresh proposal can later be opened for the same action (Q1). */
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    const drepId = event.pathParameters?.['drepId'];
    const actionIdRaw = event.pathParameters?.['actionId'];
    if (!drepId || !actionIdRaw) return badRequest('drepId and actionId path parameters are required');
    const actionId = decodeURIComponent(actionIdRaw);
    if (!event.body) return badRequest('Request body (re-sign) is required');

    let body: WithdrawBody;
    try {
      body = JSON.parse(event.body) as WithdrawBody;
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
      return forbidden('Only the proposer or the lead DRep can withdraw a proposal');
    }

    const message = committeeMessages.close(
      getStage(), drepId, actionId, 'withdraw', body.mutationNonce, authCtx.walletAddress,
    );
    const reason = await verifyCommitteeResign(authCtx.walletAddress, body, message);
    if (reason) return unauthorized(reason);

    const result = await transitionOpenProposal(voteScope, {
      status: 'withdrawn',
      closedReason: 'withdrawn',
      closedByWallet: authCtx.walletAddress,
    });
    if (result === 'not_open') {
      return conflict('This proposal was just closed by someone else');
    }

    await writeAuditEvent({
      entityType: 'committee_vote',
      entityId: voteScope,
      eventType: 'committee.proposal.withdrawn',
      actorWallet: authCtx.walletAddress,
      metadata: { drepId, actionId, withdrawnBy: authCtx.walletAddress },
    });

    return ok({ status: 'withdrawn' });
  } catch (err) {
    console.error('committee/withdrawProposal error:', err);
    return handleError(err);
  }
};
