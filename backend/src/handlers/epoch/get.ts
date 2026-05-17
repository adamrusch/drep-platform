import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getLatestEpoch } from '../../lib/blockfrost';
import { getCurrentEpochInfo, KoiosError } from '../../lib/koios';
import { ok, internalError } from '../_response';

interface EpochResponse {
  epoch: number;
  startTime: string;
  endTime: string;
  /** Seconds until this epoch ends — the SPA renders this as a countdown. */
  endsInSeconds: number;
}

/**
 * Phase C: source-tracking for the operator-visible "where did this epoch
 * come from" signal. Logged on every miss / fallback so the next audit can
 * see at a glance how often Blockfrost was reached. Not surfaced in the
 * response body — purely a CloudWatch breadcrumb.
 */
type EpochSource = 'koios' | 'blockfrost-fallback' | 'stale-cache' | 'deterministic-fallback';

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

/**
 * Phase C: build the response from a Koios `/epoch_info` row. The field
 * names differ from Blockfrost — `epoch_no` vs `epoch`, but `start_time`
 * / `end_time` are identical (Unix seconds). When Koios returns null for
 * either time field (rare; happens on epochs that haven't fully indexed)
 * we fall back to the deterministic Shelley math — same approach the
 * deterministic-fallback branch uses, but inline so we don't fall through
 * an additional layer.
 */
function buildResponseFromKoios(
  info: Awaited<ReturnType<typeof getCurrentEpochInfo>>,
): EpochResponse {
  // Defensive: if start_time / end_time are null on the upstream row,
  // recompute deterministically from epoch_no. Shelley genesis: epoch 208
  // began at 2020-07-29 21:44:51 UTC; each epoch is 432000s (5 days).
  const SHELLEY_EPOCH_208_START = 1596059091;
  const EPOCH_LENGTH_SECONDS = 432_000;
  const startTimeSec =
    typeof info.start_time === 'number' && info.start_time > 0
      ? info.start_time
      : SHELLEY_EPOCH_208_START + (info.epoch_no - 208) * EPOCH_LENGTH_SECONDS;
  const endTimeSec =
    typeof info.end_time === 'number' && info.end_time > 0
      ? info.end_time
      : startTimeSec + EPOCH_LENGTH_SECONDS;
  const endsInSeconds = Math.max(0, endTimeSec - Math.floor(Date.now() / 1000));
  return {
    epoch: info.epoch_no,
    startTime: new Date(startTimeSec * 1000).toISOString(),
    endTime: new Date(endTimeSec * 1000).toISOString(),
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
 * Public — no auth required. Returns the shape the SPA needs for the epoch
 * sidebar card and dashboard tile.
 *
 * Data sources (Phase C):
 *   1. Koios `/tip` + `/epoch_info` (primary)
 *   2. Blockfrost `epochsLatest` (fallback)
 *   3. Stale-cache window (30 min) for transient outages on both providers
 *   4. Deterministic Shelley math (last resort, mainnet only)
 *
 * Cached at the Lambda layer (60s TTL) and at the HTTP layer
 * (Cache-Control: public, max-age=30, s-maxage=60). When BOTH upstreams are
 * unavailable we serve stale or deterministically-computed data instead of
 * bubbling 500s into the sidebar.
 *
 * Source-tagging: every served response logs `source=koios |
 * blockfrost-fallback | stale-cache | deterministic-fallback` so the
 * operator can measure Blockfrost call volume in steady state.
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

  // ---- Koios primary (Phase C) ----
  // Koios `/epoch_info` returns the same shape as Blockfrost's
  // `epochsLatest`. We try Koios first; on KoiosError we fall through to
  // the existing Blockfrost path. Falling through preserves the
  // stale-cache + deterministic-fallback safety net that's already in
  // place for Blockfrost outages — Phase C doesn't add new failure modes.
  try {
    const info = await getCurrentEpochInfo();
    const body = buildResponseFromKoios(info);
    _cache = { body, cachedAt: Date.now() };
    const source: EpochSource = 'koios';
    console.log(`epoch/get served from source=${source} epoch=${body.epoch}`);
    return ok(body, cacheHeaders);
  } catch (koiosErr) {
    // Koios is down or slow. Log and fall through to Blockfrost.
    if (koiosErr instanceof KoiosError) {
      console.warn(`epoch/get: Koios unavailable (${koiosErr.message}); trying Blockfrost`);
    } else {
      console.warn('epoch/get: unexpected Koios error; trying Blockfrost:', koiosErr);
    }
  }

  try {
    const epoch = await getLatestEpoch();
    const body = buildResponse(epoch);
    _cache = { body, cachedAt: Date.now() };
    const source: EpochSource = 'blockfrost-fallback';
    console.log(`epoch/get served from source=${source} epoch=${body.epoch}`);
    return ok(body, cacheHeaders);
  } catch (err) {
    // Stale-while-error: rather than 500 on a rate-limit hiccup, serve
    // the most recent good response if it's not too old. The sidebar is
    // a soft surface — a 30-minute-old epoch number is still useful.
    if (_cache && Date.now() - _cache.cachedAt < STALE_FALLBACK_TTL_MS) {
      const source: EpochSource = 'stale-cache';
      console.warn(`epoch/get served from source=${source} after upstream failure:`, err);
      return ok(refreshEndsInSeconds(_cache.body), {
        ...cacheHeaders,
        'X-Cache-Source': 'stale-while-error',
      });
    }
    // Last-resort fallback: deterministic chain math.
    // Cardano epochs are fully deterministic on the time axis after Shelley.
    // Mainnet Shelley genesis: epoch 208 began at 2020-07-29 21:44:51 UTC.
    // Each epoch is exactly 432000 seconds (5 days).
    // This matches Blockfrost's `epochsLatest` output bit-for-bit and lets
    // the UI keep working when both the in-memory cache and Blockfrost are
    // unavailable (e.g. cold-start during a rolling-window quota outage).
    const network = process.env['CARDANO_NETWORK'] ?? 'mainnet';
    if (network === 'mainnet') {
      const source: EpochSource = 'deterministic-fallback';
      console.warn(`epoch/get served from source=${source} after upstream failure:`, err);
      const SHELLEY_EPOCH_208_START = 1596059091; // 2020-07-29 21:44:51 UTC
      const EPOCH_LENGTH_SECONDS = 432_000; // 5 days
      const nowSec = Math.floor(Date.now() / 1000);
      const epochsSinceShelley = Math.floor((nowSec - SHELLEY_EPOCH_208_START) / EPOCH_LENGTH_SECONDS);
      const currentEpoch = 208 + epochsSinceShelley;
      const startTimeSec = SHELLEY_EPOCH_208_START + epochsSinceShelley * EPOCH_LENGTH_SECONDS;
      const endTimeSec = startTimeSec + EPOCH_LENGTH_SECONDS;
      const fallback: EpochResponse = {
        epoch: currentEpoch,
        startTime: new Date(startTimeSec * 1000).toISOString(),
        endTime: new Date(endTimeSec * 1000).toISOString(),
        endsInSeconds: Math.max(0, endTimeSec - nowSec),
      };
      // Don't cache the fallback as if it were a real Blockfrost response —
      // we want the next request to retry Blockfrost, not pin to fallback.
      return ok(fallback, {
        ...cacheHeaders,
        'X-Cache-Source': 'deterministic-fallback',
      });
    }
    console.error('epoch/get handler error:', err);
    return internalError('Failed to fetch latest epoch');
  }
};
