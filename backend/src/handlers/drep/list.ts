import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { queryItems, tableNames } from '../../lib/dynamodb';
import type { DRepCommitteeItem } from '../../lib/types';
import { ok, badRequest, internalError } from '../_response';

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  try {
    const qs = event.queryStringParameters ?? {};
    const limitParam = qs['limit'];
    const lastKey = qs['lastKey'];
    const leadWallet = qs['leadWallet'];

    const limit = limitParam ? Math.min(parseInt(limitParam, 10), 100) : 20;

    if (leadWallet) {
      // Query by leadWallet using the GSI
      const result = await queryItems<DRepCommitteeItem>(tableNames.drepCommittees, {
        indexName: 'leadWallet-index',
        keyConditionExpression: '#leadWallet = :leadWallet',
        expressionAttributeNames: { '#leadWallet': 'leadWallet' },
        expressionAttributeValues: { ':leadWallet': leadWallet },
        limit,
      });
      return ok({ items: result.items });
    }

    if (!leadWallet) {
      return badRequest(
        'Either leadWallet query parameter is required, or use pagination. Full table scan is disabled — specify leadWallet to filter.',
      );
    }

    const result = await queryItems<DRepCommitteeItem>(tableNames.drepCommittees, {
      keyConditionExpression: '#leadWallet = :leadWallet',
      expressionAttributeNames: { '#leadWallet': 'leadWallet' },
      expressionAttributeValues: { ':leadWallet': leadWallet },
      indexName: 'leadWallet-index',
      limit,
      ...(lastKey
        ? {
            exclusiveStartKey: JSON.parse(
              Buffer.from(lastKey, 'base64').toString('utf-8'),
            ) as Record<string, unknown>,
          }
        : {}),
    });

    return ok({
      items: result.items,
      lastEvaluatedKey: result.lastEvaluatedKey
        ? Buffer.from(JSON.stringify(result.lastEvaluatedKey)).toString('base64')
        : undefined,
    });
  } catch (err) {
    console.error('drep/list handler error:', err);
    return internalError('Failed to list DReps');
  }
};
