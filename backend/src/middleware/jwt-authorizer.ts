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
    const extracted = extractToken(event);
    if (!extracted) {
      return { isAuthorized: false };
    }
    const { token, source } = extracted;

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

    return buildAuthorizedResponse(payload, liveVersion ?? payload.tokenVersion ?? 0, source);
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

/**
 * Token-source signal forwarded to handlers (S1 fix, 2026-06-10
 * security review). A `legacy` token came from the CIP-30 cookie or
 * a Bearer header; an `onchain` token came from the `access_token_onchain`
 * cookie. Handlers under `/auth/onchain/*` must reject `legacy` tokens
 * (per S1) so a legacy session cannot bind credentials in the on-chain
 * personId model.
 *
 * Bearer tokens are mapped to `legacy` because the legacy CIP-30
 * surface is the only one that issues callers a bearer-compatible
 * surface today; the on-chain flow is cookie-only.
 */
export type TokenSource = 'legacy' | 'onchain';

function extractToken(
  event: APIGatewayRequestAuthorizerEventV2,
): { token: string; source: TokenSource } | null {
  // 1. Try Authorization header (Bearer token) — treated as `legacy`
  //    since today's bearer-flow consumers come from the legacy surface.
  const authHeader = event.headers?.['authorization'] ?? event.headers?.['Authorization'];
  if (authHeader?.startsWith('Bearer ')) {
    return { token: authHeader.slice(7), source: 'legacy' };
  }

  // 2. Try httpOnly cookies — legacy CIP-30 session first, then the new
  //    on-chain session. A wallet may hold both cookies at once: prefer the
  //    legacy one because it carries the canonical `roles` claim every
  //    existing role-gated handler expects. On-chain-only sessions (no
  //    legacy login this device) fall through to the second branch.
  //
  // S1 fix — the source label rides through with the token so the
  // downstream handler knows which cookie's JWT it's holding. An
  // /auth/onchain/* endpoint that the SPA hit while the user still
  // has a legacy cookie present would pre-fix have authenticated via
  // the legacy cookie and proceeded into the on-chain logic with a
  // stake-`sub` JWT — potentially binding a legacy stake credential
  // to a personId derived from a missing on-chain context. Post-fix
  // the handler can read `tokenSource === 'legacy'` and reject the
  // request before any binding work.
  const cookieHeader = event.cookies?.join('; ');
  const fromLegacy = extractTokenFromCookie(cookieHeader);
  if (fromLegacy) {
    return { token: fromLegacy, source: 'legacy' };
  }
  const fromOnChain = extractOnChainTokenFromCookie(cookieHeader);
  if (fromOnChain) {
    return { token: fromOnChain, source: 'onchain' };
  }

  return null;
}

function buildAuthorizedResponse(
  payload: JWTPayload,
  tokenVersion: number,
  tokenSource: TokenSource,
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
      // S1 fix (2026-06-10 security review) — surface which cookie /
      // header the token came from so handlers under
      // `/auth/onchain/*` can reject a legacy CIP-30 session before
      // proceeding into on-chain binding logic.
      tokenSource,
    },
  };
}
