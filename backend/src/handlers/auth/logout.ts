/**
 * DELETE /auth/session
 *
 * Logs out the current session. Two side effects:
 *   1. Clear the JWT cookie via `Set-Cookie: ...; Max-Age=0`
 *   2. Null out `sessionTokenHash` / `sessionExpiry` on the user row so
 *      the deprecated server-side session validation path (kept for
 *      defense in depth) can't be replayed with a leaked cookie.
 *
 * Note: clearing the cookie is the user-visible signal. Step 2 is a
 * belt-and-suspenders move — JWTs are stateless so even without the
 * server-side clear, the cookie's removal alone is sufficient. We do
 * both to keep the user record consistent.
 */
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
