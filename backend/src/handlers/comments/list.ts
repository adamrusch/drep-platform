import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { queryItems, tableNames } from '../../lib/dynamodb';
import type { CommentItem } from '../../lib/types';
import { ok, badRequest, internalError } from '../_response';

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  try {
    const actionId = event.pathParameters?.['actionId'];
    if (!actionId) {
      return badRequest('actionId path parameter is required');
    }

    const qs = event.queryStringParameters ?? {};
    const limitParam = qs['limit'];
    const lastKey = qs['lastKey'];
    const onlyPublic = qs['public'] === 'true';

    const limit = limitParam ? Math.min(parseInt(limitParam, 10), 100) : 50;

    const exprNames: Record<string, string> = { '#actionId': 'actionId' };
    const exprValues: Record<string, unknown> = { ':actionId': decodeURIComponent(actionId) };
    let filterExpr: string | undefined;

    if (onlyPublic) {
      exprNames['#isPublic'] = 'isPublic';
      exprValues[':true'] = true;
      filterExpr = '#isPublic = :true';
    }

    const result = await queryItems<CommentItem>(tableNames.comments, {
      keyConditionExpression: '#actionId = :actionId',
      expressionAttributeNames: exprNames,
      expressionAttributeValues: exprValues,
      filterExpression: filterExpr,
      limit,
      scanIndexForward: false,
      ...(lastKey
        ? { exclusiveStartKey: JSON.parse(Buffer.from(lastKey, 'base64').toString('utf-8')) as Record<string, unknown> }
        : {}),
    });

    return ok(
      {
        items: result.items,
        lastEvaluatedKey: result.lastEvaluatedKey
          ? Buffer.from(JSON.stringify(result.lastEvaluatedKey)).toString('base64')
          : undefined,
      },
      // 15s edge cache — more dynamic than the action itself (users post
      // fresh comments and expect them to show up quickly).
      { 'Cache-Control': 'public, max-age=15, s-maxage=15' },
    );
  } catch (err) {
    console.error('comments/list handler error:', err);
    return internalError('Failed to list comments');
  }
};
