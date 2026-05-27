/**
 * GET /clubhouse/{drepId}/rail/active-threads?limit=5
 *
 * Right-rail card data: top N posts in this clubhouse ranked by
 * "replies in the last 24 hours." See `_rail.ts` for the cache
 * contract and the ranking rationale.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  fetchClubhousePosts,
  parseRailLimit,
  rankActiveThreads,
  RAIL_CACHE_MAX_ENTRIES,
  RAIL_CACHE_TTL_MS,
  MAX_RAIL_LIMIT,
  type ActiveThreadEntry,
} from './_rail';
import { ok, badRequest, internalError } from '../_response';

interface ActiveThreadsCacheEntry {
  fetchedAt: number;
  threads: ActiveThreadEntry[];
}
const _activeThreadsCache = new Map<string, ActiveThreadsCacheEntry>();

/** Test-only escape hatch. */
export function _resetActiveThreadsCache(): void {
  _activeThreadsCache.clear();
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const drepIdRaw = event.pathParameters?.['drepId'];
    if (!drepIdRaw) {
      return badRequest('drepId path parameter is required');
    }
    const drepId = decodeURIComponent(drepIdRaw);
    const limit = parseRailLimit(event.queryStringParameters?.['limit']);

    const now = Date.now();
    const cached = _activeThreadsCache.get(drepId);
    if (cached && now - cached.fetchedAt < RAIL_CACHE_TTL_MS) {
      return ok({ items: cached.threads.slice(0, limit) });
    }

    const posts = await fetchClubhousePosts(drepId);
    const threads = rankActiveThreads(posts, {
      now: new Date(now),
      limit: MAX_RAIL_LIMIT,
    });
    _activeThreadsCache.set(drepId, { fetchedAt: now, threads });
    if (_activeThreadsCache.size > RAIL_CACHE_MAX_ENTRIES) {
      const oldest = _activeThreadsCache.keys().next().value;
      if (oldest !== undefined) _activeThreadsCache.delete(oldest);
    }
    return ok({ items: threads.slice(0, limit) });
  } catch (err) {
    console.error('clubhouse/activeThreads handler error:', err);
    return internalError('Failed to load active threads');
  }
};
