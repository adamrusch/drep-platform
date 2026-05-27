import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import type { UserRole } from '../lib/types';

export interface AuthContext {
  walletAddress: string;
  roles: UserRole[];
  /** The caller's REGISTERED-DRep id, if any (i.e. they completed
   *  `/drep/register`). This is NOT the DRep they delegate to — for
   *  that, see `lookupCurrentDrep` / `/auth/me`'s `delegatedToDrepId`.
   *  Renamed from `drepId` on 2026-05-27 for semantic clarity. */
  registeredDrepId?: string;
  sessionType?: string;
}

/**
 * Shape produced by our HTTP API v2 Lambda authorizer (simple response form).
 * Delivered to handlers at `event.requestContext.authorizer.lambda`.
 *
 * Both `registeredDrepId` (new) and `drepId` (legacy) are accepted on
 * read — the authorizer Lambda may still be on the old code path during
 * the rollout window where the authorizer Lambda and downstream handler
 * Lambdas redeploy independently. New field wins. Legacy field can be
 * removed from this shape after 2026-06-03 (one JWT TTL after rollout).
 */
interface LambdaAuthorizerContext {
  walletAddress?: string;
  roles?: string;
  sessionType?: string;
  registeredDrepId?: string;
  drepId?: string; // legacy — remove after 2026-06-03
}

/**
 * Extracts auth context from the HTTP API v2 Lambda authorizer context.
 *
 * For HTTP API v2 + Lambda authorizer (simple response), API Gateway delivers
 * the authorizer's returned `context` object at `event.requestContext.authorizer.lambda`.
 * Throws an AuthorizationError if no authorizer context is present (this should
 * never happen for routes protected by the authorizer).
 */
export function extractAuthContext(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): AuthContext {
  // We declare the event as `WithJWTAuthorizer` only to keep handler types
  // consistent. The runtime payload from a Lambda authorizer is
  // `authorizer.lambda`, so we cast through `unknown`.
  const authorizer = event.requestContext.authorizer as unknown as
    | { lambda?: LambdaAuthorizerContext }
    | undefined;
  const ctx = authorizer?.lambda;
  if (!ctx) {
    throw new AuthorizationError('No authorizer context found', 401);
  }

  const walletAddress = ctx.walletAddress;
  if (!walletAddress) {
    throw new AuthorizationError('Missing walletAddress in authorizer context', 401);
  }

  const rawRoles = ctx.roles;
  let roles: UserRole[] = [];
  if (rawRoles) {
    try {
      roles = JSON.parse(rawRoles) as UserRole[];
    } catch {
      roles = [rawRoles as UserRole];
    }
  }

  // Prefer the new field, fall back to legacy for in-flight authorizer
  // payloads. See the `LambdaAuthorizerContext` shape for the deletion
  // trigger date.
  const registeredDrepId = ctx.registeredDrepId ?? ctx.drepId;

  return {
    walletAddress,
    roles,
    registeredDrepId,
    sessionType: ctx.sessionType,
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
