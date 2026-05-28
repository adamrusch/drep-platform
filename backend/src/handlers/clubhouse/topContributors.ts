/**
 * GET /clubhouse/{drepId}/rail/top-contributors?limit=5
 *
 * Right-rail card data: top N wallets ranked by clubhouse
 * participation. See `_rail.ts` for the cache contract, the
 * scoring formula, and the "why count, not stake-weighted today"
 * judgment-call rationale.
 *
 * P0-3 migration (2026-05-28) — read path: when the post carries
 * the denormalized `lastReplyAt`, attribute comments by Querying
 * `clubhouse_comments` for that post. Pre-backfill posts fall back
 * to the inline `comments[]` walk inside the ranker.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { batchGetItems, tableNames } from '../../lib/dynamodb';
import type { UserItem } from '../../lib/types';
import {
  fetchClubhousePosts,
  fetchPostComments,
  parseRailLimit,
  rankTopContributors,
  RAIL_CACHE_MAX_ENTRIES,
  RAIL_CACHE_TTL_MS,
  MAX_RAIL_LIMIT,
  type TopContributorEntry,
  type RailCommentRow,
} from './_rail';
import { ok, badRequest, internalError } from '../_response';

interface TopContributorsCacheEntry {
  fetchedAt: number;
  contributors: TopContributorEntry[];
}
const _topContributorsCache = new Map<string, TopContributorsCacheEntry>();

/** Test-only escape hatch. */
export function _resetTopContributorsCache(): void {
  _topContributorsCache.clear();
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
    const cached = _topContributorsCache.get(drepId);
    if (cached && now - cached.fetchedAt < RAIL_CACHE_TTL_MS) {
      return ok({ items: cached.contributors.slice(0, limit) });
    }

    const posts = await fetchClubhousePosts(drepId);

    // P0-3 migration: per-post `Query` against `clubhouse_comments`
    // for every post that the denormalized counters say HAS comments.
    // Cold posts (commentCount === 0) skip the round-trip entirely.
    //
    // Note: top-contributors doesn't have an "active in 24h" filter —
    // historical participants count too — so we Query every post
    // with `commentCount > 0`. For a clubhouse with many posts this
    // could be N Queries; the 60s cache amortizes the burst.
    const postsNeedingFetch = posts.filter((p) => {
      if (p.type === 'auto_ga') {
        // Auto-posts are skipped from the wallet attribution itself
        // (the system wallet is excluded), but their organic replies
        // DO count, so we still need to Query them.
      }
      return (
        typeof p.commentCount === 'number' && p.commentCount > 0
      );
    });
    const commentsByPostId = new Map<string, RailCommentRow[]>();
    for (const post of postsNeedingFetch) {
      try {
        const rows = await fetchPostComments(drepId, post.postId);
        commentsByPostId.set(post.postId, rows);
      } catch (err) {
        console.warn(
          `clubhouse/topContributors: per-post Query failed for postId=${post.postId} drepId=${drepId}; falling back to inline:`,
          err,
        );
      }
    }

    const ranked = rankTopContributors(posts, {
      limit: MAX_RAIL_LIMIT,
      commentsByPostId,
    });

    // Best-effort displayName resolution. Misses are non-fatal —
    // the FE renders truncated wallets when no name is available.
    // BatchGet caps at 100 keys; `ranked` is <= MAX_RAIL_LIMIT = 25 today.
    let displayNameByWallet = new Map<string, string>();
    if (ranked.length > 0) {
      try {
        const userRows = await batchGetItems<UserItem>(
          tableNames.users,
          ranked.map((r) => ({ walletAddress: r.walletAddress, SK: 'PROFILE' })),
        );
        for (const u of userRows) {
          if (typeof u.displayName === 'string' && u.displayName.trim().length > 0) {
            displayNameByWallet.set(u.walletAddress, u.displayName);
          }
        }
      } catch (err) {
        // Soft failure — proceed without names.
        console.warn(
          `clubhouse/topContributors: displayName batchGet failed for ${drepId}:`,
          err,
        );
        displayNameByWallet = new Map();
      }
    }

    const contributors: TopContributorEntry[] = ranked.map((r) => ({
      walletAddress: r.walletAddress,
      contributionCount: r.contributionCount,
      ...(displayNameByWallet.has(r.walletAddress)
        ? { displayName: displayNameByWallet.get(r.walletAddress)! }
        : {}),
    }));

    _topContributorsCache.set(drepId, { fetchedAt: now, contributors });
    if (_topContributorsCache.size > RAIL_CACHE_MAX_ENTRIES) {
      const oldest = _topContributorsCache.keys().next().value;
      if (oldest !== undefined) _topContributorsCache.delete(oldest);
    }
    return ok({ items: contributors.slice(0, limit) });
  } catch (err) {
    console.error('clubhouse/topContributors handler error:', err);
    return internalError('Failed to load top contributors');
  }
};
