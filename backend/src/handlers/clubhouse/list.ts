import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { queryItems, tableNames } from '../../lib/dynamodb';
import type { ClubhousePostItem, UserRole } from '../../lib/types';
import { ok, badRequest, internalError } from '../_response';

/** Defensive read of optional authorizer context (Sprint 4) — same
 *  pattern as `handlers/comments/list.ts`. The clubhouse list is
 *  registered as a PUBLIC route; admins reach it via an authenticated
 *  cookie which the API Gateway authorizer stamps onto the event
 *  context when present. Anonymous reads see the default hide filter. */
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

/**
 * GET /clubhouse/{drepId}
 *
 * List the posts in one clubhouse, newest-first by ULID. After the
 * P0-3 de-inline migration (2026-05-28) this handler projects OUT
 * the inline `comments` field — the per-post `commentCount` counter
 * is enough to render the collapsed-card "{n} replies" badge, and
 * the full thread loads lazily via `GET /clubhouse/{drepId}/post/
 * {postId}/comments` only when the panel is expanded.
 *
 * # Why projection vs in-handler strip
 *
 * Projecting at the Query level means DynamoDB never pulls the
 * comments attribute off disk — for a clubhouse with a large
 * `comments[]` on every post (worst case: ~80 × 5KB = ~400KB per
 * post × 20 posts = ~8MB of data we'd otherwise spool). The
 * projection is a free perf win and a cost win (fewer RCUs charged
 * for hot reads).
 *
 * # Rotation contract
 *
 * The frontend tolerates BOTH old (with inline `comments[]`) and new
 * (without) shapes:
 *   - badge: `commentCount ?? comments?.length ?? 0`
 *   - thread: lazy `useClubhouseComments(drepId, postId)` fetch
 *
 * Until the backfill runs, posts will have `commentCount` undefined
 * (older rows) — the FE falls back to `comments?.length`, which is
 * itself missing here because of the projection. Net effect during
 * rotation: an unbackfilled post shows "0 replies" momentarily
 * until the badge re-renders post-backfill. That's preferable to
 * spooling the entire inline payload for every list request.
 *
 * **Important:** if you need to support a clean rollback to the
 * old read path while still keeping the new write path alive,
 * remove the `ProjectionExpression` below — that lone change keeps
 * the inline array on the wire and the FE's `comments?.length`
 * fallback works. The backfill is unaffected.
 */
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  try {
    const drepId = event.pathParameters?.['drepId'];
    if (!drepId) {
      return badRequest('drepId path parameter is required');
    }

    const qs = event.queryStringParameters ?? {};
    const limitParam = qs['limit'];
    const lastKey = qs['lastKey'];

    const limit = limitParam ? Math.min(parseInt(limitParam, 10), 50) : 20;

    // Projection: every persisted field EXCEPT `comments`. We use a
    // ProjectionExpression that explicitly names the keep-list rather
    // than the DynamoDB-doesn't-have-it "exclude" operator (there is
    // no such operator — Project lists are include-only). Listing the
    // ~20 fields is verbose but explicit; missing-field tolerance on
    // the frontend means a future schema addition that we forget to
    // add here results in a transient missing-field render, not a
    // crash. That trade matches Adam's "we'll catch it" preference
    // over hidden surprises.
    //
    // The list is alphabetical for code-review-ability, not for any
    // DDB ordering reason.
    const projection = [
      // Identity & timestamps
      'drepId',
      'postId',
      'createdAt',
      'updatedAt',
      // Author + display chrome
      'authorWallet',
      'authorDisplayName',
      'isDRepPost',
      'stakeAda',
      'drep',
      // Content
      'body',
      'title',
      'type',
      // Poll fields
      'pollOptions',
      'pollMultiple',
      'pollClosesAt',
      'pollVotes',
      // Auto-post chrome
      'pinned',
      'autoSource',
      'linkedActionId',
      // Denormalized counters (P0-3 migration)
      'commentCount',
      'lastReplyAt',
      // Sprint 4 — community-flag denormalised counters. `flagCount`
      // surfaces the per-row flag headcount and `hidden` is the
      // threshold-reached marker. Projecting both means the post-Query
      // filter step below can decide visibility without an extra
      // round-trip; `platform_admin` callers also need them surfaced
      // verbatim on the wire for the moderation UI's "FLAGGED" badge.
      'flagCount',
      'hidden',
    ];
    // `body` collides with the AWS-SDK reserved-word "Body" via case-
    // folded matching in some bundler setups; using ExpressionAttributeNames
    // for every field keeps the surface free of accidental keyword
    // collisions on future additions.
    const expressionAttributeNames: Record<string, string> = {};
    const projectionExpression = projection
      .map((field, idx) => {
        const alias = `#p${idx}`;
        expressionAttributeNames[alias] = field;
        return alias;
      })
      .join(', ');

    const result = await queryItems<ClubhousePostItem>(tableNames.clubhousePosts, {
      keyConditionExpression: '#drepId = :drepId',
      expressionAttributeNames: { ...expressionAttributeNames, '#drepId': 'drepId' },
      expressionAttributeValues: { ':drepId': decodeURIComponent(drepId) },
      limit,
      scanIndexForward: false,
      projectionExpression,
      ...(lastKey
        ? { exclusiveStartKey: JSON.parse(Buffer.from(lastKey, 'base64').toString('utf-8')) as Record<string, unknown> }
        : {}),
    });

    // Sprint 4 — community-flag hide filter. `hidden === true` rows
    // are EXCLUDED for normal users and INCLUDED (with the marker
    // intact) for `platform_admin`s so the moderation UI can render a
    // distinct "FLAGGED — HIDDEN" treatment. The filter runs post-
    // Query for the same lastKey-pagination simplicity rationale
    // documented in `handlers/comments/list.ts`.
    const isAdmin = isPlatformAdmin(event);
    const visibleItems = isAdmin
      ? result.items
      : result.items.filter((p) => p.hidden !== true);

    return ok({
      items: visibleItems,
      lastEvaluatedKey: result.lastEvaluatedKey
        ? Buffer.from(JSON.stringify(result.lastEvaluatedKey)).toString('base64')
        : undefined,
    });
  } catch (err) {
    console.error('clubhouse/list handler error:', err);
    return internalError('Failed to list clubhouse posts');
  }
};
