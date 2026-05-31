import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { CommitteePosition } from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { ok, badRequest, forbidden, notFound, conflict, handleError } from '../_response';
import {
  assertCommitteeLead,
  getStage,
  loadCommittee,
  loadProposal,
  loadRationaleFinal,
  voteScopeOf,
} from './_committee';
import { getItem, tableNames } from '../../lib/dynamodb';

interface SubmitBody {
  /** Proceed without a finalized rationale (after the warn-and-confirm). */
  override?: boolean;
}

/** CIP-1694 VoteKind: No=0, Yes=1, Abstain=2. */
function positionToVoteKind(p: CommitteePosition): number {
  return p === 'Yes' ? 1 : p === 'No' ? 0 : 2;
}

/**
 * Build the on-chain submission payload for a passed proposal and decide
 * whether broadcast is allowed. Broadcast is gated to prod: on every other
 * stage the payload is fully assembled but `broadcastAllowed=false`, and the
 * UI tells the lead the vote must be submitted from production. Lead only.
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

    let body: SubmitBody = {};
    if (event.body) {
      try {
        body = JSON.parse(event.body) as SubmitBody;
      } catch {
        return badRequest('Invalid JSON body');
      }
    }

    const committee = await loadCommittee(drepId);
    if (!committee) return notFound('Committee');
    assertCommitteeLead(authCtx, committee);

    const voteScope = voteScopeOf(drepId, actionId);
    const proposal = await loadProposal(voteScope);
    if (!proposal) return notFound('Proposal');
    if (proposal.status !== 'passed') {
      return conflict('Only a passed proposal can be submitted on-chain');
    }

    // Already submitted?
    const existing = await getItem(tableNames.committeeVotes, { voteScope, itemKey: 'SUBMISSION' });
    if (existing) return conflict('This vote has already been submitted on-chain');

    // Rationale: required by default, but the lead may override after a warning.
    const final = await loadRationaleFinal(voteScope);
    if (!final && !body.override) {
      return conflict(
        JSON.stringify({
          requiresRationaleOverride: true,
          message: 'No finalized rationale. Submitting without one is discouraged; resend with override=true to proceed.',
        }),
      );
    }

    const stage = getStage();
    const broadcastAllowed = stage === 'prod';

    return ok({
      ready: true,
      broadcastAllowed,
      stage,
      rationaleOverridden: !final,
      payload: {
        drepId,
        actionId,
        position: proposal.proposedPosition,
        voteKind: positionToVoteKind(proposal.proposedPosition),
        anchorUrl: final?.ipfsUri ?? null,
        anchorHash: final?.anchorHash ?? null,
      },
      message: broadcastAllowed
        ? 'Ready to submit. Sign the vote transaction with your wallet.'
        : 'This vote is assembled and ready — but it must be submitted from the production environment.',
    });
  } catch (err) {
    console.error('committee/submit error:', err);
    return handleError(err);
  }
};
