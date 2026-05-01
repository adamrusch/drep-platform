import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { queryItems, tableNames } from '../../lib/dynamodb';
import type { GovernanceActionItem } from '../../lib/types';
import { ok, badRequest, internalError } from '../_response';

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  try {
    const qs = event.queryStringParameters ?? {};
    const status = qs['status'] ?? 'active';
    const limitParam = qs['limit'];
    const lastKey = qs['lastKey'];

    const validStatuses = ['active', 'expired', 'enacted', 'dropped'];
    if (!validStatuses.includes(status)) {
      return badRequest(`Invalid status. Must be one of: ${validStatuses.join(', ')}`);
    }

    const limit = limitParam ? Math.min(parseInt(limitParam, 10), 100) : 20;
    if (isNaN(limit) || limit < 1) {
      return badRequest('limit must be a positive integer');
    }

    const result = await queryItems<GovernanceActionItem>(tableNames.governanceActions, {
      indexName: 'status-submittedAt-index',
      keyConditionExpression: '#status = :status',
      expressionAttributeNames: { '#status': 'status' },
      expressionAttributeValues: { ':status': status },
      limit,
      scanIndexForward: false,
      ...(lastKey
        ? { exclusiveStartKey: JSON.parse(Buffer.from(lastKey, 'base64').toString('utf-8')) as Record<string, unknown> }
        : {}),
    });

    return ok({
      items: result.items,
      lastEvaluatedKey: result.lastEvaluatedKey
        ? Buffer.from(JSON.stringify(result.lastEvaluatedKey)).toString('base64')
        : undefined,
      total: result.count,
    });
  } catch (err) {
    console.error('governance/list handler error:', err);
    return internalError('Failed to list governance actions');
  }
};
