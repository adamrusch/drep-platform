import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getItem, tableNames } from '../../lib/dynamodb';
import type { DRepCommitteeItem } from '../../lib/types';
import { ok, badRequest, notFound, internalError } from '../_response';

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  try {
    const drepId = event.pathParameters?.['drepId'];
    if (!drepId) {
      return badRequest('drepId path parameter is required');
    }

    const item = await getItem<DRepCommitteeItem>(tableNames.drepCommittees, {
      drepId: decodeURIComponent(drepId),
      SK: 'COMMITTEE',
    });

    if (!item) {
      return notFound('DRep committee');
    }

    return ok(item);
  } catch (err) {
    console.error('drep/get handler error:', err);
    return internalError('Failed to fetch DRep');
  }
};
