/**
 * GET /clubhouse/{drepId}/rail/active-threads?limit=5
 *
 * Right-rail card data: top N posts in this clubhouse ranked by
 * "replies in the last 24 hours." See `_rail.ts` for the cache
 * contract and the ranking rationale.
 *
 * P0-3 migration (2026-05-28) — read path:
 *   1. Fetch posts (projects OUT inline `comments[]`).
 *   2. Filter to ACTIVE posts using the denormalized `lastReplyAt`.
 *   3. Per-active-post, Query `clubhouse_comments` with a slim
 *      projection (`authorWallet, createdAt, parentCommentId`).
 *      Cold posts are skipped entirely.
 *
 * The 60s in-Lambda cache (per `drepId`) means a hot-burst on the
 * same clubhouse shares one fetch + one ranker computation.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  fetchClubhousePosts,
  fetchPostComments,
  parseRailLimit,
  rankActiveThreads,
  selectActivePostsForRailQuery,
  RAIL_CACHE_MAX_ENTRIES,
  RAIL_CACHE_TTL_MS,
  MAX_RAIL_LIMIT,
  type ActiveThreadEntry,
  type RailCommentRow,
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

    // P0-3 migration — only Query comments for posts the denormalized
    // `lastReplyAt` says are active within the window. Pre-backfill
    // posts (no counter yet) with inline comments are also included so
    // the legacy inline path picks them up.
    const activePosts = selectActivePostsForRailQuery(posts, { now: new Date(now) });
    const commentsByPostId = new Map<string, RailCommentRow[]>();
    // Sequential is fine here — typical clubhouse has < 10 active
    // posts. Parallelizing would help in a pathological case but
    // would also burst against DDB; the 60s cache absorbs hot bursts.
    for (const post of activePosts) {
      try {
        const rows = await fetchPostComments(drepId, post.postId);
        commentsByPostId.set(post.postId, rows);
      } catch (err) {
        console.warn(
          `clubhouse/activeThreads: per-post Query failed for postId=${post.postId} drepId=${drepId}; falling back to inline:`,
          err,
        );
      }
    }

    const threads = rankActiveThreads(posts, {
      now: new Date(now),
      limit: MAX_RAIL_LIMIT,
      commentsByPostId,
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
