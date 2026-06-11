import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import type { CommitteeMemberItem, OnChainRole, UserRole } from '../lib/types';

/** S1 (2026-06-10 security review) — which cookie / header the token
 *  came in on. `/auth/onchain/*` handlers reject `legacy` so a
 *  CIP-30 cookie can never bind credentials in the on-chain personId
 *  model. Absent only on tests that construct an AuthContext by hand
 *  without going through the authorizer (treated as legacy by callers
 *  that gate on this). */
export type TokenSource = 'legacy' | 'onchain';

export interface AuthContext {
  walletAddress: string;
  roles: UserRole[];
  /** The caller's REGISTERED-DRep id, if any (i.e. they completed
   *  `/drep/register`). This is NOT the DRep they delegate to — for
   *  that, see `lookupCurrentDrep` / `/auth/me`'s `delegatedToDrepId`.
   *  Renamed from `drepId` on 2026-05-27 for semantic clarity. */
  registeredDrepId?: string;
  sessionType?: string;
  /** The session-revocation counter validated by the authorizer. Carried so
   *  `/auth/refresh` can re-mint at the current version without re-reading. */
  tokenVersion?: number;
  /** Roles the caller proved on-chain via the Sprint 1 `/auth/onchain/*`
   *  flow. Optional on the type so existing test stubs (and any pre-
   *  Sprint-1 caller that still constructs a context by hand) stay
   *  compatible without churn. Handlers that consult on-chain identity
   *  should read `authCtx.onChainRoles ?? []`; `requireOnChainRole` does
   *  this defensively. Parallel to `roles` — existing role-gated handlers
   *  continue to read `roles` and are completely unaffected. */
  onChainRoles?: OnChainRole[];
  /** The session id (ULID) of the caller's JWT. Present only on tokens
   *  issued after the per-session revocation path landed. Used by the
   *  logout handler to revoke just the current session. */
  jti?: string;
  /** Decision #3 (2026-06-10) — the caller's canonical `personId` for
   *  the on-chain identity subsystem. Present only on on-chain login
   *  tokens minted AFTER Decision #3 lands. Pre-Decision-3 on-chain
   *  tokens omit it; downstream handlers fall back to resolving via
   *  `identityKey` → `identity_links` (the credential the JWT `sub`
   *  carries). Legacy CIP-30 tokens omit it entirely — they're not
   *  participating in the on-chain person model. */
  personId?: string;
  /** S1 fix (2026-06-10 security review) — which cookie / header the
   *  token came in on (set by `jwt-authorizer`). `/auth/onchain/*`
   *  handlers MUST reject when this is `'legacy'` so a CIP-30 token
   *  can't bind credentials in the on-chain personId model. Absent on
   *  hand-built test contexts that bypass the authorizer; callers
   *  that gate on this should treat absence as a coarse signal —
   *  prefer the empty-`onChainRoles` backstop too. */
  tokenSource?: TokenSource;
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
  tokenVersion?: string;
  drepId?: string; // legacy — remove after 2026-06-03
  /** JSON-serialized `OnChainRole[]` — always emitted by the Sprint 1
   *  authorizer (possibly `'[]'`). Older authorizer Lambdas may omit it
   *  during rollout — treat absence as `[]`. */
  onChainRoles?: string;
  /** ULID session id forwarded from the authorizer for tokens issued
   *  after the per-session revocation path landed. */
  jti?: string;
  /** Decision #3 — canonical personId for the on-chain identity
   *  subsystem. Forwarded by the authorizer when present on the JWT. */
  personId?: string;
  /** S1 fix — which cookie / header the token came in on, forwarded
   *  by the Sprint 1 authorizer (post-S1). Older authorizer Lambdas
   *  in the rollout window may omit it; treat absence as `legacy`
   *  for the purpose of S1's reject-legacy check (defaults to the
   *  safer side — a request without an explicit `tokenSource` should
   *  not be allowed onto on-chain binding paths). */
  tokenSource?: string;
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

  const tokenVersion = ctx.tokenVersion !== undefined ? Number(ctx.tokenVersion) : undefined;

  // Parse the optional `onChainRoles` claim. Defensive: an authorizer that
  // pre-dates Sprint 1 doesn't emit the field; treat absence as `[]`. A
  // malformed value also degrades to `[]` rather than 401 — the field is
  // additive and never load-bearing for legacy auth.
  let onChainRoles: OnChainRole[] = [];
  if (ctx.onChainRoles) {
    try {
      const parsed = JSON.parse(ctx.onChainRoles) as unknown;
      if (Array.isArray(parsed)) {
        onChainRoles = parsed.filter(
          (r): r is OnChainRole =>
            r === 'drep' || r === 'spo' || r === 'cc' || r === 'proposer',
        );
      }
    } catch {
      onChainRoles = [];
    }
  }

  // S1 fix — parse the tokenSource forwarded by the authorizer (post
  // S1). Anything other than the two known values is dropped to
  // undefined so callers don't misread a typo as `onchain`.
  let tokenSource: TokenSource | undefined;
  if (ctx.tokenSource === 'legacy' || ctx.tokenSource === 'onchain') {
    tokenSource = ctx.tokenSource;
  }

  return {
    walletAddress,
    roles,
    registeredDrepId,
    sessionType: ctx.sessionType,
    ...(Number.isFinite(tokenVersion) ? { tokenVersion } : {}),
    onChainRoles,
    ...(ctx.jti ? { jti: ctx.jti } : {}),
    ...(ctx.personId ? { personId: ctx.personId } : {}),
    ...(tokenSource ? { tokenSource } : {}),
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
 * Checks that the caller proved at least one of the required on-chain
 * roles via the Sprint 1 `/auth/onchain/*` flow. Throws AuthorizationError
 * if not. NOTE: this is intentionally separate from `requireRole` because
 * `OnChainRole` and `UserRole` are parallel concepts — a `lead_drep`
 * (platform role) is distinct from a wallet that just proved DRep
 * registration on-chain (`drep` on-chain role).
 */
export function requireOnChainRole(
  authCtx: AuthContext,
  ...requiredRoles: OnChainRole[]
): void {
  const carried = authCtx.onChainRoles ?? [];
  const has = requiredRoles.some((r) => carried.includes(r));
  if (!has) {
    throw new AuthorizationError(
      `Insufficient on-chain proof. Required one of: ${requiredRoles.join(', ')}`,
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
