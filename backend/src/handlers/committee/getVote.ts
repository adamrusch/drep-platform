import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import type {
  CommitteeVoteProposalItem,
  CommitteeVoteCastItem,
  CommitteeRationaleDraftItem,
} from '../../lib/types';
import { resolveCommitteeVote } from '../../lib/committeeVoteResolver';
import { ok, badRequest, notFound, handleError } from '../_response';
import { castRowsFrom, loadVoteScopeItems, voteScopeOf } from './_committee';

/** Public read: proposal + casts + live tally + rationale draft (if any). */
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const drepId = event.pathParameters?.['drepId'];
    const actionIdRaw = event.pathParameters?.['actionId'];
    if (!drepId || !actionIdRaw) return badRequest('drepId and actionId path parameters are required');
    const actionId = decodeURIComponent(actionIdRaw);

    const voteScope = voteScopeOf(drepId, actionId);
    const items = await loadVoteScopeItems(voteScope);
    if (items.length === 0) return notFound('Proposal');

    const proposal = items.find((i) => i['itemKey'] === 'PROPOSAL') as
      | CommitteeVoteProposalItem
      | undefined;
    if (!proposal) return notFound('Proposal');

    const casts = castRowsFrom(items);
    const draft = items.find((i) => i['itemKey'] === 'RATIONALE#DRAFT') as
      | CommitteeRationaleDraftItem
      | undefined;

    const tally = resolveCommitteeVote({
      casts: casts.map((c) => ({ voterWallet: c.voterWallet, vote: c.vote })),
      thresholdPct: proposal.thresholdPct,
      quorum: proposal.quorum,
    });

    // Public casts omit the raw signature payload (kept on the row + audit log).
    const publicCasts = casts
      .map((c: CommitteeVoteCastItem) => ({
        voterWallet: c.voterWallet,
        vote: c.vote,
        votedAt: c.votedAt,
        changeCount: c.changeCount,
      }))
      .sort((a, b) => a.votedAt.localeCompare(b.votedAt));

    return ok({
      proposal: {
        drepId: proposal.drepId,
        actionId: proposal.actionId,
        proposedPosition: proposal.proposedPosition,
        proposerWallet: proposal.proposerWallet,
        status: proposal.status,
        thresholdPct: proposal.thresholdPct,
        quorum: proposal.quorum,
        epochDeadline: proposal.epochDeadline,
        openedAt: proposal.openedAt,
        closedAt: proposal.closedAt,
        closedByWallet: proposal.closedByWallet,
        closedReason: proposal.closedReason,
        finalTally: proposal.finalTally,
      },
      casts: publicCasts,
      tally,
      hasRationaleDraft: Boolean(draft),
    });
  } catch (err) {
    console.error('committee/getVote error:', err);
    return handleError(err);
  }
};
