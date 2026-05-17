/**
 * GET /dreps/{drepId} — single DRep detail.
 *
 * Reads the cached directory row from DynamoDB, then enriches it on-
 * demand with two Koios calls:
 *   - `drep_voters` for recent-vote history (last 10 actions)
 *   - `drep_delegators` for the live delegator count
 *
 * Both enrichments are best-effort: if Koios is unreachable we still
 * return the cached row, just without `recentVotes` / `delegatorCountLive`.
 *
 * In-Lambda cache: a tiny module-scope LRU keeps the on-demand fields
 * for 5 min. Cold-start traffic still pays the Koios round-trip; warm
 * traffic on hot DReps gets the cached value. This is intentional —
 * we don't want every page load on a popular DRep to hit Koios.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getItem, tableNames } from '../../lib/dynamodb';
import type {
  DRepDirectoryItem,
  DRepDetail,
  DRepRecentVote,
} from '../../lib/types';
import { fetchDRepVotes, fetchDRepDelegatorCount } from '../../lib/koios';
import { ok, badRequest, notFound, internalError } from '../_response';

/** 5 minutes — long enough to dedupe a refresh storm on a popular DRep
 *  but short enough that delegations show up in near real-time. */
const ENRICHMENT_CACHE_TTL_MS = 5 * 60 * 1000;

/** Per-DRep on-demand cache contents.
 *
 *  `delegatorCountLive` is the resolved count; `delegatorCountTruncated`
 *  flags when Koios was paginated past `DREP_DELEGATORS_MAX_PAGES`
 *  (5000 rows today). The UI renders truncated counts as "{count}+".
 *  See `lib/koios.ts:fetchDRepDelegatorCount` for the pagination
 *  contract. */
interface EnrichmentCacheEntry {
  fetchedAt: number;
  recentVotes?: DRepRecentVote[];
  delegatorCountLive?: number;
  delegatorCountTruncated?: boolean;
}

const enrichmentCache = new Map<string, EnrichmentCacheEntry>();

/** Full-response cache, keyed by drepId. CloudFront caches this for 30s
 *  on the edge; the Lambda cache backstops misses with a 5-minute TTL so
 *  popular DReps don't pay the DynamoDB getItem + Koios round-trip on every
 *  cold edge. The enrichment cache above is reused on a Lambda hit, but
 *  this one short-circuits the entire handler body.
 *
 *  We cache the assembled `DRepDetail` rather than the raw row so the
 *  shape (including `recentVotes` / `delegatorCountLive`) is already
 *  composed when we serve. */
interface DetailCacheEntry {
  detail: DRepDetail;
  expiresAt: number;
}
const _detailCache = new Map<string, DetailCacheEntry>();
const DETAIL_CACHE_TTL_MS = 5 * 60 * 1000;
const DETAIL_CACHE_MAX_ENTRIES = 200;

/** Convert Koios's verbatim `vote` string + Unix-seconds block_time into
 *  the public `DRepRecentVote` shape. We don't normalize the vote casing
 *  — callers may want to render "Yes" vs "yes" verbatim depending on
 *  context. The frontend lowercases for the pill class. */
function mapRecentVote(raw: {
  proposal_tx_hash: string;
  proposal_index: number;
  proposal_type: string;
  vote: string;
  block_time: number;
}): DRepRecentVote {
  return {
    proposalTxHash: raw.proposal_tx_hash,
    proposalIndex: raw.proposal_index,
    proposalType: raw.proposal_type,
    vote: raw.vote,
    votedAt: new Date(raw.block_time * 1000).toISOString(),
  };
}

async function fetchEnrichment(drepId: string): Promise<EnrichmentCacheEntry> {
  const now = Date.now();
  const cached = enrichmentCache.get(drepId);
  if (cached && now - cached.fetchedAt < ENRICHMENT_CACHE_TTL_MS) {
    return cached;
  }
  // Run both calls in parallel — they don't depend on each other and
  // each individually has a hard 8s/page timeout. The delegator count
  // can paginate up to 5 pages (5000 rows) but each page is one round-
  // trip; combined 99th-percentile wall-clock here is ~3s on a warm
  // Koios and ~12s on a popular DRep with > 1000 delegators.
  const [votesRaw, delegatorCount] = await Promise.all([
    fetchDRepVotes(drepId),
    fetchDRepDelegatorCount(drepId),
  ]);
  const entry: EnrichmentCacheEntry = { fetchedAt: now };
  if (votesRaw) {
    // Newest-first by block_time. Koios's PostgREST default already
    // orders by primary key (proposal_tx_hash), not time, so we sort
    // explicitly to be safe. Truncate to 10 to keep the response small.
    entry.recentVotes = votesRaw
      .slice()
      .sort((a, b) => b.block_time - a.block_time)
      .slice(0, 10)
      .map(mapRecentVote);
  }
  if (delegatorCount) {
    entry.delegatorCountLive = delegatorCount.count;
    if (delegatorCount.truncated) {
      entry.delegatorCountTruncated = true;
    }
  }
  enrichmentCache.set(drepId, entry);
  // Bound the cache — Lambdas are reused but not unbounded. 200 entries
  // covers any reasonable hot-set; older entries get evicted.
  if (enrichmentCache.size > 200) {
    const oldestKey = enrichmentCache.keys().next().value;
    if (oldestKey !== undefined) enrichmentCache.delete(oldestKey);
  }
  return entry;
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  // Same Cache-Control on every code path so CloudFront edge can re-cache.
  const cacheHeaders = { 'Cache-Control': 'public, max-age=30, s-maxage=30' };

  try {
    const drepIdRaw = event.pathParameters?.['drepId'];
    if (!drepIdRaw) {
      return badRequest('drepId path parameter is required');
    }
    const drepId = decodeURIComponent(drepIdRaw);

    // Module-level full-response cache. 5min TTL — this is intentionally
    // longer than the CloudFront edge TTL (30s). The edge handles the bulk
    // of fan-out; the Lambda cache is purely defense for cold-edge bursts.
    const now = Date.now();
    const cachedDetail = _detailCache.get(drepId);
    if (cachedDetail && cachedDetail.expiresAt > now) {
      return ok(cachedDetail.detail, cacheHeaders);
    }

    const cached = await getItem<DRepDirectoryItem>(tableNames.drepDirectory, {
      drepId,
      SK: 'PROFILE',
    });
    if (!cached) {
      return notFound('DRep');
    }

    // On-demand enrichment. Failures land as undefined fields — the
    // detail page renders gracefully without recent votes or live
    // delegator counts.
    let enrichment: EnrichmentCacheEntry;
    try {
      enrichment = await fetchEnrichment(drepId);
    } catch (err) {
      console.warn(`directory/get: enrichment failed for ${drepId}:`, err);
      enrichment = { fetchedAt: Date.now() };
    }

    const detail: DRepDetail = {
      drepId: cached.drepId,
      hex: cached.hex,
      isActive: cached.isActive,
      // Backwards compat — pre-v3 rows didn't store this field. Treat
      // absence as `false` (the v2 sync filtered out non-registered).
      isRetired: cached.isRetired ?? false,
      status: cached.status,
      deposit: cached.deposit,
      hasScript: cached.hasScript,
      votingPower: cached.votingPower,
      expiresEpoch: cached.expiresEpoch,
      anchorUrl: cached.anchorUrl,
      anchorHash: cached.anchorHash,
      anchorVerified: cached.anchorVerified,
      lastSyncedAt: cached.lastSyncedAt,
      enrichmentVersion: cached.enrichmentVersion,
      ...(cached.delegatorCount !== undefined ? { delegatorCount: cached.delegatorCount } : {}),
      ...(cached.givenName !== undefined ? { givenName: cached.givenName } : {}),
      ...(cached.image !== undefined ? { image: cached.image } : {}),
      ...(cached.objectives !== undefined ? { objectives: cached.objectives } : {}),
      ...(cached.motivations !== undefined ? { motivations: cached.motivations } : {}),
      ...(cached.qualifications !== undefined ? { qualifications: cached.qualifications } : {}),
      ...(cached.paymentAddress !== undefined ? { paymentAddress: cached.paymentAddress } : {}),
      ...(cached.references !== undefined ? { references: cached.references } : {}),
      ...(enrichment.recentVotes !== undefined
        ? { recentVotes: enrichment.recentVotes }
        : {}),
      ...(enrichment.delegatorCountLive !== undefined
        ? { delegatorCountLive: enrichment.delegatorCountLive }
        : {}),
      // Truncation flag is only emitted when the underlying Koios walk
      // hit the page cap; absence means the count is complete. The
      // frontend reads this to render "{n}+" instead of "{n}".
      ...(enrichment.delegatorCountTruncated
        ? { delegatorCountTruncated: true }
        : {}),
    };

    // Insert into the module-level cache. Eviction = drop the oldest key
    // (Map iteration order is insertion order).
    _detailCache.set(drepId, { detail, expiresAt: now + DETAIL_CACHE_TTL_MS });
    if (_detailCache.size > DETAIL_CACHE_MAX_ENTRIES) {
      const oldestKey = _detailCache.keys().next().value;
      if (oldestKey !== undefined) _detailCache.delete(oldestKey);
    }

    return ok(detail, cacheHeaders);
  } catch (err) {
    console.error('directory/get handler error:', err);
    return internalError('Failed to fetch DRep');
  }
};
