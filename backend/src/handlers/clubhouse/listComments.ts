/**
 * GET /clubhouse/{drepId}/post/{postId}/comments
 *
 * Lazy-load the per-row comments for a single Clubhouse post. The
 * collapsed post card on the frontend renders only the count badge
 * (off the denormalized `commentCount` field on the post row); the
 * full thread is fetched only when the user expands the panel.
 *
 * Returns every comment under one `postKey` partition in a single
 * `Query`, ULID-ordered (ascending = oldest first), with `depth`
 * preserved so the frontend can render the 2-level threading the same
 * way it does today against the inline array.
 *
 * # Response shape
 *
 * ```json
 * {
 *   "data": {
 *     "items": [ClubhouseComment, ClubhouseComment, ...]
 *   }
 * }
 * ```
 *
 * Each `items[i]` matches the same `ClubhouseComment` wire shape the
 * frontend already consumes from the inline array — `commentId`,
 * `authorWallet`, `authorDisplayName?`, `body`, `createdAt`,
 * `parentCommentId?`. The FE bucket-by-parent grouping logic in
 * `DelegatorClubhouse.tsx` works unchanged.
 *
 * No auth on this read — comments are public-read alongside the
 * containing post. The membership gate is only on writes.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { queryItems, tableNames } from '../../lib/dynamodb';
import {
  clubhouseCommentPostKey,
  type ClubhouseCommentRowItem,
  type UserRole,
} from '../../lib/types';
import { ok, badRequest, internalError } from '../_response';

/**
 * Did the caller present a JWT proving `platform_admin`?
 *
 * Mirrors `handlers/comments/list.ts::isPlatformAdmin`. This endpoint is
 * registered as a PUBLIC route (no `authenticated: true` in
 * `api-stack.ts`), so the authorizer-context shape is typically absent.
 * When a `platform_admin` hits the endpoint with their JWT cookie in
 * the browser, API Gateway will still pass through the `Cookie` header,
 * and the optional `authorizer.lambda.roles` claim is populated if the
 * lambda authorizer is wired on the route. We read it defensively —
 * absent context means "anonymous read, hide flagged rows."
 */
function isPlatformAdmin(event: APIGatewayProxyEventV2): boolean {
  const rc = event.requestContext as unknown as {
    authorizer?: { lambda?: { roles?: string } };
  };
  const rawRoles = rc.authorizer?.lambda?.roles;
  if (!rawRoles) return false;
  try {
    const parsed = JSON.parse(rawRoles) as UserRole[];
    return Array.isArray(parsed) && parsed.includes('platform_admin');
  } catch {
    return false;
  }
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const drepIdRaw = event.pathParameters?.['drepId'];
    const postIdRaw = event.pathParameters?.['postId'];
    if (!drepIdRaw || !postIdRaw) {
      return badRequest('drepId and postId path parameters are required');
    }
    const drepId = decodeURIComponent(drepIdRaw);
    const postId = decodeURIComponent(postIdRaw);
    const postKey = clubhouseCommentPostKey(drepId, postId);

    // Single-partition Query — every comment for one post lives under
    // one `postKey`. ScanIndexForward defaults to true so we get
    // ULID-ascending (oldest first), which matches the on-the-wire
    // order the frontend already expects from the inline array.
    //
    // Defensive pagination: at ~10 comments median × 1KB row size,
    // even a pathological post with 400 comments fits in a single 1MB
    // DDB page. The loop is here to handle the truly unbounded case
    // without burning a Lambda timeout.
    const items: ClubhouseCommentRowItem[] = [];
    let lastKey: Record<string, unknown> | undefined;
    let pageGuard = 0;
    while (pageGuard++ < 10) {
      const result = await queryItems<ClubhouseCommentRowItem>(
        tableNames.clubhouseComments,
        {
          keyConditionExpression: '#pk = :v',
          expressionAttributeNames: { '#pk': 'postKey' },
          expressionAttributeValues: { ':v': postKey },
          ...(lastKey ? { exclusiveStartKey: lastKey } : {}),
        },
      );
      for (const it of result.items) items.push(it);
      if (!result.lastEvaluatedKey) break;
      lastKey = result.lastEvaluatedKey;
    }

    // Sprint 4 follow-up — community-flag hide filter for clubhouse
    // comments. Mirrors `handlers/comments/list.ts`:
    //   - `hidden === true` rows are EXCLUDED for normal users.
    //   - For `platform_admin`s the row is INCLUDED with the
    //     `hidden: true` marker intact so the moderation UI can decide
    //     whether to reverse the community decision.
    // The filter runs post-Query (rather than as a FilterExpression)
    // so the simple page cursor semantics inherited from the rotation
    // tests stay intact.
    const isAdmin = isPlatformAdmin(event);
    const visibleItems = isAdmin
      ? items
      : items.filter((c) => c.hidden !== true);

    // Strip the partition-key bookkeeping (`postKey`, `drepId`,
    // `postId`, `depth`) before returning. The FE's `ClubhouseComment`
    // type is the legacy inline shape; preserving it keeps the
    // listComments response interchangeable with the inline-array
    // fallback during rotation.
    //
    // `authorDelegationActive` (Batch CLUBHOUSE-DELEGATION-GATE,
    // 2026-05-30) is surfaced ONLY when explicitly false — the absent
    // / true / undefined case all mean "active" on the frontend and
    // omitting the field saves wire bytes for the vast majority of
    // rows. The frontend renders the "no longer delegated" badge
    // strictly on `authorDelegationActive === false`.
    //
    // Sprint 4 follow-up: `flagCount` and `hidden` are surfaced so the
    // FE can render a "Flagged" affordance state and (for admins) a
    // "HIDDEN BY COMMUNITY" banner. Both default to absent when zero
    // / not hidden to save wire bytes on the common case.
    const responseItems = visibleItems.map((row) => ({
      commentId: row.commentId,
      authorWallet: row.authorWallet,
      body: row.body,
      createdAt: row.createdAt,
      ...(row.authorDisplayName ? { authorDisplayName: row.authorDisplayName } : {}),
      ...(row.parentCommentId ? { parentCommentId: row.parentCommentId } : {}),
      ...(row.authorDelegationActive === false
        ? { authorDelegationActive: false as const }
        : {}),
      ...(typeof row.flagCount === 'number' && row.flagCount > 0
        ? { flagCount: row.flagCount }
        : {}),
      ...(row.hidden === true ? { hidden: true as const } : {}),
    }));

    return ok({ items: responseItems });
  } catch (err) {
    console.error('clubhouse/listComments handler error:', err);
    return internalError('Failed to list clubhouse comments');
  }
};
