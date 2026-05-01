import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import type { UserRole } from '../lib/types';

export interface AuthContext {
  walletAddress: string;
  roles: UserRole[];
  drepId?: string;
}

/**
 * Extracts auth context from the Lambda authorizer context.
 * Throws a typed error if the event has no authorizer context.
 */
export function extractAuthContext(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): AuthContext {
  const ctx = event.requestContext.authorizer?.jwt?.claims;
  if (!ctx) {
    throw new AuthorizationError('No authorizer context found', 401);
  }

  const walletAddress = ctx['sub'] as string | undefined;
  if (!walletAddress) {
    throw new AuthorizationError('Missing sub claim in JWT', 401);
  }

  const rawRoles = ctx['roles'] as string | undefined;
  let roles: UserRole[] = [];
  if (rawRoles) {
    try {
      roles = JSON.parse(rawRoles) as UserRole[];
    } catch {
      roles = [rawRoles as UserRole];
    }
  }

  return {
    walletAddress,
    roles,
    drepId: ctx['drepId'] as string | undefined,
  };
}

/**
 * Checks that the caller has at least one of the required roles.
 * Throws AuthorizationError if not.
 */
export function requireRole(
  authCtx: AuthContext,
  ...requiredRoles: UserRole[]
): void {
  const hasRole = requiredRoles.some((r) => authCtx.roles.includes(r));
  if (!hasRole) {
    throw new AuthorizationError(
      `Insufficient permissions. Required one of: ${requiredRoles.join(', ')}`,
      403,
    );
  }
}

/**
 * Checks that the caller's walletAddress matches the target wallet,
 * OR that the caller has at least one of the override roles.
 */
export function requireOwnerOrRole(
  authCtx: AuthContext,
  targetWallet: string,
  ...overrideRoles: UserRole[]
): void {
  if (authCtx.walletAddress === targetWallet) return;
  const hasOverride = overrideRoles.some((r) => authCtx.roles.includes(r));
  if (!hasOverride) {
    throw new AuthorizationError('You can only modify your own resources', 403);
  }
}

// ---- Error class ----

export class AuthorizationError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode: 401 | 403) {
    super(message);
    this.name = 'AuthorizationError';
    this.statusCode = statusCode;
  }
}
