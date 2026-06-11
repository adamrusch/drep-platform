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

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);

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
    if (
      body.socialLinks !== undefined &&
      body.socialLinks !== null &&
      typeof body.socialLinks !== 'object'
    ) {
      return badRequest('socialLinks must be an object or null');
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
