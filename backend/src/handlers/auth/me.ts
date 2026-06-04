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
import { getItem, batchGetItems, tableNames } from '../../lib/dynamodb';
import type { DRepCommitteeItem, UserItem } from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { lookupCurrentDrep } from '../../lib/recognition';
import { listPendingInvitesForWallet } from '../committee/_committee';
import { ok, unauthorized, notFound, internalError } from '../_response';

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);

    // Fetch the stored user row, the live on-chain delegation, and any
    // pending committee invitations in parallel. The delegation lookup is
    // bounded (Koios 8s + Blockfrost fallback) and cached for 60s per
    // Lambda container; the GSI Query for pending invites is a single
    // partition lookup (sparse on the inviteeStake-status-index, scoped to
    // status='pending'), so it adds essentially zero latency. Failures on
    // either secondary lookup are non-fatal — the corresponding fields are
    // just omitted/empty in the response.
    const [user, delegationResult, pendingInvites] = await Promise.all([
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
      listPendingInvitesForWallet(authCtx.walletAddress).catch((err) => {
        // Same defensive pattern — the bell badge / Accept-Reject card
        // is a soft surface; if the GSI Query fails for any reason we
        // serve `pendingInvitations: []` and the user can still browse.
        console.warn('me handler: listPendingInvitesForWallet threw:', err);
        return [] as Awaited<ReturnType<typeof listPendingInvitesForWallet>>;
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

    // Denormalize committee names onto the pending-invitation view so the
    // bell badge and Accept-Reject card don't have to round-trip per row.
    // Batch-read every COMMITTEE row at once; missing committees (an
    // invite whose committee row vanished — shouldn't happen but defensive)
    // get an empty name string and the FE renders the drepId fallback.
    const committeeKeys = pendingInvites.map((i) => ({ drepId: i.drepId, SK: 'COMMITTEE' as const }));
    const committeeRows =
      committeeKeys.length > 0
        ? await batchGetItems<DRepCommitteeItem>(tableNames.drepCommittees, committeeKeys).catch((err) => {
            console.warn('me handler: committee batchGet for invites threw:', err);
            return [] as DRepCommitteeItem[];
          })
        : [];
    const nameByDrepId = new Map(committeeRows.map((c) => [c.drepId, c.committeeName] as const));
    const pendingInvitations = pendingInvites.map((i) => ({
      drepId: i.drepId,
      committeeName: nameByDrepId.get(i.drepId) ?? '',
      role: i.role,
      invitedAt: i.invitedAt,
    }));

    return ok(
      {
        ...safeUser,
        walletAddress: authCtx.walletAddress,
        roles: authCtx.roles,
        // Response field name kept as `drepId` (the public API surface
        // consumed by the SPA's auth store). Prefer the LIVE value from the
        // users row over the JWT claim: linking a DRep (`/drep/link`, auto-link,
        // or committee register) writes `users.drepId` but does NOT re-issue the
        // session JWT, so `authCtx.registeredDrepId` is stale until re-auth.
        // Reading the row (already fetched above) reflects the link immediately.
        drepId: user.drepId ?? authCtx.registeredDrepId,
        // `delegatedToDrepId` is the live on-chain delegation. See the
        // file-header comment for why this is a separate field from
        // `drepId` and which one each UX surface should consume.
        ...(delegatedToDrepId !== undefined ? { delegatedToDrepId } : {}),
        pendingInvitations,
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
