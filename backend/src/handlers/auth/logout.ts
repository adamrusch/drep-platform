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
import {
  buildClearCookieHeader,
  buildOnChainClearCookieHeader,
} from '../../lib/auth';
import { updateItem, tableNames } from '../../lib/dynamodb';
import { _invalidateForStake } from '../../lib/recognition';
import {
  revokeSessionByJti,
  revokeAllSessionsForUser,
} from '../../lib/sessionRevocation';
import { extractAuthContext } from '../../middleware/role-guard';
import { ok, internalError } from '../_response';

interface LogoutRequestBody {
  /** When true, revokes every on-chain session this wallet holds in
   *  addition to bumping `tokenVersion`. When false (the default), only
   *  the CURRENT session's `jti` is revoked — other devices/tabs of this
   *  wallet remain logged in for their on-chain sessions. The legacy
   *  CIP-30 `tokenVersion` is always bumped (preserving the existing
   *  "log out everywhere" semantic for the legacy path). */
  all?: boolean;
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);

    // Parse the optional body — DELETE bodies are allowed in HTTP and the
    // SPA currently sends none. We default `all=false` so the existing
    // "DELETE /auth/session" semantics for legacy CIP-30 sessions are
    // preserved: the row's tokenVersion is bumped (revoking every legacy
    // session as before) but only the CURRENT on-chain session is
    // revoked granularly. Callers wanting "log out everywhere for
    // on-chain too" pass `{"all": true}`.
    let revokeAll = false;
    if (event.body) {
      try {
        const parsed = JSON.parse(event.body) as LogoutRequestBody;
        revokeAll = parsed.all === true;
      } catch {
        // Ignore malformed body — treat as the no-op default.
      }
    }

    // Revoke all legacy sessions (bump tokenVersion) + clear the legacy
    // session fields, in one atomic update. `ADD` on a missing attribute
    // starts from 0, so the first-ever logout sets tokenVersion = 1.
    //
    // We always bump tokenVersion — this matches the pre-Sprint-1 contract
    // and ensures the legacy CIP-30 path's "log out everywhere" semantic
    // is preserved unconditionally. The granular on-chain revocation runs
    // in addition.
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

    // Sprint 1 — per-session revocation for the on-chain JWT path.
    //
    // Two scenarios:
    //   - `all === true`  → walk the per-user session index and tombstone
    //                       every on-chain `jti` we've issued for this
    //                       wallet. Combined with the tokenVersion bump
    //                       above this is a full "log out everywhere".
    //   - default         → tombstone JUST the current session's `jti`.
    //                       Other devices/tabs of this wallet that hold
    //                       a different on-chain `jti` remain logged in.
    //
    // Best-effort either way: a revocation-store failure logs but never
    // 500s the logout itself (the legacy tokenVersion bump above already
    // guarantees "log out everywhere" for the legacy path).
    let revokedCount = 0;
    try {
      if (revokeAll) {
        revokedCount = await revokeAllSessionsForUser(authCtx.walletAddress);
      } else if (authCtx.jti) {
        await revokeSessionByJti(authCtx.jti, authCtx.walletAddress);
        revokedCount = 1;
      }
    } catch (err) {
      console.warn('logout: per-session revocation failed (non-fatal):', err);
    }

    // Bust the recognition LRU for this stake so a subsequent sign-in
    // from the same container with a NEW delegation isn't served from
    // the prior cached entry. Per-container scope — see
    // `_invalidateForStake` for the full contract. Best-effort.
    try {
      _invalidateForStake(authCtx.walletAddress);
    } catch (err) {
      console.warn('logout: recognition cache eviction failed (non-fatal):', err);
    }

    // Clear both cookie families — the legacy one is the long-standing
    // contract, and the on-chain one ensures a wallet holding both is
    // fully signed out from the SPA's perspective.
    const clearLegacy = buildClearCookieHeader();
    const clearOnChain = buildOnChainClearCookieHeader();

    return ok(
      { success: true, revokedSessions: revokedCount, revokeAll },
      [clearLegacy, clearOnChain],
    );
  } catch (err) {
    console.error('logout handler error:', err);
    return internalError('Failed to logout');
  }
};
