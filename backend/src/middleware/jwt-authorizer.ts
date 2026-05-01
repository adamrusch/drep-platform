import type {
  APIGatewayRequestAuthorizerEventV2,
  APIGatewaySimpleAuthorizerResult,
} from 'aws-lambda';
import { verifyJWT, extractTokenFromCookie } from '../lib/auth';
import type { JWTPayload } from '../lib/types';

/**
 * Lambda JWT Authorizer for API Gateway HTTP API (payload version 2.0).
 * Returns a simple authorizer response with context populated from JWT claims.
 */
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
      ...(payload.drepId ? { drepId: payload.drepId } : {}),
    },
  };
}
