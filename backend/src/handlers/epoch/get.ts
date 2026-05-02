import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getLatestEpoch } from '../../lib/blockfrost';
import { ok, internalError } from '../_response';

interface EpochResponse {
  epoch: number;
  startTime: string;
  endTime: string;
  /** Seconds until this epoch ends — the SPA renders this as a countdown. */
  endsInSeconds: number;
}

/**
 * Module-level cache so a warm Lambda instance can serve hundreds of
 * /epoch calls per Blockfrost hit. The Cardano epoch only changes every
 * ~5 days, so a 60s window is conservative; we also keep a "last good"
 * fallback so transient Blockfrost errors (rate-limit 402, transient 5xx)
 * don't black-hole the sidebar — we serve the previous response if it's
 * less than 30 minutes old.
 *
 * NOTE: this is per-Lambda-instance — concurrent containers each warm
 * their own cache, so worst-case fan-out is `containers × (1 / TTL)` not
 * a single shared write. Acceptable; the route is cheap.
 */
interface CachedEpoch {
  body: EpochResponse;
  /** epoch ms. The cache is "fresh" until cachedAt + FRESH_TTL_MS, and
   *  "usable as fallback" until cachedAt + STALE_FALLBACK_TTL_MS. */
  cachedAt: number;
}
let _cache: CachedEpoch | null = null;
const FRESH_TTL_MS = 60_000; // 60s — refresh-from-source cadence
const STALE_FALLBACK_TTL_MS = 30 * 60_000; // 30 min — serve-stale on Blockfrost errors

function buildResponse(epoch: Awaited<ReturnType<typeof getLatestEpoch>>): EpochResponse {
  const endsInSeconds = Math.max(0, epoch.end_time - Math.floor(Date.now() / 1000));
  return {
    epoch: epoch.epoch,
    startTime: new Date(epoch.start_time * 1000).toISOString(),
    endTime: new Date(epoch.end_time * 1000).toISOString(),
    endsInSeconds,
  };
}

function refreshEndsInSeconds(body: EpochResponse): EpochResponse {
  // The endTime ISO string is fixed per epoch; only the countdown drifts.
  // Recompute on every served response so cached payloads still feel live.
  const endTimeMs = Date.parse(body.endTime);
  const endsInSeconds = Number.isFinite(endTimeMs)
    ? Math.max(0, Math.floor((endTimeMs - Date.now()) / 1000))
    : body.endsInSeconds;
  return { ...body, endsInSeconds };
}

/**
 * GET /epoch
 *
 * Public — no auth required. Wraps Blockfrost `epochsLatest` and returns the
 * shape the SPA needs for the epoch sidebar card and dashboard tile.
 *
 * Cached at the Lambda layer (60s TTL) and at the HTTP layer
 * (Cache-Control: public, max-age=30, s-maxage=60). When Blockfrost rate-
 * limits us (402 Project Over Limit) we serve the most recent good payload
 * instead of bubbling 500s into the sidebar.
 */
export const handler = async (
  _event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const cacheHeaders = {
    'Cache-Control': 'public, max-age=30, s-maxage=60',
  };

  // Fast path: cache is fresh.
  if (_cache && Date.now() - _cache.cachedAt < FRESH_TTL_MS) {
    return ok(refreshEndsInSeconds(_cache.body), cacheHeaders);
  }

  try {
    const epoch = await getLatestEpoch();
    const body = buildResponse(epoch);
    _cache = { body, cachedAt: Date.now() };
    return ok(body, cacheHeaders);
  } catch (err) {
    // Stale-while-error: rather than 500 on a Blockfrost rate-limit hiccup,
    // serve the most recent good response if it's not too old. The sidebar
    // is a soft surface — a 30-minute-old epoch number is still useful.
    if (_cache && Date.now() - _cache.cachedAt < STALE_FALLBACK_TTL_MS) {
      console.warn('epoch/get serving stale cache after upstream failure:', err);
      return ok(refreshEndsInSeconds(_cache.body), {
        ...cacheHeaders,
        'X-Cache-Source': 'stale-while-error',
      });
    }
    console.error('epoch/get handler error:', err);
    return internalError('Failed to fetch latest epoch');
  }
};
