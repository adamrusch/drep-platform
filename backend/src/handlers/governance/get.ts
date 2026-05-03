import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getItem, tableNames } from '../../lib/dynamodb';
import type { GovernanceActionItem } from '../../lib/types';
import { ok, badRequest, notFound, internalError } from '../_response';

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  try {
    const actionId = event.pathParameters?.['actionId'];
    if (!actionId) {
      return badRequest('actionId path parameter is required');
    }

    const item = await getItem<GovernanceActionItem>(tableNames.governanceActions, {
      actionId: decodeURIComponent(actionId),
      SK: 'ACTION',
    });

    if (!item) {
      return notFound('Governance action');
    }

    return ok(item, { 'Cache-Control': 'public, max-age=30, s-maxage=30' });
  } catch (err) {
    console.error('governance/get handler error:', err);
    return internalError('Failed to fetch governance action');
  }
};
