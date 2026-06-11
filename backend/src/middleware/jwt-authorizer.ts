/**
 * JWT authorizer Lambda for API Gateway HTTP API v2.
 *
 * This Lambda runs ahead of every authenticated handler and turns an
 * inbound `Cookie:` (or `Authorization: Bearer ...`) into a structured
 * authorizer context that the downstream handler reads via
 * `event.requestContext.authorizer.lambda`.
 *
 * Token sources (in order):
 *   1. `Authorization: Bearer <token>` — for non-browser clients / future
 *      bearer-token use.
 *   2. `Cookie: access_token=<token>` — what the SPA uses (HttpOnly,
 *      Secure, SameSite=Strict).
 *
 * Output context shape (delivered to handlers as strings — API Gateway
 * v2 simple-response context can only carry strings):
 *   - `walletAddress`: the JWT subject (`sub`)
 *   - `roles`: JSON-serialized array of role strings
 *   - `sessionType`: `'normal'` or `'remember_me'`
 *   - `registeredDrepId`: present only when the JWT carries a DRep claim.
 *     This is the REGISTERED-DRep id (i.e. the wallet completed
 *     `/drep/register`) — NOT the DRep the wallet delegates to. The
 *     latter is fetched live in `/auth/me` as `delegatedToDrepId`.
 *
 * Failure mode: any rejection (missing token, expired, signature
 * invalid, claims malformed) returns `{isAuthorized: false}` — API
 * Gateway translates that into a 401 with no body. Reasons are logged
 * to CloudWatch but never surfaced to the client.
 *
 * Caching: explicitly disabled in `infra/lib/api-stack.ts` (TTL=0). We
 * want immediate revocation on logout; a 5-minute cache TTL would
 * defeat that.
 *
 * Revocation: after the JWT verifies cryptographically, we read the user
 * row's `tokenVersion` and reject the token if it is stale (logout
 * increments the row, invalidating every outstanding token at once — i.e.
 * "log out everywhere"). This is one DynamoDB GetItem per authenticated
 * request; the authorizer already carries `lambdaRole` (table read) and the
 * table-prefix env via `commonLambdaProps`, so no extra wiring. If the read
 * itself ERRORS (DynamoDB blip), we FAIL OPEN — the token is already
 * cryptographically valid and we prefer availability over enforcing
 * revocation during an outage. A genuine version MISMATCH always fails closed.
 */
import type {
  APIGatewayRequestAuthorizerEventV2,
  APIGatewaySimpleAuthorizerResult,
} from 'aws-lambda';
import {
  verifyJWT,
  extractTokenFromCookie,
  extractOnChainTokenFromCookie,
} from '../lib/auth';
import { getItem, tableNames } from '../lib/dynamodb';
import { isSessionRevoked } from '../lib/sessionRevocation';
import type { JWTPayload, UserItem } from '../lib/types';


export const handler = async (
  event: APIGatewayRequestAuthorizerEventV2,
): Promise<APIGatewaySimpleAuthorizerResult> => {
  try {
    const token = extractToken(event);
    if (!token) {
      return { isAuthorized: false };
    }

    const payload = await verifyJWT(token);

    // Per-session revocation (Sprint 1): if the JWT carries a `jti`, check
    // for a tombstone in the revocation store. Tombstones are written by
    // logout / "log out everywhere" — they fail-CLOSE the revoked token
    // while leaving every other token (different `jti`) untouched. The
    // store's `isSessionRevoked` already fails OPEN on read errors so a
    // DynamoDB blip doesn't lock everyone out (matching the legacy
    // tokenVersion path below).
    //
    // Legacy tokens with no `jti` skip this check. They're still subject
    // to the row-counter check below.
    if (typeof payload.jti === 'string' && payload.jti.length > 0) {
      if (await isSessionRevoked(payload.jti)) {
        console.warn(
          `JWT authorizer rejected revoked-session token for ${payload.sub} (jti=${payload.jti})`,
        );
        return { isAuthorized: false };
      }
    }

    // Session revocation: reject a token whose version is below the user
    // row's current `tokenVersion` (bumped on logout). Fail OPEN on a read
    // error (token is already crypto-valid); fail CLOSED on a real mismatch.
    const liveVersion = await currentTokenVersion(payload.sub);
    if (liveVersion !== null && (payload.tokenVersion ?? 0) < liveVersion) {
      console.warn(
        `JWT authorizer rejected revoked token for ${payload.sub}: ` +
          `tokenVersion ${payload.tokenVersion ?? 0} < ${liveVersion}`,
      );
      return { isAuthorized: false };
    }

    return buildAuthorizedResponse(payload, liveVersion ?? payload.tokenVersion ?? 0);
  } catch (err) {
    console.warn('JWT authorizer rejected request:', err instanceof Error ? err.message : err);
    return { isAuthorized: false };
  }
};

/**
 * The user row's current `tokenVersion`, or `null` if it couldn't be read
 * (so the caller fails open). Absent attribute / absent row → 0.
 */
async function currentTokenVersion(walletAddress: string): Promise<number | null> {
  try {
    const user = await getItem<UserItem>(tableNames.users, { walletAddress, SK: 'PROFILE' });
    return typeof user?.tokenVersion === 'number' ? user.tokenVersion : 0;
  } catch (err) {
    console.error('JWT authorizer: tokenVersion read failed, failing open:', err);
    return null;
  }
}

function extractToken(event: APIGatewayRequestAuthorizerEventV2): string | null {
  // 1. Try Authorization header (Bearer token)
  const authHeader = event.headers?.['authorization'] ?? event.headers?.['Authorization'];
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // 2. Try httpOnly cookies — legacy CIP-30 session first, then the new
  //    on-chain session. A wallet may hold both cookies at once: prefer the
  //    legacy one because it carries the canonical `roles` claim every
  //    existing role-gated handler expects. On-chain-only sessions (no
  //    legacy login this device) fall through to the second branch.
  const cookieHeader = event.cookies?.join('; ');
  const fromLegacy = extractTokenFromCookie(cookieHeader);
  if (fromLegacy) {
    return fromLegacy;
  }
  const fromOnChain = extractOnChainTokenFromCookie(cookieHeader);
  if (fromOnChain) {
    return fromOnChain;
  }

  return null;
}

function buildAuthorizedResponse(
  payload: JWTPayload,
  tokenVersion: number,
): APIGatewaySimpleAuthorizerResult & {
  context: Record<string, string>;
} {
  return {
    isAuthorized: true,
    context: {
      walletAddress: payload.sub,
      roles: JSON.stringify(payload.roles),
      sessionType: payload.sessionType,
      // Forward the validated version so /auth/refresh re-mints at the
      // current version without a second DynamoDB read.
      tokenVersion: String(tokenVersion),
      ...(payload.registeredDrepId ? { registeredDrepId: payload.registeredDrepId } : {}),
      // Sprint 1: forward the on-chain roles claim (always-defined post-
      // verify, possibly empty) and the `jti` when present. Both ride as
      // strings — API Gateway v2 only carries string context values.
      onChainRoles: JSON.stringify(payload.onChainRoles ?? []),
      ...(payload.jti ? { jti: payload.jti } : {}),
      // Decision #3 — surface `personId` to downstream handlers when
      // the token carries it. Absence is fine — the on-chain `me` and
      // link handlers fall back to a credential→person re-resolve via
      // `identity_links` so a pre-Decision-3 on-chain token keeps
      // working through a rolling upgrade.
      ...(payload.personId ? { personId: payload.personId } : {}),
    },
  };
}
