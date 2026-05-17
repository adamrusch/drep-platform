import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getItem, tableNames } from '../../lib/dynamodb';
import type { UserItem } from '../../lib/types';
import { getAccountInfo } from '../../lib/blockfrost';
import { fetchAccountInfo, KoiosError } from '../../lib/koios';
import { ok, badRequest, notFound, internalError } from '../_response';

/**
 * Per-stake-address current-DRep cache. Cuts Class C -> Class B by
 * avoiding a Koios round-trip on every page load. 60s is the sweet spot:
 *   - Long enough that bursting reloads of the same profile (or
 *     concurrent edge misses) share one Koios call.
 *   - Short enough that a new delegation lands in the UI within ~1 min
 *     — the user's mental model is "this is near-real-time".
 *
 * The cache is per-Lambda-container, so cold containers always hit
 * upstream first. That's the right trade — we accept one upstream hit
 * per cold container start, in exchange for never blocking a page load
 * on Koios when the container is warm.
 *
 * Eviction: LRU-ish via insertion-order Map; bounded at 200 entries
 * (one entry per active profile being viewed; 200 is generous).
 */
interface DrepCacheEntry {
  /** ISO timestamp the answer was retrieved. */
  fetchedAt: number;
  /** The current `delegated_drep` for this stake address. `null` when the
   *  upstream answered "unregistered or undelegated". */
  drepId: string | null;
  /** Which provider served the answer. Surfaced in the log so the next
   *  audit can confirm Koios is doing the work. */
  source: 'koios' | 'blockfrost-fallback';
}
const _drepCache = new Map<string, DrepCacheEntry>();
const DREP_CACHE_TTL_MS = 60_000;
const DREP_CACHE_MAX_ENTRIES = 200;

/**
 * Resolve the current DRep for a stake address. Tries Koios first; falls
 * back to Blockfrost. Returns null when both fail (the handler still
 * serves the DynamoDB-stored history; only the `currentDrepId` field
 * goes empty).
 */
async function resolveCurrentDrep(
  stakeAddress: string,
): Promise<{ drepId: string | null; source: DrepCacheEntry['source'] } | null> {
  const now = Date.now();
  const cached = _drepCache.get(stakeAddress);
  if (cached && now - cached.fetchedAt < DREP_CACHE_TTL_MS) {
    return { drepId: cached.drepId, source: cached.source };
  }
  // ---- Koios primary (Phase C) ----
  try {
    const account = await fetchAccountInfo(stakeAddress);
    const drepId = account?.delegated_drep ?? null;
    const entry: DrepCacheEntry = { fetchedAt: now, drepId, source: 'koios' };
    _drepCache.set(stakeAddress, entry);
    if (_drepCache.size > DREP_CACHE_MAX_ENTRIES) {
      const oldest = _drepCache.keys().next().value;
      if (oldest !== undefined) _drepCache.delete(oldest);
    }
    return { drepId, source: 'koios' };
  } catch (koiosErr) {
    if (koiosErr instanceof KoiosError) {
      console.warn(
        `delegationHistory: Koios unavailable (${koiosErr.message}); falling back to Blockfrost`,
      );
    } else {
      console.warn(
        'delegationHistory: unexpected Koios error; falling back to Blockfrost:',
        koiosErr,
      );
    }
  }
  // ---- Blockfrost fallback ----
  try {
    const accountInfo = await getAccountInfo(stakeAddress);
    const drepId = accountInfo.drep_id ?? null;
    const entry: DrepCacheEntry = { fetchedAt: now, drepId, source: 'blockfrost-fallback' };
    _drepCache.set(stakeAddress, entry);
    if (_drepCache.size > DREP_CACHE_MAX_ENTRIES) {
      const oldest = _drepCache.keys().next().value;
      if (oldest !== undefined) _drepCache.delete(oldest);
    }
    return { drepId, source: 'blockfrost-fallback' };
  } catch (blockfrostErr) {
    console.warn(
      'delegationHistory: both providers failed; serving stored history only:',
      blockfrostErr,
    );
    return null;
  }
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  try {
    const walletAddress = event.pathParameters?.['walletAddress'];
    if (!walletAddress) {
      return badRequest('walletAddress path parameter is required');
    }

    const decoded = decodeURIComponent(walletAddress);

    const user = await getItem<UserItem>(tableNames.users, {
      walletAddress: decoded,
      SK: 'PROFILE',
    });

    if (!user) {
      return notFound('User profile');
    }

    // Enrich with live on-chain data if it's a stake address. After Phase C
    // this is Koios primary; Blockfrost fallback. The 60s module-level
    // cache absorbs reload-bursts so the handler is effectively Class B
    // (cached-with-freshness) rather than Class C (live every request).
    let onChainDrepId: string | undefined;
    if (decoded.startsWith('stake')) {
      const resolved = await resolveCurrentDrep(decoded);
      if (resolved !== null) {
        onChainDrepId = resolved.drepId ?? undefined;
        console.log(
          `delegationHistory served drepId=${onChainDrepId ?? 'null'} source=${resolved.source}`,
        );
      }
    }

    return ok({
      walletAddress: decoded,
      delegationHistory: user.delegationHistory ?? [],
      currentDrepId: onChainDrepId,
    });
  } catch (err) {
    console.error('profile/delegationHistory handler error:', err);
    return internalError('Failed to fetch delegation history');
  }
};
