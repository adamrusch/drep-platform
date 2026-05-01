import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getItem, tableNames } from '../../lib/dynamodb';
import type { UserItem } from '../../lib/types';
import { getAccountInfo } from '../../lib/blockfrost';
import { ok, badRequest, notFound, internalError } from '../_response';

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  try {
    const walletAddress = event.pathParameters?.['walletAddress'];
    if (!walletAddress) {
      return badRequest('walletAddress path parameter is required');
    }

    const decoded = decodeURIComponent(walletAddress);

    const user = await getItem<UserItem>(tableNames.users, {
      walletAddress: decoded,
      SK: 'PROFILE',
    });

    if (!user) {
      return notFound('User profile');
    }

    // Enrich with live on-chain data if it's a stake address
    let onChainDrepId: string | undefined;
    if (decoded.startsWith('stake')) {
      try {
        const accountInfo = await getAccountInfo(decoded);
        onChainDrepId = accountInfo.drep_id ?? undefined;
      } catch (blockfrostErr) {
        // Non-fatal: log and continue with stored data
        console.warn('Failed to fetch Blockfrost account info:', blockfrostErr);
      }
    }

    return ok({
      walletAddress: decoded,
      delegationHistory: user.delegationHistory ?? [],
      currentDrepId: onChainDrepId,
    });
  } catch (err) {
    console.error('profile/delegationHistory handler error:', err);
    return internalError('Failed to fetch delegation history');
  }
};
