/**
 * GET /auth/onchain/profile
 *
 * Decision #3 (2026-06-10) — read the caller's on-chain person
 * profile (the `onchain_users` row).
 *
 * Minimal endpoint — returns only the editable profile fields. The
 * `/auth/onchain/me` aggregation gives the full view (profile +
 * credentials + role union); this one is for surfaces that only need
 * the bare profile to render a form.
 *
 * Auth contract: same as `/auth/onchain/me` — requires an on-chain
 * session (the JWT must carry `onChainRoles[]`, optionally
 * `personId`). Legacy CIP-30 sessions are rejected with 401.
 */
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { extractAuthContext } from '../../middleware/role-guard';
import {
  credentialTypeForRole,
  getPerson,
  getIdentityLink,
  identityKeyFor,
  resolveOrProvisionPerson,
} from '../../lib/identityPerson';
import { ok, unauthorized, notFound, internalError } from '../_response';

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);

    let personId = authCtx.personId;
    if (!personId) {
      const carriedRoles = authCtx.onChainRoles ?? [];
      const carriedRole = carriedRoles[0];
      if (!carriedRole) {
        return unauthorized(
          'This endpoint requires an on-chain session. Use /profile for legacy wallet sessions.',
        );
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

    const person = await getPerson(personId);
    if (!person) {
      return notFound('On-chain person');
    }

    return ok(
      {
        personId: person.personId,
        ...(person.displayName ? { displayName: person.displayName } : {}),
        ...(person.bio ? { bio: person.bio } : {}),
        ...(person.socialLinks ? { socialLinks: person.socialLinks } : {}),
        createdAt: person.createdAt,
        updatedAt: person.updatedAt,
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
    console.error('onchainProfileGet handler error:', err);
    return internalError('Failed to fetch on-chain profile');
  }
};
