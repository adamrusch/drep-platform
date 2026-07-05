import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { queryItems, tableNames } from '../../lib/dynamodb';
import type { DRepCommitteeItem } from '../../lib/types';
import { ok, internalError, parseLimit } from '../_response';

/**
 * GET /drep
 *
 * Two listing modes:
 *  - `?leadWallet=<addr>` → query the `leadWallet-index` GSI (committee for one wallet)
 *  - no params           → query the `SK-createdAt-index` GSI for all committees,
 *                          sorted newest-first.
 *
 * Pagination: `?lastKey=<base64>` opaque cursor; `?limit=<n>` capped at 100.
 */
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  try {
    const qs = event.queryStringParameters ?? {};
    const limitParam = qs['limit'];
    const lastKey = qs['lastKey'];
    const leadWallet = qs['leadWallet'];

    const limit = parseLimit(limitParam, 20, 100);

    const exclusiveStartKey = lastKey
      ? (JSON.parse(Buffer.from(lastKey, 'base64').toString('utf-8')) as Record<string, unknown>)
      : undefined;

    if (leadWallet) {
      const result = await queryItems<DRepCommitteeItem>(tableNames.drepCommittees, {
        indexName: 'leadWallet-index',
        keyConditionExpression: '#leadWallet = :leadWallet',
        expressionAttributeNames: { '#leadWallet': 'leadWallet' },
        expressionAttributeValues: { ':leadWallet': leadWallet },
        limit,
        ...(exclusiveStartKey ? { exclusiveStartKey } : {}),
      });
      return ok({
        items: result.items,
        lastEvaluatedKey: result.lastEvaluatedKey
          ? Buffer.from(JSON.stringify(result.lastEvaluatedKey)).toString('base64')
          : undefined,
        total: result.count,
      });
    }

    // Browse-all: list every committee, newest first.
    const result = await queryItems<DRepCommitteeItem>(tableNames.drepCommittees, {
      indexName: 'SK-createdAt-index',
      keyConditionExpression: '#sk = :sk',
      expressionAttributeNames: { '#sk': 'SK' },
      expressionAttributeValues: { ':sk': 'COMMITTEE' },
      limit,
      scanIndexForward: false,
      ...(exclusiveStartKey ? { exclusiveStartKey } : {}),
    });

    return ok({
      items: result.items,
      lastEvaluatedKey: result.lastEvaluatedKey
        ? Buffer.from(JSON.stringify(result.lastEvaluatedKey)).toString('base64')
        : undefined,
      total: result.count,
    });
  } catch (err) {
    console.error('drep/list handler error:', err);
    return internalError('Failed to list DReps');
  }
};
