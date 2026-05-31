/**
 * DELETE /auth/session
 *
 * Logs out the current session. Side effects:
 *   1. Clear the JWT cookie via `Set-Cookie: ...; Max-Age=0`.
 *   2. Increment `tokenVersion` on the user row. The authorizer rejects any
 *      token whose version is below the row's — so this revokes EVERY
 *      outstanding session for the wallet ("log out everywhere"), defeating a
 *      cookie that was exfiltrated before logout. This is the real revocation
 *      signal, not just a client-side cookie clear.
 *   3. Null out `sessionTokenHash` / `sessionExpiry` (legacy fields; harmless).
 */
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { buildClearCookieHeader } from '../../lib/auth';
import { updateItem, tableNames } from '../../lib/dynamodb';
import { _invalidateForStake } from '../../lib/recognition';
import { extractAuthContext } from '../../middleware/role-guard';
import { ok, internalError } from '../_response';

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);

    // Revoke all sessions (bump tokenVersion) + clear the legacy session
    // fields, in one atomic update. `ADD` on a missing attribute starts from 0,
    // so the first-ever logout sets tokenVersion = 1.
    await updateItem(
      tableNames.users,
      { walletAddress: authCtx.walletAddress, SK: 'PROFILE' },
      'SET #sessionTokenHash = :null, #sessionExpiry = :null, #updatedAt = :now ADD #tokenVersion :one',
      {
        '#sessionTokenHash': 'sessionTokenHash',
        '#sessionExpiry': 'sessionExpiry',
        '#updatedAt': 'updatedAt',
        '#tokenVersion': 'tokenVersion',
      },
      {
        ':null': null,
        ':now': new Date().toISOString(),
        ':one': 1,
      },
    );

    // Bust the recognition LRU for this stake so a subsequent sign-in
    // from the same container with a NEW delegation isn't served from
    // the prior cached entry. Per-container scope — see
    // `_invalidateForStake` for the full contract. Best-effort.
    try {
      _invalidateForStake(authCtx.walletAddress);
    } catch (err) {
      console.warn('logout: recognition cache eviction failed (non-fatal):', err);
    }

    const clearCookie = buildClearCookieHeader();

    return ok({ success: true }, [clearCookie]);
  } catch (err) {
    console.error('logout handler error:', err);
    return internalError('Failed to logout');
  }
};
