/**
 * PUT /auth/onchain/profile
 *
 * Decision #3 (2026-06-10) — update the caller's on-chain person
 * profile.
 *
 * Body: `{ displayName?, bio?, socialLinks? }` — every field is
 * optional. Mirrors the legacy `/profile` upsert convention:
 *   - Absent key  → leave the prior value alone.
 *   - `null`      → clear the field.
 *   - A string    → trim + persist.
 *
 * Same validation bounds as the legacy profile (`displayName` ≤ 100,
 * `bio` ≤ 2000) so the SPA can reuse the same form-level guards.
 *
 * Auth contract: same as `/auth/onchain/me` — requires an on-chain
 * session.
 */
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { extractAuthContext } from '../../middleware/role-guard';
import {
  credentialTypeForRole,
  getIdentityLink,
  identityKeyFor,
  resolveOrProvisionPerson,
  updatePersonProfile,
} from '../../lib/identityPerson';
import type { SocialLinks } from '../../lib/types';
import { ok, badRequest, unauthorized, internalError } from '../_response';

interface ProfileUpdateBody {
  displayName?: string | null;
  bio?: string | null;
  socialLinks?: SocialLinks | null;
}

const MAX_DISPLAY_NAME = 100;
const MAX_BIO = 2_000;
/** S4 (2026-06-10 security review) — known social-link keys + per-value
 *  cap. Anything outside this allowlist or longer than the cap is
 *  rejected with a 400 so a caller can't stuff arbitrary keys onto the
 *  profile or pad an enormous value past the row-size budget. Matches
 *  the shape of the legacy `SocialLinks` type in `lib/types.ts`. */
const KNOWN_SOCIAL_LINK_KEYS = ['twitter', 'github', 'website', 'discord'] as const;
const MAX_SOCIAL_LINK_VALUE = 200;

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);

    // S1 fix (2026-06-10 security review) — reject legacy-cookie
    // sessions explicitly. The empty-onChainRoles backstop below
    // also fires for in-flight authorizers that pre-date S1.
    if (authCtx.tokenSource === 'legacy') {
      return unauthorized(
        'This endpoint requires an on-chain session. Use /profile for legacy wallet sessions.',
      );
    }

    if (!event.body) {
      return badRequest('Request body is required');
    }
    let body: ProfileUpdateBody;
    try {
      body = JSON.parse(event.body) as ProfileUpdateBody;
    } catch {
      return badRequest('Invalid JSON body');
    }

    // Validation
    if (body.displayName !== undefined && body.displayName !== null) {
      if (typeof body.displayName !== 'string' || body.displayName.trim().length === 0) {
        return badRequest('displayName must be a non-empty string or null');
      }
      if (body.displayName.length > MAX_DISPLAY_NAME) {
        return badRequest(`displayName exceeds maximum length of ${MAX_DISPLAY_NAME}`);
      }
    }
    if (body.bio !== undefined && body.bio !== null) {
      if (typeof body.bio !== 'string') {
        return badRequest('bio must be a string or null');
      }
      if (body.bio.length > MAX_BIO) {
        return badRequest(`bio exceeds maximum length of ${MAX_BIO}`);
      }
    }
    if (body.socialLinks !== undefined && body.socialLinks !== null) {
      if (typeof body.socialLinks !== 'object' || Array.isArray(body.socialLinks)) {
        return badRequest('socialLinks must be an object or null');
      }
      // S4 (2026-06-10 security review) — restrict to known keys + cap
      // each value at 200 chars so a caller can't stuff arbitrary keys
      // onto the profile or pad an enormous value past the row-size
      // budget. Use Object.prototype.hasOwnProperty to skip inherited
      // prototype-pollution noise.
      const entries = Object.entries(body.socialLinks as Record<string, unknown>);
      for (const [key, value] of entries) {
        if (!Object.hasOwn(body.socialLinks, key)) continue;
        if (!(KNOWN_SOCIAL_LINK_KEYS as readonly string[]).includes(key)) {
          return badRequest(
            `socialLinks contains unknown key '${key}' (allowed: ${KNOWN_SOCIAL_LINK_KEYS.join(', ')})`,
          );
        }
        if (value === undefined || value === null) {
          continue; // null/undefined clears that key — handled downstream.
        }
        if (typeof value !== 'string') {
          return badRequest(`socialLinks.${key} must be a string`);
        }
        if (value.length > MAX_SOCIAL_LINK_VALUE) {
          return badRequest(
            `socialLinks.${key} exceeds maximum length of ${MAX_SOCIAL_LINK_VALUE}`,
          );
        }
      }
    }

    let personId = authCtx.personId;
    if (!personId) {
      const carriedRoles = authCtx.onChainRoles ?? [];
      const carriedRole = carriedRoles[0];
      if (!carriedRole) {
        return unauthorized('This endpoint requires an on-chain session.');
      }
      const type = credentialTypeForRole(carriedRole);
      const key = identityKeyFor(type, authCtx.walletAddress);
      const link = await getIdentityLink(key);
      if (link) {
        personId = link.personId;
      } else {
        const provisioned = await resolveOrProvisionPerson(
          type,
          authCtx.walletAddress,
          'login',
        );
        personId = provisioned.personId;
      }
    }

    const updated = await updatePersonProfile(personId, {
      ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      ...(body.bio !== undefined ? { bio: body.bio } : {}),
      ...(body.socialLinks !== undefined ? { socialLinks: body.socialLinks } : {}),
    });

    return ok({
      personId: updated.personId,
      ...(updated.displayName ? { displayName: updated.displayName } : {}),
      ...(updated.bio ? { bio: updated.bio } : {}),
      ...(updated.socialLinks ? { socialLinks: updated.socialLinks } : {}),
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AuthorizationError') {
      return unauthorized(err.message);
    }
    console.error('onchainProfileUpdate handler error:', err);
    return internalError('Failed to update on-chain profile');
  }
};
