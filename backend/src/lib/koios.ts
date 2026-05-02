/**
 * Koios API client (read-only, anonymous tier).
 *
 * Phase A of the metadata-source migration: Koios's `/proposal_list` returns
 * EVERY governance action with the on-chain anchor body already fetched and
 * parsed (`meta_json`), the on-chain `governance_description` (`proposal_description`),
 * and the lifecycle epoch fields — all in a single ~5MB response. That replaces
 * 4 Blockfrost calls per action (listing + detail + tx block_time + anchor
 * metadata) with one bulk call, cutting Blockfrost volume by an order of
 * magnitude and surfacing CIP-108 bodies for many actions where Blockfrost's
 * `/governance/proposals/{tx}/{idx}/metadata` endpoint returns 404.
 *
 * Vote tallies still come from Blockfrost — Koios's vote endpoints are paid
 * tier and we're explicitly leaving votes on the existing path for Phase A.
 *
 * This client throws a typed `KoiosError` on any 4xx/5xx/429/timeout/oversize
 * condition so the sync can fall back to the legacy Blockfrost-driven path
 * without losing a cycle.
 */

// ---- Constants ----

const KOIOS_BASE = process.env['KOIOS_BASE_URL'] ?? 'https://api.koios.rest/api/v1';
const REQUEST_TIMEOUT_MS = 10_000;
/** 10MB cap. The mainnet `/proposal_list` is ~5MB at 109 entries today; cap
 *  doubles that to absorb growth without enabling pathological responses. */
const RESPONSE_MAX_BYTES = 10 * 1024 * 1024;
/** 60 seconds is plenty — the sync calls `listProposals` exactly once per
 *  cycle, so this only de-dupes within a single Lambda invocation today. */
const CACHE_TTL_MS = 60_000;
/** Page size for paginated reads (Range: 0-{N-1}). 1000 fits the full
 *  mainnet list with headroom. */
const PAGE_SIZE = 1000;
/** Hard cap on pages we fetch — defensive against runaway pagination. */
const MAX_PAGES = 10;

// ---- Public types ----

/**
 * One row of the Koios `proposal_list` response. Field names mirror the
 * upstream payload exactly; we DO NOT camelCase them on read because we
 * want to keep the source-of-truth shape recognizable in logs and crashes.
 *
 * Most fields are nullable per the spec — only the identity fields
 * (`proposal_tx_hash`, `proposal_index`, `proposal_type`) are guaranteed.
 */
export interface KoiosProposal {
  proposal_tx_hash: string;
  proposal_index: number;
  proposal_id: string | null;
  proposal_type: string;
  /** Tagged-union form of the on-chain governance description; same shape
   *  as Blockfrost's `governance_description` field. */
  proposal_description: Record<string, unknown> | null;
  meta_url: string | null;
  meta_hash: string | null;
  /** CIP-108 anchor body, parsed and validated by the indexer. May be null
   *  when the anchor is unreachable or fails validation. The user-readable
   *  fields live under `meta_json.body` (title/abstract/motivation/...). */
  meta_json: Record<string, unknown> | null;
  /** Indexer's verdict on whether the anchor is well-formed and matches
   *  its declared hash. Tri-state: true / false / null (not yet checked). */
  meta_is_valid: boolean | null;
  meta_comment: string | null;
  meta_language: string | null;
  /** Block time of the submission tx, in Unix seconds. Used as `submittedAt`. */
  block_time: number;
  proposed_epoch: number | null;
  ratified_epoch: number | null;
  enacted_epoch: number | null;
  dropped_epoch: number | null;
  expired_epoch: number | null;
  /** Epoch at which this proposal expires if not ratified. */
  expiration: number | null;
  return_address: string | null;
  deposit: string | null;
  withdrawal: unknown | null;
  param_proposal: unknown | null;
}

/**
 * Thrown for any condition where the caller should fall back to a different
 * data source. Includes the upstream HTTP status (when applicable) so the
 * caller can distinguish rate-limit (429) from outage (5xx) from transport
 * issues (status undefined).
 */
export class KoiosError extends Error {
  public readonly status: number | undefined;
  public readonly endpoint: string;

  constructor(endpoint: string, message: string, status?: number) {
    super(`[Koios ${endpoint}] ${message}`);
    this.name = 'KoiosError';
    this.endpoint = endpoint;
    this.status = status;
  }
}

// ---- Module-level cache ----

interface CacheEntry<T> {
  fetchedAt: number;
  value: T;
}

let _proposalCache: CacheEntry<KoiosProposal[]> | null = null;

/** Reset cache (test-only escape hatch). Not exported in the public API
 *  surface but available via the module record if a future test needs it. */
export function _resetCache(): void {
  _proposalCache = null;
}

// ---- Internal helpers ----

/**
 * Issue a single Koios request with a hard timeout, status-code check, and
 * response-size cap. Reads the body as a single stream so we can bail
 * before allocating gigabytes if upstream returns an unexpectedly huge body.
 */
async function koiosFetch(
  endpoint: string,
  init: RequestInit & { rangeFrom?: number; rangeTo?: number },
): Promise<Response> {
  const url = `${KOIOS_BASE}${endpoint}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  const headers = new Headers(init.headers);
  // Koios uses `Range: <from>-<to>` (inclusive, 0-indexed) for pagination.
  if (init.rangeFrom != null && init.rangeTo != null) {
    headers.set('Range', `${init.rangeFrom}-${init.rangeTo}`);
  }
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  if (!headers.has('Content-Type') && init.body != null) {
    headers.set('Content-Type', 'application/json');
  }
  try {
    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers,
      body: init.body,
      signal: ac.signal,
    });
    return res;
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      throw new KoiosError(endpoint, `request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw new KoiosError(endpoint, `network error: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a Response body as JSON, capped at `RESPONSE_MAX_BYTES`. Streaming
 * read avoids buffering oversized payloads in memory before the size check.
 */
async function readJsonCapped(res: Response, endpoint: string): Promise<unknown> {
  const reader = res.body?.getReader();
  if (!reader) {
    // No streaming reader available; fall back to text() but enforce the cap
    // afterwards. (`fetch` in Node 20 always provides a reader, so this is
    // only a defensive branch for unusual runtimes.)
    const text = await res.text();
    if (text.length > RESPONSE_MAX_BYTES) {
      throw new KoiosError(endpoint, `response exceeded ${RESPONSE_MAX_BYTES} bytes (no-reader path)`);
    }
    return parseJsonStrict(text, endpoint);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > RESPONSE_MAX_BYTES) {
        await reader.cancel();
        throw new KoiosError(endpoint, `response exceeded ${RESPONSE_MAX_BYTES} bytes`);
      }
      chunks.push(value);
    }
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return parseJsonStrict(buf.toString('utf-8'), endpoint);
}

function parseJsonStrict(text: string, endpoint: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new KoiosError(endpoint, `invalid JSON: ${(err as Error).message}`);
  }
}

// ---- Public API ----

/**
 * Fetch the full mainnet governance proposal list. Cached at module scope
 * for `CACHE_TTL_MS`; the sync only calls this once per cycle so the cache
 * mainly de-dupes within a single warm Lambda invocation.
 *
 * Pagination via `Range` header. We loop until a short page comes back or
 * we hit `MAX_PAGES` (defensive cap). At ~109 entries on mainnet today the
 * full list fits in one page, but this code is ready for growth.
 *
 * Throws `KoiosError` on any failure path so the caller can fall back to
 * the existing Blockfrost-driven enrichment.
 */
export async function listProposals(): Promise<KoiosProposal[]> {
  const now = Date.now();
  if (_proposalCache && now - _proposalCache.fetchedAt < CACHE_TTL_MS) {
    return _proposalCache.value;
  }

  const all: KoiosProposal[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const res = await koiosFetch('/proposal_list', {
      method: 'POST',
      // POST body is `{}` — Koios's RPC convention is "POST with optional
      // filter object even for read-only listings."
      body: '{}',
      rangeFrom: from,
      rangeTo: to,
    });
    if (!res.ok) {
      // Burn the cache on any error so the next call retries fresh rather
      // than returning a half-built list.
      _proposalCache = null;
      throw new KoiosError(
        '/proposal_list',
        `HTTP ${res.status} ${res.statusText}`,
        res.status,
      );
    }
    const body = (await readJsonCapped(res, '/proposal_list')) as unknown;
    if (!Array.isArray(body)) {
      _proposalCache = null;
      throw new KoiosError('/proposal_list', 'expected JSON array');
    }
    // Trust the upstream shape; cast at the boundary. Per-field nullability
    // is enforced by `KoiosProposal`'s nullable types — consumers handle nulls.
    const rows = body as KoiosProposal[];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  _proposalCache = { fetchedAt: now, value: all };
  return all;
}
