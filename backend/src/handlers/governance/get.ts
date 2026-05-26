import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getItem, tableNames } from '../../lib/dynamodb';
import type { GovernanceActionItem } from '../../lib/types';
import { getVotesForAction, type ActionVoteRecord } from '../../lib/votes';
import { ok, badRequest, notFound, internalError } from '../_response';

/**
 * The wire shape for `GET /governance/{actionId}` is the persisted
 * `GovernanceActionItem` with one additional field: `voteList` — every
 * individual vote cast on this action, newest-first, with the supersede
 * dedupe rule applied (see `lib/votes.ts`). The frontend Votes tab renders
 * `voteList` directly; legacy consumers that only read `votes` (the
 * aggregated tally) ignore the new field and keep working.
 *
 * Why bundle votes into this endpoint rather than expose a new
 * `/governance/{actionId}/votes` route: adding a route would require an
 * infra (CDK) change to register a new API Gateway route + Lambda. The
 * existing Lambda already has `governance_votes` read permission (granted
 * pre-emptively in `infra/lib/api-stack.ts:105` for exactly this case)
 * and a per-action vote count of ~500 max keeps the response well under
 * the CloudFront 6MB origin response limit.
 */
interface GovernanceActionWithVotes extends GovernanceActionItem {
  voteList: ActionVoteRecord[];
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  try {
    const actionId = event.pathParameters?.['actionId'];
    if (!actionId) {
      return badRequest('actionId path parameter is required');
    }

    const decodedActionId = decodeURIComponent(actionId);

    // Run the action lookup and votes query in parallel — the votes
    // query is independent of the action row and adds ~one DDB Query +
    // one BatchGet round-trip. Failure to fetch votes is non-fatal: we
    // still serve the action row with an empty `voteList` so the page
    // renders. The action lookup IS required (we 404 on its absence).
    const [item, voteListResult] = await Promise.allSettled([
      getItem<GovernanceActionItem>(tableNames.governanceActions, {
        actionId: decodedActionId,
        SK: 'ACTION',
      }),
      getVotesForAction(decodedActionId),
    ]);

    if (item.status !== 'fulfilled') {
      console.error('governance/get DDB error:', item.reason);
      return internalError('Failed to fetch governance action');
    }
    if (!item.value) {
      return notFound('Governance action');
    }

    const voteList: ActionVoteRecord[] =
      voteListResult.status === 'fulfilled' ? voteListResult.value : [];
    if (voteListResult.status === 'rejected') {
      console.warn(`governance/get vote-list fetch failed for ${decodedActionId}:`, voteListResult.reason);
    }

    const response: GovernanceActionWithVotes = { ...item.value, voteList };
    return ok(response, { 'Cache-Control': 'public, max-age=30, s-maxage=30' });
  } catch (err) {
    console.error('governance/get handler error:', err);
    return internalError('Failed to fetch governance action');
  }
};
