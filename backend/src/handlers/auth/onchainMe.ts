/**
 * GET /auth/onchain/me
 *
 * Decision #3 (2026-06-10) — on-chain "me" aggregation.
 *
 * Returns the caller's CANONICAL person profile + every on-chain
 * credential linked to them + the union of on-chain roles they've
 * proved. Distinct from the legacy `/auth/me` (which is wallet-keyed
 * and reads the `users` row); this endpoint reads the new
 * `onchain_users` + `identity_links` tables.
 *
 * The legacy `/auth/me` is UNTOUCHED — Decision #3 is additive.
 *
 * # personId resolution
 *
 * The JWT carries `personId` on tokens minted post-Decision-3. For
 * pre-Decision-3 on-chain tokens (already in circulation during the
 * rollout window), we fall back to a credential→person re-resolve:
 *
 *   1. Take the JWT's `sub` (the verified credential id) and the
 *      first `onChainRoles[]` claim (the role that login was under).
 *   2. Compose the namespaced `identityKey` and look it up in
 *      `identity_links`. If present, use its `personId`.
 *   3. If absent — that credential pre-dates Decision #3 entirely —
 *      auto-provision a person on the spot. The user will now be
 *      recognised consistently across subsequent calls.
 *
 * This fallback is purely a rolling-upgrade path; once every
 * outstanding session has been re-issued (≤30 days, the JWT max),
 * pre-Decision-3 tokens are gone and the fallback is dead code.
 *
 * # Roles surfaced
 *
 * The response's `onChainRoles` is the UNION across every linked
 * credential — derived from the credential type of each link row
 * (drep→drep, pool→spo, cc→cc, stake→proposer-or-wallet). We do NOT
 * re-validate role currency here (the daily role-revalidation cron
 * owns that) — the union answers "what roles has this person ever
 * proven on-chain?"
 *
 * # Cache headers
 *
 * `private, no-store` — same defence as the legacy `/auth/me`. This
 * endpoint is auth-bound and must NEVER be cached by any
 * intermediate proxy or shared cache.
 */
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { extractAuthContext } from '../../middleware/role-guard';
import {
  credentialTypeForRole,
  getPerson,
  getIdentityLink,
  identityKeyFor,
  listPersonCredentials,
  parseIdentityKey,
  resolveOrProvisionPerson,
} from '../../lib/identityPerson';
import type { IdentityCredentialType, OnChainRole } from '../../lib/types';
import { ok, unauthorized, notFound, internalError } from '../_response';

/** Map a credential type back to its login-time on-chain role.
 *  `stake` is ambiguous (could be a proposer login OR a future
 *  wallet-stake link) — we report `'proposer'` as the canonical role
 *  for a stake credential because that's what TODAY's surface mints.
 *  Decision #2 will refine this when the legacy wallet login publishes
 *  stake credentials directly. */
function roleForCredentialType(type: IdentityCredentialType): OnChainRole {
  switch (type) {
    case 'drep':
      return 'drep';
    case 'pool':
      return 'spo';
    case 'cc':
      return 'cc';
    case 'stake':
      return 'proposer';
    default: {
      const _exhaustive: never = type;
      throw new Error(`roleForCredentialType: unsupported type ${String(_exhaustive)}`);
    }
  }
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);

    // S1 fix (2026-06-10 security review) — reject legacy-cookie
    // sessions explicitly. Primary signal is `tokenSource === 'legacy'`
    // (post-S1 authorizer); the empty-onChainRoles backstop below
    // remains for in-flight authorizer rollout.
    if (authCtx.tokenSource === 'legacy') {
      return unauthorized(
        'This endpoint requires an on-chain session. Use /auth/me for legacy wallet sessions.',
      );
    }

    // ---- Resolve personId — JWT claim preferred, fallback to
    // credential→person re-resolve for pre-Decision-3 tokens ----
    let personId = authCtx.personId;
    if (!personId) {
      const carriedRoles = authCtx.onChainRoles ?? [];
      const carriedRole = carriedRoles[0];
      if (!carriedRole) {
        // Legacy CIP-30 session — no on-chain identity carried. This
        // endpoint is for the on-chain person model; legacy callers
        // should use `/auth/me` instead.
        return unauthorized(
          'This endpoint requires an on-chain session. Use /auth/me for legacy wallet sessions.',
        );
      }
      const type = credentialTypeForRole(carriedRole);
      const key = identityKeyFor(type, authCtx.walletAddress);
      const link = await getIdentityLink(key);
      if (link) {
        personId = link.personId;
      } else {
        // Token pre-dates Decision #3 entirely — auto-provision so
        // the user is recognised from here on. Idempotent: a
        // concurrent fallback that already minted a person wins.
        const provisioned = await resolveOrProvisionPerson(
          type,
          authCtx.walletAddress,
          'login',
        );
        personId = provisioned.personId;
      }
    }

    // ---- Read person row + every linked credential in parallel ----
    const [person, credentials] = await Promise.all([
      getPerson(personId),
      listPersonCredentials(personId),
    ]);

    if (!person) {
      // Defensive — the auto-provision path above should always
      // produce a row. A missing person row when we have a personId
      // means a hard data-integrity bug; surface a 404 so a future
      // audit can find it rather than masking it as a 5xx.
      return notFound('On-chain person');
    }

    // Derive role union from the credential types on the link rows.
    const roleSet = new Set<OnChainRole>();
    const credentialView = credentials.map((row) => {
      const parsed = parseIdentityKey(row.identityKey);
      const credentialType = parsed?.credentialType ?? row.credentialType;
      const credentialId = parsed?.credentialId ?? row.identityKey;
      const role = roleForCredentialType(credentialType);
      roleSet.add(role);
      return {
        identityKey: row.identityKey,
        credentialType,
        credentialId,
        role,
        verifiedAt: row.verifiedAt,
        verifiedVia: row.verifiedVia,
      };
    });

    return ok(
      {
        person: {
          personId: person.personId,
          ...(person.displayName ? { displayName: person.displayName } : {}),
          ...(person.bio ? { bio: person.bio } : {}),
          ...(person.socialLinks ? { socialLinks: person.socialLinks } : {}),
          createdAt: person.createdAt,
          updatedAt: person.updatedAt,
        },
        credentials: credentialView,
        onChainRoles: Array.from(roleSet),
        // Echo the session's own (sub, role) so the SPA can highlight
        // "you're currently signed in as this credential."
        currentSession: {
          identity: authCtx.walletAddress,
          onChainRoles: authCtx.onChainRoles ?? [],
        },
      },
      {
        'Cache-Control': 'private, no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
      },
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'AuthorizationError') {
      return unauthorized(err.message);
    }
    console.error('onchainMe handler error:', err);
    return internalError('Failed to fetch on-chain person');
  }
};
