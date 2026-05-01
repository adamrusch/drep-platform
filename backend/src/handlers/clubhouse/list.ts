import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { queryItems, tableNames } from '../../lib/dynamodb';
import type { ClubhousePostItem } from '../../lib/types';
import { ok, badRequest, internalError } from '../_response';

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  try {
    const drepId = event.pathParameters?.['drepId'];
    if (!drepId) {
      return badRequest('drepId path parameter is required');
    }

    const qs = event.queryStringParameters ?? {};
    const limitParam = qs['limit'];
    const lastKey = qs['lastKey'];

    const limit = limitParam ? Math.min(parseInt(limitParam, 10), 50) : 20;

    const result = await queryItems<ClubhousePostItem>(tableNames.clubhousePosts, {
      keyConditionExpression: '#drepId = :drepId',
      expressionAttributeNames: { '#drepId': 'drepId' },
      expressionAttributeValues: { ':drepId': decodeURIComponent(drepId) },
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
    });
  } catch (err) {
    console.error('clubhouse/list handler error:', err);
    return internalError('Failed to list clubhouse posts');
  }
};
