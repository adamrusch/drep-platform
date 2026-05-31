import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { queryItems, tableNames } from '../../lib/dynamodb';
import type { CommitteeVoteProposalItem } from '../../lib/types';
import { ok, badRequest, handleError } from '../_response';

/** Public read: all proposals for a committee, newest-first. */
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const drepId = event.pathParameters?.['drepId'];
    if (!drepId) return badRequest('drepId path parameter is required');

    const res = await queryItems<CommitteeVoteProposalItem>(tableNames.committeeVotes, {
      indexName: 'drepId-openedAt-index',
      keyConditionExpression: 'drepId = :d',
      expressionAttributeValues: { ':d': drepId },
      scanIndexForward: false, // newest-first
      limit: 100,
    });

    const proposals = res.items.map((p) => ({
      drepId: p.drepId,
      actionId: p.actionId,
      proposedPosition: p.proposedPosition,
      proposerWallet: p.proposerWallet,
      status: p.status,
      thresholdPct: p.thresholdPct,
      quorum: p.quorum,
      epochDeadline: p.epochDeadline,
      openedAt: p.openedAt,
      closedAt: p.closedAt,
      closedReason: p.closedReason,
      finalTally: p.finalTally,
    }));

    return ok({ proposals });
  } catch (err) {
    console.error('committee/listVotes error:', err);
    return handleError(err);
  }
};
