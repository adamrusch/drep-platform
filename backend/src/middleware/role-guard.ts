import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import type { CommitteeMemberItem, UserRole } from '../lib/types';

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
 *
 * ⚠ Note: this honors a role globally — a caller who holds e.g.
 * `lead_drep` ANYWHERE passes the check. That's almost never what
 * you want for resource-scoped permissions: use
 * `requireOwnerOrCommitteeLead` instead when the resource belongs to
 * a SPECIFIC committee, so the lead-DRep override only fires when
 * the caller actually leads THAT committee.
 *
 * The 2026-05-28 P0-4 audit retired both prior callers of this helper
 * because they were both DRep-scoped resources (clubhouse posts and
 * action comments). The helper is kept for future use cases where a
 * truly platform-wide role override IS the intended semantic.
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

/**
 * Checks that the caller can act on a resource owned by `targetWallet`
 * within a SPECIFIC DRep committee:
 *
 *   - the caller IS the owner, OR
 *   - the caller is the lead DRep of `committee` (i.e. its
 *     `leadWallet`), OR
 *   - the caller is listed as a `lead_drep` in `committee.members`.
 *
 * Throws `AuthorizationError` otherwise.
 *
 * # Why this exists (P0-4, 2026-05-28 audit)
 *
 * The platform previously used `requireOwnerOrRole(authCtx, owner,
 * 'lead_drep')` for clubhouse post deletion, which honors the role
 * GLOBALLY: any wallet that ever registered a committee (and thus
 * holds `lead_drep` in its JWT claims) could delete posts in EVERY
 * clubhouse — including auto-posts owned by the governance feed.
 * Scoping the override to the committee being acted on closes the
 * privilege-escalation path.
 *
 * `committee` may be `undefined` when no committee row exists for the
 * resource's DRep (e.g. an auto-posted GA in a clubhouse whose lead
 * never registered). In that case there is no one with a lead-DRep
 * override and the owner-only branch applies.
 */
export function requireOwnerOrCommitteeLead(
  authCtx: AuthContext,
  targetWallet: string,
  committee: {
    leadWallet: string;
    members?: ReadonlyArray<CommitteeMemberItem>;
  } | undefined,
): void {
  if (authCtx.walletAddress === targetWallet) return;
  if (committee) {
    if (committee.leadWallet === authCtx.walletAddress) return;
    if (Array.isArray(committee.members)) {
      // A `lead_drep`-role member of this specific committee also
      // counts as a lead for moderation purposes. `committee_member`
      // and `trusted_delegator` do NOT — they have posting rights,
      // not moderation rights.
      const isLeadMember = committee.members.some(
        (m) => m.walletAddress === authCtx.walletAddress && m.role === 'lead_drep',
      );
      if (isLeadMember) return;
    }
  }
  throw new AuthorizationError(
    'You can only modify your own resources, or resources in committees you lead',
    403,
  );
}

/**
 * Strict owner-only check — no role override at all. Use this for
 * resources that have no meaningful "platform moderator" concept:
 * the only person who can delete is the author.
 *
 * # Why this exists (P0-4, 2026-05-28 audit)
 *
 * Action comments (`comments` table) are scoped to a governance
 * action, not a DRep, so there's no natural moderator. The previous
 * code used `requireOwnerOrRole(...,'lead_drep')` which let any
 * wallet holding a committee-lead role anywhere delete any comment on
 * any action. We chose option (a) from the audit brief — author-only
 * deletion, no global platform moderator — because the platform has
 * no product UX for action-scoped moderation and any future override
 * should be opt-in per resource, not piggy-backed on an existing
 * unrelated role.
 */
export function requireOwner(authCtx: AuthContext, targetWallet: string): void {
  if (authCtx.walletAddress !== targetWallet) {
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
