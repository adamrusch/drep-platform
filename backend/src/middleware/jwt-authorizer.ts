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
 */
import type {
  APIGatewayRequestAuthorizerEventV2,
  APIGatewaySimpleAuthorizerResult,
} from 'aws-lambda';
import { verifyJWT, extractTokenFromCookie } from '../lib/auth';
import type { JWTPayload } from '../lib/types';


export const handler = async (
  event: APIGatewayRequestAuthorizerEventV2,
): Promise<APIGatewaySimpleAuthorizerResult> => {
  try {
    const token = extractToken(event);
    if (!token) {
      return { isAuthorized: false };
    }

    const payload = await verifyJWT(token);
    return buildAuthorizedResponse(payload);
  } catch (err) {
    console.warn('JWT authorizer rejected request:', err instanceof Error ? err.message : err);
    return { isAuthorized: false };
  }
};

function extractToken(event: APIGatewayRequestAuthorizerEventV2): string | null {
  // 1. Try Authorization header (Bearer token)
  const authHeader = event.headers?.['authorization'] ?? event.headers?.['Authorization'];
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // 2. Try httpOnly cookie
  const cookieHeader = event.cookies?.join('; ');
  const fromCookie = extractTokenFromCookie(cookieHeader);
  if (fromCookie) {
    return fromCookie;
  }

  return null;
}

function buildAuthorizedResponse(payload: JWTPayload): APIGatewaySimpleAuthorizerResult & {
  context: Record<string, string>;
} {
  return {
    isAuthorized: true,
    context: {
      walletAddress: payload.sub,
      roles: JSON.stringify(payload.roles),
      sessionType: payload.sessionType,
      ...(payload.registeredDrepId ? { registeredDrepId: payload.registeredDrepId } : {}),
    },
  };
}
