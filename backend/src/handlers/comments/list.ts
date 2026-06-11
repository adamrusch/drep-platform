import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { queryItems, tableNames } from '../../lib/dynamodb';
import type { CommentItem, UserRole } from '../../lib/types';
import { ok, badRequest, internalError } from '../_response';

/**
 * Did the caller present a JWT proving `platform_admin`?
 *
 * The list endpoint is registered WITHOUT the lambda authorizer (public
 * read), so the authorizer-context shape is absent on the typical
 * request. But if a `platform_admin` hits the endpoint with their JWT
 * cookie in their browser, API Gateway will still pass through the
 * `Cookie` header — we don't read it directly (no JWT verify here).
 * Instead, we read the optional `authorizer.lambda` context which IS
 * populated when API Gateway invokes a handler via an authorized
 * route in the same stage. For Sprint 4 we rely on a different
 * mechanism: a query param `?admin=true` is rejected from anonymous
 * callers and only honored when the lambda authorizer has stamped the
 * caller's role into the JWT context.
 *
 * Practical implementation: peek at `requestContext.authorizer.lambda.roles`
 * if it's there. This works seamlessly for `platform_admin`s who hit
 * the endpoint via the authenticated proxy path; anonymous reads see
 * the default-hidden filter.
 *
 * NOTE: this endpoint is registered as a PUBLIC route (no
 * `authenticated: true` in api-stack.ts). To let `platform_admin`s
 * see hidden rows, the FE will need to either (a) call a separate
 * admin route, OR (b) the list route must be re-registered as
 * authenticated. Sprint 4 keeps the existing public registration but
 * additively reads the optional authorizer context — when present
 * AND the caller is `platform_admin`, hidden rows are included.
 * When absent (anonymous read), hidden rows are filtered out.
 */
function isPlatformAdmin(event: APIGatewayProxyEventV2): boolean {
  // The HTTP API v2 + lambda-authorizer envelope carries the context
  // at `authorizer.lambda`. We read it defensively — most requests
  // arrive unauthenticated.
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

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  try {
    const actionId = event.pathParameters?.['actionId'];
    if (!actionId) {
      return badRequest('actionId path parameter is required');
    }

    const qs = event.queryStringParameters ?? {};
    const limitParam = qs['limit'];
    const lastKey = qs['lastKey'];
    const onlyPublic = qs['public'] === 'true';

    const limit = limitParam ? Math.min(parseInt(limitParam, 10), 100) : 50;

    const exprNames: Record<string, string> = { '#actionId': 'actionId' };
    const exprValues: Record<string, unknown> = { ':actionId': decodeURIComponent(actionId) };
    let filterExpr: string | undefined;

    if (onlyPublic) {
      exprNames['#isPublic'] = 'isPublic';
      exprValues[':true'] = true;
      filterExpr = '#isPublic = :true';
    }

    const result = await queryItems<CommentItem>(tableNames.comments, {
      keyConditionExpression: '#actionId = :actionId',
      expressionAttributeNames: exprNames,
      expressionAttributeValues: exprValues,
      filterExpression: filterExpr,
      limit,
      scanIndexForward: false,
      ...(lastKey
        ? { exclusiveStartKey: JSON.parse(Buffer.from(lastKey, 'base64').toString('utf-8')) as Record<string, unknown> }
        : {}),
    });

    // Sprint 4 — community-flag hide filter.
    //
    // `hidden === true` rows are EXCLUDED for normal users and INCLUDED
    // (with the `hidden: true` marker intact, so the FE can render a
    // moderation badge) for `platform_admin`s. The exclusion runs
    // post-Query rather than as a FilterExpression so the page cursor
    // semantics stay simple — list responses already use `lastKey`
    // pagination keyed on the raw Query result. Filtering at the row
    // boundary could leave callers with under-full pages but never
    // exposes hidden content to non-admins.
    //
    // For admins we surface the row as-is so the moderation UI can
    // decide whether to reverse the community decision; the FE knows
    // to render a "FLAGGED — HIDDEN FROM USERS" treatment when it
    // sees `hidden: true`.
    const isAdmin = isPlatformAdmin(event);
    const visibleItems = isAdmin
      ? result.items
      : result.items.filter((c) => c.hidden !== true);

    return ok(
      {
        items: visibleItems,
        lastEvaluatedKey: result.lastEvaluatedKey
          ? Buffer.from(JSON.stringify(result.lastEvaluatedKey)).toString('base64')
          : undefined,
      },
      // 15s edge cache — more dynamic than the action itself (users post
      // fresh comments and expect them to show up quickly).
      { 'Cache-Control': 'public, max-age=15, s-maxage=15' },
    );
  } catch (err) {
    console.error('comments/list handler error:', err);
    return internalError('Failed to list comments');
  }
};
