/**
 * GET /clubhouse/{drepId}/rail/top-contributors?limit=5
 *
 * Right-rail card data: top N wallets ranked by clubhouse
 * participation. See `_rail.ts` for the cache contract, the
 * scoring formula, and the "why count, not stake-weighted today"
 * judgment-call rationale.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { batchGetItems, tableNames } from '../../lib/dynamodb';
import type { UserItem } from '../../lib/types';
import {
  fetchClubhousePosts,
  parseRailLimit,
  rankTopContributors,
  RAIL_CACHE_MAX_ENTRIES,
  RAIL_CACHE_TTL_MS,
  MAX_RAIL_LIMIT,
  type TopContributorEntry,
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
    const ranked = rankTopContributors(posts, { limit: MAX_RAIL_LIMIT });

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
