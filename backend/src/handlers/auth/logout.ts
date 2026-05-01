import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { buildClearCookieHeader } from '../../lib/auth';
import { updateItem, tableNames } from '../../lib/dynamodb';
import { extractAuthContext } from '../../middleware/role-guard';
import { ok, internalError } from '../_response';

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);

    // Clear session fields in DynamoDB
    await updateItem(
      tableNames.users,
      { walletAddress: authCtx.walletAddress, SK: 'PROFILE' },
      'SET #sessionTokenHash = :null, #sessionExpiry = :null, #updatedAt = :now',
      {
        '#sessionTokenHash': 'sessionTokenHash',
        '#sessionExpiry': 'sessionExpiry',
        '#updatedAt': 'updatedAt',
      },
      {
        ':null': null,
        ':now': new Date().toISOString(),
      },
    );

    const clearCookie = buildClearCookieHeader();

    return ok({ success: true }, [clearCookie]);
  } catch (err) {
    console.error('logout handler error:', err);
    return internalError('Failed to logout');
  }
};
