/**
 * GET /auth/me
 *
 * Returns the authenticated user's profile + roles + drepId, derived from
 * the JWT cookie. The frontend calls this on mount to determine sign-in
 * state and roles for conditional rendering.
 *
 * Sensitive fields (`sessionTokenHash`, `sessionExpiry`) are stripped before
 * the response is serialized.
 *
 * Cache headers explicitly forbid sharing: this endpoint MUST NOT be cached
 * by any intermediate proxy or CloudFront. The `/auth/*` CloudFront behavior
 * is already on a no-cache passthrough; the explicit `private, no-store`
 * header makes accidental sharing a bug instead of a silent leak.
 *
 * # Two `drepId` fields, on purpose
 *
 * The response carries TWO `drepId`-shaped fields. They mean different
 * things and frontend code that mixes them up causes "my wallet's DRep
 * isn't recognized" bugs:
 *
 *   - **`drepId`** — the user's REGISTERED-DRep id. Set when this wallet
 *     ran the `/drep/register` flow and became a DRep themselves. Used
 *     for role gating (is the caller a lead DRep / committee member of
 *     their own committee). NEVER reflects which DRep the wallet
 *     *delegates* to — those are two different concepts on-chain.
 *     Persists across sessions in the JWT; refreshes only on re-auth.
 *
 *   - **`delegatedToDrepId`** — the DRep this wallet's stake currently
 *     delegates voting power to. Read live from Koios (Blockfrost
 *     fallback) on every `/auth/me` call, cached for 60s per Lambda
 *     container. `null` means "wallet has no on-chain delegation cert".
 *     `undefined` (field absent) means we couldn't determine it —
 *     payment-address auth, or both providers failed. The Clubhouse
 *     landing / "your DRep" UX should use THIS field, not `drepId`.
 */
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getItem, tableNames } from '../../lib/dynamodb';
import type { UserItem } from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { lookupCurrentDrep } from '../../lib/recognition';
import { ok, unauthorized, notFound, internalError } from '../_response';

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);

    // Fetch the stored user row and resolve the live on-chain delegation
    // in parallel. The delegation lookup is bounded (Koios 8s + Blockfrost
    // fallback) and cached for 60s per Lambda container; on the warm path
    // it adds essentially zero latency. Failures are non-fatal — the
    // field is just omitted from the response.
    const [user, delegationResult] = await Promise.all([
      getItem<UserItem>(tableNames.users, {
        walletAddress: authCtx.walletAddress,
        SK: 'PROFILE',
      }),
      lookupCurrentDrep(authCtx.walletAddress).catch((err) => {
        // Defensive — `lookupCurrentDrep` already swallows its own
        // upstream errors, but if a future revision throws we don't
        // want `/auth/me` to fail the whole request over a soft signal.
        console.warn('me handler: lookupCurrentDrep threw:', err);
        return { drepId: null, source: null } as const;
      }),
    ]);

    if (!user) {
      return notFound('User');
    }

    // Strip sensitive fields before returning
    const { sessionTokenHash: _sessionTokenHash, sessionExpiry: _sessionExpiry, ...safeUser } = user;

    // Only surface `delegatedToDrepId` when we got a definitive answer
    // (source !== null). `source === null` means "both providers failed"
    // — surfacing `null` would be indistinguishable from "address is not
    // delegated" and the frontend would render "no DRep" wrongly.
    const delegatedToDrepId =
      delegationResult.source !== null ? delegationResult.drepId : undefined;

    return ok(
      {
        ...safeUser,
        walletAddress: authCtx.walletAddress,
        roles: authCtx.roles,
        drepId: authCtx.drepId,
        // `delegatedToDrepId` is the live on-chain delegation. See the
        // file-header comment for why this is a separate field from
        // `drepId` and which one each UX surface should consume.
        ...(delegatedToDrepId !== undefined ? { delegatedToDrepId } : {}),
      },
      // Defense in depth: this endpoint is auth-bound and MUST NOT be
      // shared between users. The CloudFront distribution in front of
      // the API has /auth/* on a no-cache behavior, but emitting an
      // explicit `private, no-store` header makes it a bug if any
      // shared cache (intermediate proxy, browser bf-cache) ever picks
      // it up.
      {
        'Cache-Control': 'private, no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
      },
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'AuthorizationError') {
      return unauthorized(err.message);
    }
    console.error('me handler error:', err);
    return internalError('Failed to fetch user');
  }
};
