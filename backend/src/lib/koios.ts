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
/** DRep registrations change slowly (per-epoch at most). 10 minutes of
 *  staleness has no impact on `notVoted` accuracy at sub-percent scale. */
const DREP_CACHE_TTL_MS = 10 * 60 * 1000;
/** Pool registrations change very slowly. 30 minutes is comfortable; the
 *  active stake column is what we actually consume and that lags by epoch
 *  anyway. */
const POOL_CACHE_TTL_MS = 30 * 60 * 1000;
/** Constitutional Committee membership changes at most once per epoch and
 *  usually rarely. 1 hour cache is safe. */
const COMMITTEE_CACHE_TTL_MS = 60 * 60 * 1000;
/** Page size for paginated reads (Range: 0-{N-1}). 1000 fits the full
 *  mainnet list with headroom. */
const PAGE_SIZE = 1000;
/** Hard cap on pages we fetch — defensive against runaway pagination. */
const MAX_PAGES = 10;
/** `pool_list` returns ~6000+ rows on mainnet today — 12 pages × 1000.
 *  Cap doubles current size for headroom without going unbounded. */
const POOL_MAX_PAGES = 25;
/** Koios `drep_info` accepts a list of `_drep_ids`; the request body is
 *  capped on the upstream side. 50 IDs/request keeps us well under the cap
 *  and limits per-request payload size. */
const DREP_INFO_BATCH_SIZE = 50;

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
 * One row of `drep_list`. Note `amount` (voting power) is NOT in this
 * response — it has to come from `drep_info`. We carry the registration /
 * script flags so the caller can filter to active registered DReps before
 * the (more expensive) batched `drep_info` calls.
 */
export interface KoiosDRepListEntry {
  drep_id: string;
  hex: string;
  has_script: boolean;
  registered: boolean;
}

/**
 * One row of `drep_info`. `amount` is the voting power (delegated stake +
 * own stake) in lovelace, as a stringified integer to preserve full
 * precision past 2^53. `active` distinguishes still-active DReps from
 * registered-but-expired/retired DReps; only `active === true` carries
 * actual voting weight.
 */
export interface KoiosDRepInfo {
  drep_id: string;
  hex: string | null;
  has_script: boolean;
  drep_status: 'registered' | 'retired' | string;
  deposit: string | null;
  active: boolean;
  expires_epoch_no: number | null;
  /** Voting power in lovelace, stringified. */
  amount: string;
  meta_url: string | null;
  meta_hash: string | null;
}

/**
 * Synthesized "active DRep" row — what the caller actually wants. Combines
 * the listing's identity fields with the info endpoint's voting power,
 * filtered to entries that currently carry voting weight.
 */
export interface KoiosActiveDRep {
  drep_id: string;
  hex: string | null;
  has_script: boolean;
  /** Voting power in lovelace as stringified BigInt. */
  amount: string;
}

/**
 * One row of `drep_metadata`. Contains the parsed CIP-119 anchor body
 * (`meta_json`) when the indexer has fetched and validated it, plus the
 * raw bytes/hash and a tri-state `is_valid` (true / false / null).
 *
 * The `meta_json` field is a free-form record because CIP-119 bodies in
 * the wild are not strictly conformant — the schema mandates `body` with
 * `givenName`, but real submissions sometimes nest fields differently or
 * omit them. The directory-builder is responsible for extracting fields
 * defensively.
 */
export interface KoiosDRepMetadata {
  drep_id: string;
  hex: string | null;
  has_script: boolean;
  meta_url: string | null;
  meta_hash: string | null;
  /** Parsed CIP-119 body. May be null when the anchor is unreachable
   *  or fails to parse. */
  meta_json: Record<string, unknown> | null;
  bytes: string | null;
  warning: string | null;
  language: string | null;
  comment: string | null;
  /** Indexer's verdict on whether the body matches its declared hash.
   *  Tri-state: true / false / null (not yet checked). */
  is_valid: boolean | null;
}

/**
 * One row of `drep_voters` — every governance action this DRep has voted
 * on, with their vote and the block context. Sorted newest-first by the
 * upstream PostgREST default; we don't reorder.
 */
export interface KoiosDRepVote {
  proposal_tx_hash: string;
  proposal_index: number;
  proposal_type: string;
  /** "Yes" | "No" | "Abstain" — verbatim from the upstream. */
  vote: string;
  block_time: number;
  meta_url: string | null;
  meta_hash: string | null;
}

/**
 * One row of the global `vote_list` endpoint. Carries every governance
 * vote ever cast (DRep, SPO, CC), with voter identity and block context.
 * Used by the directory sync to compute per-DRep `lastVotedAt` in O(1)
 * Koios calls rather than O(N) per-DRep `drep_voters` calls.
 *
 * Mainnet has ~24k vote rows today and grows slowly; well under the
 * 100k punt-protocol threshold and ~5MB on the wire.
 */
export interface KoiosVote {
  vote_tx_hash: string;
  /** "DRep" | "SPO" | "ConstitutionalCommittee" — verbatim. */
  voter_role: string;
  /** For DRep votes this is the bech32 `drep1...` ID. */
  voter_id: string;
  proposal_id: string | null;
  proposal_tx_hash: string;
  proposal_index: number;
  proposal_type: string;
  epoch_no: number;
  block_height: number;
  /** Unix seconds; multiply by 1000 for JS Date. */
  block_time: number;
  vote: string;
  meta_url: string | null;
  meta_hash: string | null;
  meta_json: Record<string, unknown> | null;
}

/**
 * One row of `drep_delegators` — a stake account that has delegated its
 * vote weight to this DRep, with the lovelace amount currently delegated.
 * Used for the per-DRep delegator count.
 */
export interface KoiosDRepDelegator {
  stake_address: string;
  stake_address_hex: string | null;
  /** Stake amount in lovelace, stringified. */
  amount: string;
  /** Epoch when the delegation was last updated. */
  epoch_no: number | null;
}

/**
 * One row of `pool_list`. `active_stake` is the delegated stake currently
 * counted toward block production — also what governance uses for SPO
 * voting power. `pool_status === 'registered'` AND `retiring_epoch === null`
 * is the "currently active" filter.
 */
export interface KoiosPool {
  pool_id_bech32: string;
  pool_id_hex: string;
  ticker: string | null;
  pool_status: string;
  retiring_epoch: number | null;
  /** Active stake in lovelace, as stringified integer. */
  active_stake: string | null;
}

/** Synthesized active-pool row — pool_id + active_stake, filtered. */
export interface KoiosActivePool {
  pool_id_bech32: string;
  pool_id_hex: string;
  ticker: string | null;
  /** Active stake in lovelace, stringified. Always non-null in this shape;
   *  rows with no active_stake (yet-to-be-active) are filtered out. */
  active_stake: string;
}

/**
 * One member of the Constitutional Committee, as returned by
 * `committee_info.members`. Status is the lifecycle bucket: only
 * `'authorized'` members can vote.
 */
export interface KoiosCommitteeMember {
  status: string;
  cc_hot_id: string | null;
  cc_cold_id: string | null;
  cc_hot_hex: string | null;
  cc_cold_hex: string | null;
  expiration_epoch: number | null;
  cc_hot_has_script: boolean | null;
  cc_cold_has_script: boolean | null;
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
let _drepCache: CacheEntry<KoiosActiveDRep[]> | null = null;
let _poolCache: CacheEntry<KoiosActivePool[]> | null = null;
let _committeeCache: CacheEntry<KoiosCommitteeMember[]> | null = null;
let _voteCache: CacheEntry<KoiosVote[]> | null = null;

/** 5 minutes. Votes don't change THAT fast — at one block per ~20s on
 *  mainnet and a tiny fraction of those carrying a vote, the staleness
 *  window is well within tolerance for "Voted X ago" badges. */
const VOTE_CACHE_TTL_MS = 5 * 60 * 1000;

/** Reset cache (test-only escape hatch). Not exported in the public API
 *  surface but available via the module record if a future test needs it. */
export function _resetCache(): void {
  _proposalCache = null;
  _drepCache = null;
  _poolCache = null;
  _committeeCache = null;
  _voteCache = null;
  _tipCache = null;
  _epochInfoCache = null;
}

/**
 * S4 hardening (2026-06-10 security review) — invalidate ONLY the
 * Constitutional Committee cache. Used by the daily role-revalidation
 * cron's strict adapter so a CC member who resigned mid-day is caught
 * on the next pass even if the lambda runtime kept a warm
 * `_committeeCache` from an earlier per-request call within the same
 * container.
 *
 * The cache TTL is 1h (`COMMITTEE_CACHE_TTL_MS`); for daily-cadence
 * cron use that's effectively serving stale data for almost the
 * entire pass. Invalidating just the committee slot is the surgical
 * fix — proposal / pool / drep caches still serve.
 */
export function invalidateCommitteeCache(): void {
  _committeeCache = null;
}

// ---- Internal helpers ----

/**
 * Issue a single Koios request with a hard timeout, status-code check, and
 * response-size cap. Reads the body as a single stream so we can bail
 * before allocating gigabytes if upstream returns an unexpectedly huge body.
 */
async function koiosFetch(
  endpoint: string,
  init: RequestInit & {
    rangeFrom?: number;
    rangeTo?: number;
    /** Offset/limit query-param pagination — used by endpoints (`drep_list`,
     *  `pool_list`) where the `Range` header is silently ignored by the
     *  Koios PostgREST layer. Probed empirically: passing `Range: 1000-1999`
     *  to `/drep_list` returns the same page-1 rows; `?offset=1000` returns
     *  the genuine page 2. */
    offset?: number;
    limit?: number;
    timeoutMs?: number;
  },
): Promise<Response> {
  const params = new URLSearchParams();
  if (init.offset != null) params.set('offset', String(init.offset));
  if (init.limit != null) params.set('limit', String(init.limit));
  const qs = params.toString();
  const url = `${KOIOS_BASE}${endpoint}${qs ? `?${qs}` : ''}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), init.timeoutMs ?? REQUEST_TIMEOUT_MS);
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
      throw new KoiosError(endpoint, `request timed out after ${init.timeoutMs ?? REQUEST_TIMEOUT_MS}ms`);
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

// ---- Active-voter lookups (Phase B: notVoted computation) ----

/**
 * Fetch every page of an offset/limit paginated Koios endpoint. Stops on
 * the first short page or when `maxPages` is reached. Throws `KoiosError`
 * on any failure so the caller can degrade gracefully — the sync MUST
 * continue working without these lookups (notVoted just won't be computed
 * for the affected role this cycle).
 */
async function fetchAllPaged<T>(
  endpoint: string,
  body: string,
  maxPages: number,
): Promise<T[]> {
  const all: T[] = [];
  for (let page = 0; page < maxPages; page++) {
    const offset = page * PAGE_SIZE;
    const res = await koiosFetch(endpoint, {
      method: 'POST',
      body,
      offset,
      limit: PAGE_SIZE,
    });
    if (!res.ok) {
      throw new KoiosError(endpoint, `HTTP ${res.status} ${res.statusText}`, res.status);
    }
    const parsed = (await readJsonCapped(res, endpoint)) as unknown;
    if (!Array.isArray(parsed)) {
      throw new KoiosError(endpoint, 'expected JSON array');
    }
    const rows = parsed as T[];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return all;
}

/**
 * List every currently-active DRep with its voting power (lovelace).
 *
 * Two-step fetch: `drep_list` returns identity + registration flag for all
 * DReps (~1500+ on mainnet today, paginated 1000 per page). We then call
 * `drep_info` in batches of 50 to fetch voting power. Only entries where
 * `drep_info` reports `active === true` carry actual voting weight; expired
 * or retired DReps are filtered out.
 *
 * Predefined DReps (`drep_always_abstain`, `drep_always_no_confidence`)
 * are NOT in `drep_list` but the caller can fetch their power directly via
 * `getPredefinedDRepPower()`.
 *
 * Cached for 10 minutes — DRep registrations change at most once per epoch
 * (~5 days on mainnet). On any error we burn the cache so the next call
 * retries clean.
 */
export async function listActiveDReps(): Promise<KoiosActiveDRep[]> {
  const now = Date.now();
  if (_drepCache && now - _drepCache.fetchedAt < DREP_CACHE_TTL_MS) {
    return _drepCache.value;
  }
  // Step 1: full DRep listing, paginated.
  let listing: KoiosDRepListEntry[];
  try {
    listing = await fetchAllPaged<KoiosDRepListEntry>('/drep_list', '{}', MAX_PAGES);
  } catch (err) {
    _drepCache = null;
    throw err;
  }
  // Filter to registered IDs — retired/expired DReps cannot vote and have
  // no delegated stake counted toward governance. Predefined DReps live
  // outside `drep_list` and are fetched separately by the caller.
  const registeredIds = listing.filter((d) => d.registered).map((d) => d.drep_id);

  // Step 2: batch-fetch voting power. 50 IDs/request stays well under
  // Koios's payload cap (200 IDs returned 413 in our probe).
  const active: KoiosActiveDRep[] = [];
  const idIndex = new Map<string, KoiosDRepListEntry>(listing.map((d) => [d.drep_id, d]));
  for (let i = 0; i < registeredIds.length; i += DREP_INFO_BATCH_SIZE) {
    const batch = registeredIds.slice(i, i + DREP_INFO_BATCH_SIZE);
    const res = await koiosFetch('/drep_info', {
      method: 'POST',
      body: JSON.stringify({ _drep_ids: batch }),
      // drep_info responds quickly; tighten the timeout so a stuck call
      // can't stall the whole sync at this step.
      timeoutMs: 8_000,
    });
    if (!res.ok) {
      _drepCache = null;
      throw new KoiosError(
        '/drep_info',
        `HTTP ${res.status} ${res.statusText}`,
        res.status,
      );
    }
    const parsed = (await readJsonCapped(res, '/drep_info')) as unknown;
    if (!Array.isArray(parsed)) {
      _drepCache = null;
      throw new KoiosError('/drep_info', 'expected JSON array');
    }
    for (const row of parsed as KoiosDRepInfo[]) {
      // Only `active === true` entries carry voting weight. Inactive
      // registered DReps have no delegated stake counted toward governance.
      if (!row.active) continue;
      // Skip rows with malformed amount strings rather than silently
      // counting them as zero.
      if (typeof row.amount !== 'string' || row.amount.length === 0) continue;
      const ident = idIndex.get(row.drep_id);
      active.push({
        drep_id: row.drep_id,
        hex: ident?.hex ?? row.hex,
        has_script: ident?.has_script ?? row.has_script,
        amount: row.amount,
      });
    }
  }
  _drepCache = { fetchedAt: now, value: active };
  return active;
}

/**
 * Fetch voting power for one or more predefined DReps (auto-vote
 * delegations). Currently mainnet has two:
 *   - `drep_always_abstain`: stake here counts as Abstain on every action
 *   - `drep_always_no_confidence`: stake here counts as No on every
 *     non-NoConfidence action, and Yes on NoConfidence actions
 *
 * Returns a map keyed by the requested DRep ID. Missing entries (or any
 * error) resolve to `0n` rather than throwing — the caller can decide
 * whether the data is essential.
 */
export async function getPredefinedDRepPower(
  drepIds: readonly string[],
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  if (drepIds.length === 0) return out;
  try {
    const res = await koiosFetch('/drep_info', {
      method: 'POST',
      body: JSON.stringify({ _drep_ids: drepIds }),
      timeoutMs: 8_000,
    });
    if (!res.ok) {
      console.warn(
        `[Koios /drep_info predefined] HTTP ${res.status} ${res.statusText}; treating as zero`,
      );
      return out;
    }
    const parsed = (await readJsonCapped(res, '/drep_info')) as unknown;
    if (!Array.isArray(parsed)) return out;
    for (const row of parsed as KoiosDRepInfo[]) {
      if (typeof row.amount !== 'string' || row.amount.length === 0) continue;
      try {
        out.set(row.drep_id, BigInt(row.amount));
      } catch {
        // Malformed amount — leave unset (treated as zero downstream).
      }
    }
  } catch (err) {
    console.warn('[Koios /drep_info predefined] fetch failed; treating as zero:', err);
  }
  return out;
}

/**
 * Fetch DRep metadata in batches. Wraps `/drep_metadata` — cheaper than
 * `/drep_info` because it omits voting power / lifecycle fields. Used by
 * the directory sync to populate the CIP-119 `body` (givenName, image,
 * objectives, motivations, qualifications, references) for every DRep.
 *
 * The caller passes a flat list of DRep IDs; we batch into chunks of 50
 * (Koios's payload-size sweet spot — 200 returned 413 in our probe).
 * Failure of one batch logs but does not poison the rest; the caller
 * accumulates whatever succeeded.
 */
export async function fetchDRepMetadata(
  drepIds: readonly string[],
): Promise<KoiosDRepMetadata[]> {
  if (drepIds.length === 0) return [];
  const all: KoiosDRepMetadata[] = [];
  for (let i = 0; i < drepIds.length; i += DREP_INFO_BATCH_SIZE) {
    const batch = drepIds.slice(i, i + DREP_INFO_BATCH_SIZE);
    try {
      const res = await koiosFetch('/drep_metadata', {
        method: 'POST',
        body: JSON.stringify({ _drep_ids: batch }),
        timeoutMs: 8_000,
      });
      if (!res.ok) {
        console.warn(
          `[Koios /drep_metadata] HTTP ${res.status} ${res.statusText} on batch ${i}-${i + batch.length}; skipping`,
        );
        continue;
      }
      const parsed = (await readJsonCapped(res, '/drep_metadata')) as unknown;
      if (!Array.isArray(parsed)) {
        console.warn('[Koios /drep_metadata] non-array response; skipping batch');
        continue;
      }
      all.push(...(parsed as KoiosDRepMetadata[]));
    } catch (err) {
      console.warn(`[Koios /drep_metadata] batch ${i} failed:`, err);
    }
  }
  return all;
}

/**
 * Fetch full DRep info (lifecycle + voting power + meta_url/hash) for a
 * batch of IDs. Returns the raw `KoiosDRepInfo` rows so the caller can
 * keep the registered/expired/active fields.
 *
 * Used by the directory sync (which needs `expires_epoch_no`, `deposit`,
 * `drep_status`, `amount`) and by the per-DRep detail handler. Caching
 * is the caller's responsibility — this function does not cache.
 */
export async function fetchDRepInfoBatch(
  drepIds: readonly string[],
): Promise<KoiosDRepInfo[]> {
  if (drepIds.length === 0) return [];
  const all: KoiosDRepInfo[] = [];
  for (let i = 0; i < drepIds.length; i += DREP_INFO_BATCH_SIZE) {
    const batch = drepIds.slice(i, i + DREP_INFO_BATCH_SIZE);
    try {
      const res = await koiosFetch('/drep_info', {
        method: 'POST',
        body: JSON.stringify({ _drep_ids: batch }),
        timeoutMs: 8_000,
      });
      if (!res.ok) {
        console.warn(
          `[Koios /drep_info] HTTP ${res.status} ${res.statusText} on batch ${i}-${i + batch.length}; skipping`,
        );
        continue;
      }
      const parsed = (await readJsonCapped(res, '/drep_info')) as unknown;
      if (!Array.isArray(parsed)) {
        console.warn('[Koios /drep_info] non-array response; skipping batch');
        continue;
      }
      all.push(...(parsed as KoiosDRepInfo[]));
    } catch (err) {
      console.warn(`[Koios /drep_info] batch ${i} failed:`, err);
    }
  }
  return all;
}

/**
 * List the full DRep registry. Wrapper over the paged `drep_list` call
 * used by `listActiveDReps`, exposed so the directory sync can iterate
 * every registered DRep (active OR not — `notRegistered` is the signal
 * that they should drop off the directory entirely).
 */
export async function listAllDReps(): Promise<KoiosDRepListEntry[]> {
  return fetchAllPaged<KoiosDRepListEntry>('/drep_list', '{}', MAX_PAGES);
}

/**
 * Fetch every governance vote ever cast on mainnet (DRep, SPO, CC).
 *
 * Used by the directory sync to compute per-DRep `lastVotedAt` /
 * `voteCount` in a single pass rather than O(N) `drep_voters` calls.
 * Mainnet has tens of thousands of vote rows today and grows steadily.
 * Cached for 5 minutes to absorb repeat invocations within a sync cycle
 * (the sync calls this once today, but the cache is cheap insurance).
 *
 * **Pagination quirk:** Koios's PostgREST layer silently ignores the
 * `Range: 1000-1999` header on `/vote_list` (and `/drep_list`,
 * `/pool_list`) — every Range-paginated request returns page 0. Probe
 * confirms only `?offset=N&limit=M` query-param pagination works, which
 * matches what `fetchAllPaged` already does for the DRep / pool listings.
 * Earlier revisions of this function used `Range` and capped out at 1000
 * votes — the long-tail DReps appeared as `voteCount: 0` even though
 * they had public on-chain history.
 *
 * Hard-capped at 100 pages = 100k votes. Past that we'd need per-role
 * chunking (and the 10MB response cap on a single page is well under
 * the per-page slice anyway). Defensive against runaway pagination.
 *
 * Throws `KoiosError` on failure — the directory sync handles that by
 * skipping the lastVotedAt enrichment for the current cycle (rows still
 * get written; voters just won't get a fresh "Voted X ago" until the
 * next successful sync).
 */
const VOTE_MAX_PAGES = 100;
export async function listAllVotes(): Promise<KoiosVote[]> {
  const now = Date.now();
  if (_voteCache && now - _voteCache.fetchedAt < VOTE_CACHE_TTL_MS) {
    return _voteCache.value;
  }
  let all: KoiosVote[];
  try {
    all = await fetchAllPaged<KoiosVote>('/vote_list', '{}', VOTE_MAX_PAGES);
  } catch (err) {
    _voteCache = null;
    throw err;
  }
  _voteCache = { fetchedAt: now, value: all };
  return all;
}

/**
 * Group an already-fetched vote list by `actionId` (`tx_hash#cert_index`).
 * Used by the governance-intake sync to convert the global `vote_list` feed
 * into per-proposal slices in O(N) once per cycle, replacing the per-action
 * Blockfrost `proposalVotes` calls (which were costing ~109 calls/cycle on
 * mainnet today).
 *
 * The map key matches the `actionId` shape used everywhere else in the sync
 * so callers can pluck their votes with a single `.get(actionId)`.
 */
export function groupVotesByProposal(
  votes: readonly KoiosVote[],
): Map<string, KoiosVote[]> {
  const out = new Map<string, KoiosVote[]>();
  for (const v of votes) {
    if (typeof v.proposal_tx_hash !== 'string') continue;
    if (typeof v.proposal_index !== 'number') continue;
    const key = `${v.proposal_tx_hash}#${v.proposal_index}`;
    const bucket = out.get(key);
    if (bucket) bucket.push(v);
    else out.set(key, [v]);
  }
  return out;
}

// ---- Tip / current epoch + staleness check ----

/** `/tip` returns one row with the current chain tip (epoch, slot, block,
 *  block_time). We consume `epoch_no` and `block_time`; the latter feeds
 *  the db-sync staleness check below. Cached briefly — syncs call this
 *  once per cycle but the cache lets a future warm-Lambda re-invocation
 *  skip the redundant call. Throws `KoiosError` so the caller can fall
 *  back to Blockfrost's `epochsLatest`. */
const TIP_CACHE_TTL_MS = 30_000;

/**
 * Threshold beyond which Koios's db-sync is considered "lagging" — i.e.
 * its returned data is materially staler than what's on-chain.
 *
 * Why 5 minutes: a healthy Koios node tracks the chain tip within
 * ~20-60s (a block + a small db-sync ingest delay). Lag of 1-2 min
 * happens routinely under load and is fine. Past 5 minutes the user is
 * looking at delegation / vote / proposal data that may be missing
 * activity from the last several blocks — which on a governance app
 * like drep.tools is a correctness problem worth surfacing.
 *
 * Kept as a constant rather than env-overrideable for now — the
 * threshold is a product decision, not a per-environment knob. The
 * CloudWatch metric filter on `[Koios tip lag]` can be tuned at the
 * alarm layer if 5 min ever turns out wrong.
 */
export const KOIOS_TIP_LAG_THRESHOLD_SEC = 5 * 60;

/**
 * Result of a `/tip` fetch with staleness information attached. Returned
 * by `getCurrentTip` and consumed internally by `getCurrentEpoch`.
 *
 * `lagSec` is `Math.max(0, wallClock - blockTime)` in seconds. A
 * negative computed value (clock skew between Lambda and Cardano nodes,
 * or a tip block from "the future") clamps to 0 — we never report
 * negative lag.
 *
 * `isStale` is `lagSec > KOIOS_TIP_LAG_THRESHOLD_SEC`. Callers can use
 * this directly to decorate sync results without re-deriving the
 * comparison.
 */
export interface KoiosTipInfo {
  /** Current epoch number, mirroring `getCurrentEpoch`. */
  epochNo: number;
  /** Tip block's Unix-seconds timestamp from Koios. */
  blockTime: number;
  /** How many seconds behind wall-clock the tip block is. >=0. */
  lagSec: number;
  /** True when lagSec exceeds `KOIOS_TIP_LAG_THRESHOLD_SEC`. */
  isStale: boolean;
}

let _tipCache: CacheEntry<KoiosTipInfo> | null = null;

/**
 * Compute the lag in seconds between a tip block's `block_time` (Unix
 * seconds from Koios) and wall-clock `nowMs` (milliseconds from
 * `Date.now()`). Clamps at zero — a "future" tip means clock skew or a
 * test fixture, not negative lag.
 *
 * Exported for unit testing. The integration is exercised through
 * `getCurrentTip` with a mocked fetch.
 */
export function computeTipLagSec(blockTime: number, nowMs: number): number {
  if (!Number.isFinite(blockTime) || !Number.isFinite(nowMs)) return 0;
  const lag = Math.floor(nowMs / 1000) - Math.floor(blockTime);
  return lag > 0 ? lag : 0;
}

/**
 * Fetch `/tip` and decorate with staleness info. Cached at module scope
 * for `TIP_CACHE_TTL_MS`. On a stale tip (lag > threshold) the function
 * `console.warn`s a structured `[Koios tip lag]` line — designed so a
 * CloudWatch metric filter / alarm can flag db-sync stalls without
 * needing a separate scheduled job. The log line is emitted once per
 * cold-cache fetch — repeated warm-cache calls within the 30s TTL do
 * NOT re-emit (the warning would be noise, and the underlying data
 * hasn't changed).
 *
 * The returned `KoiosTipInfo.lagSec` lets callers (syncs) thread the
 * value into their own result/log shapes so a sync's CloudWatch log
 * line surfaces the lag inline with the per-cycle counters. The
 * structured warn is the alarming hook; the per-sync logging is the
 * forensic hook.
 *
 * Throws `KoiosError` on failure so the caller can fall back to
 * Blockfrost's `epochsLatest` (which carries `start_time` / `end_time`
 * and can also be used for a similar staleness signal, though we don't
 * compute one for it today).
 */
export async function getCurrentTip(): Promise<KoiosTipInfo> {
  const nowMs = Date.now();
  if (_tipCache && nowMs - _tipCache.fetchedAt < TIP_CACHE_TTL_MS) {
    return _tipCache.value;
  }
  const res = await koiosFetch('/tip', { method: 'GET', timeoutMs: 5_000 });
  if (!res.ok) {
    _tipCache = null;
    throw new KoiosError('/tip', `HTTP ${res.status} ${res.statusText}`, res.status);
  }
  const parsed = (await readJsonCapped(res, '/tip')) as unknown;
  const row = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!row || typeof row !== 'object') {
    _tipCache = null;
    throw new KoiosError('/tip', 'missing tip row');
  }
  const r = row as { epoch_no?: unknown; block_time?: unknown };
  if (typeof r.epoch_no !== 'number') {
    _tipCache = null;
    throw new KoiosError('/tip', 'missing epoch_no');
  }
  if (typeof r.block_time !== 'number') {
    _tipCache = null;
    throw new KoiosError('/tip', 'missing block_time');
  }
  const lagSec = computeTipLagSec(r.block_time, nowMs);
  const isStale = lagSec > KOIOS_TIP_LAG_THRESHOLD_SEC;
  const info: KoiosTipInfo = {
    epochNo: r.epoch_no,
    blockTime: r.block_time,
    lagSec,
    isStale,
  };
  if (isStale) {
    // Structured single-line log for a CloudWatch metric filter / alarm.
    // The literal `[Koios tip lag]` prefix is the filter pattern hook.
    // Keep the key=value shape on one line so a metric filter can
    // extract `lagSec` numerically.
    console.warn(
      `[Koios tip lag] lagSec=${lagSec} thresholdSec=${KOIOS_TIP_LAG_THRESHOLD_SEC} blockTime=${r.block_time} epochNo=${r.epoch_no}`,
    );
  }
  _tipCache = { fetchedAt: nowMs, value: info };
  return info;
}

/**
 * Back-compat wrapper. Existing callers (cc-members, governance-intake,
 * epoch handler) consume only the current epoch number, so we keep the
 * narrow shape they already use. The staleness check fires inside
 * `getCurrentTip` regardless — callers that DO want the lag value
 * should switch to `getCurrentTip` directly.
 */
export async function getCurrentEpoch(): Promise<number> {
  const info = await getCurrentTip();
  return info.epochNo;
}

// ---- Account info (Phase C: replaces Blockfrost `accounts/{stake_address}`) ----
//
// `account_info_cached` is the Koios POST endpoint that returns the same
// shape Blockfrost's `accounts/{stake_address}` does — stake amount,
// rewards, current DRep delegation, current pool delegation, registration
// status — but accepts a batch of addresses in one call. We expose two
// flavors:
//   - `fetchAccountInfoBatch(addresses)` for the rare bulk case (none in
//     production today, but symmetric with `fetchDRepInfoBatch` so future
//     code can use it without a follow-up migration);
//   - `fetchAccountInfo(stakeAddress)` for the single-address case used
//     by `recognition.ts` (per-comment lookup) and `delegationHistory.ts`
//     (per-request lookup).
//
// Field-name mapping vs Blockfrost:
//   Blockfrost.controlled_amount  -> Koios.total_balance
//   Blockfrost.drep_id            -> Koios.delegated_drep
//   Blockfrost.pool_id            -> Koios.delegated_pool
//   Blockfrost.active             -> Koios.status === 'registered'
// Other fields are mapped as documented inline; see `KoiosAccountInfo`
// below for the full type.

/**
 * One row of the `account_info_cached` response. Fields are nullable per
 * the spec — a stake address that has never been registered comes back
 * with most fields null and `status: 'not registered'`.
 *
 * `total_balance` is the closest analogue to Blockfrost's
 * `controlled_amount` — it includes UTxO balance + rewards + reserves +
 * treasury reward addresses. Stringified to preserve precision past 2^53.
 */
export interface KoiosAccountInfo {
  stake_address: string;
  /** `'registered' | 'not registered' | 'retired'` — verbatim from upstream. */
  status: string;
  /** Bech32 pool ID this stake currently delegates to. Null when undelegated. */
  delegated_pool: string | null;
  /** Bech32 DRep ID this stake currently delegates to (or predefined
   *  `drep_always_abstain` / `drep_always_no_confidence`). Null when
   *  the stake has not yet voted-delegated. */
  delegated_drep: string | null;
  /** Total controlled stake in lovelace, stringified. Includes UTxO +
   *  rewards available. */
  total_balance: string;
  /** UTxO-only balance. */
  utxo: string | null;
  /** Lifetime reward sum. */
  rewards: string | null;
  /** Lifetime withdrawal sum. */
  withdrawals: string | null;
  /** Rewards still claimable (not yet withdrawn). */
  rewards_available: string | null;
  /** Lifetime reserve rewards. */
  reserves: string | null;
  /** Lifetime treasury rewards. */
  treasury: string | null;
  /** Active stake at the current epoch, when known. */
  active_stake?: string | null;
  /** Active epoch number for this delegation. */
  active_epoch_no?: number | null;
}

/**
 * Fetch account info for one or more stake addresses via Koios
 * `/account_info_cached`. Returns the raw rows; the caller is
 * responsible for shape-adapting to whatever it needs (Blockfrost-shape
 * for back-compat, or the Koios shape directly).
 *
 * Throws `KoiosError` on any failure — single-address callers should
 * wrap this in their own fallback (the Phase C wrappers below do).
 */
export async function fetchAccountInfoBatch(
  stakeAddresses: readonly string[],
): Promise<KoiosAccountInfo[]> {
  if (stakeAddresses.length === 0) return [];
  const res = await koiosFetch('/account_info_cached', {
    method: 'POST',
    body: JSON.stringify({ _stake_addresses: stakeAddresses }),
    timeoutMs: 8_000,
  });
  if (!res.ok) {
    throw new KoiosError(
      '/account_info_cached',
      `HTTP ${res.status} ${res.statusText}`,
      res.status,
    );
  }
  const parsed = (await readJsonCapped(res, '/account_info_cached')) as unknown;
  if (!Array.isArray(parsed)) {
    throw new KoiosError('/account_info_cached', 'expected JSON array');
  }
  return parsed as KoiosAccountInfo[];
}

/**
 * Fetch one stake address's account info. Wraps `fetchAccountInfoBatch`
 * and unwraps the single row. Returns null when Koios reports the
 * address is not in the cache (an unregistered or freshly-created stake
 * address — `account_info_cached` returns an empty array rather than a
 * row with `status: 'not registered'` in some Koios revisions).
 *
 * **Migration rationale:** this is the Koios analogue of Blockfrost's
 * `accounts(stake_address)`. Both providers source from cardano-db-sync,
 * so the underlying state is identical — only the response field naming
 * differs. The Phase C migration uses this as primary and Blockfrost as
 * fallback for `recognition.ts` and `delegationHistory.ts`.
 *
 * Throws `KoiosError` on any transport / 4xx / 5xx failure so the caller
 * can fall back cleanly.
 */
export async function fetchAccountInfo(
  stakeAddress: string,
): Promise<KoiosAccountInfo | null> {
  const rows = await fetchAccountInfoBatch([stakeAddress]);
  if (rows.length === 0) return null;
  // Defensive: the upstream sometimes returns a row even for unregistered
  // addresses, with `status: 'not registered'` and most fields null. The
  // caller decides how to handle that — we surface the row as-is rather
  // than collapsing it to null.
  return rows[0] ?? null;
}

// ---- Epoch info (Phase C: replaces Blockfrost `epochsLatest`) ----
//
// The `/epoch_info` endpoint accepts `?_epoch_no=N` and returns the same
// fields Blockfrost's `epochsLatest` does (epoch, start_time, end_time,
// first_block_time, last_block_time, block_count, tx_count, output,
// fees, active_stake) — plus a few extras Koios indexes that we ignore.
//
// We expose two helpers:
//   - `getCurrentEpochInfo()` — calls `/tip` (already cached) to find
//     the current epoch, then `/epoch_info` for the details. Two calls
//     per cold cache, one per warm.
//   - `getEpochInfo(epochNo)` — explicit epoch lookup. Currently only
//     used internally by `getCurrentEpochInfo`, exported for future use.

/**
 * One row of `/epoch_info`. Field names mirror the upstream payload
 * exactly. Most fields are nullable on epochs that haven't started yet;
 * for the current/past epoch they should all be populated.
 */
export interface KoiosEpochInfo {
  epoch_no: number;
  out_sum: string | null;
  fees: string | null;
  tx_count: number | null;
  blk_count: number | null;
  /** Unix seconds — epoch start. */
  start_time: number | null;
  /** Unix seconds — epoch end (deterministic; `start_time + 432000` on mainnet). */
  end_time: number | null;
  first_block_time: number | null;
  last_block_time: number | null;
  active_stake: string | null;
  total_rewards: string | null;
  avg_blk_reward: string | null;
}

/** Short cache TTL for epoch info — the data only changes every 5 days
 *  but we want the SPA countdown to feel "fresh" so we re-fetch every
 *  minute on a warm Lambda. */
const EPOCH_INFO_CACHE_TTL_MS = 60_000;
let _epochInfoCache: CacheEntry<KoiosEpochInfo> | null = null;

/**
 * Fetch the current epoch's full info via Koios. Uses `/tip` for the
 * current epoch number (cheap; cached at 30s anyway) and `/epoch_info`
 * for the row. Cached at module scope for `EPOCH_INFO_CACHE_TTL_MS` so
 * a warm Lambda doesn't hit Koios twice per request burst.
 *
 * **Migration rationale:** this is the Koios analogue of Blockfrost's
 * `epochsLatest`. Used by Phase C in `epoch/get.ts` as primary, with
 * the existing Blockfrost path as fallback.
 *
 * Throws `KoiosError` on any failure so the caller can fall back.
 */
export async function getCurrentEpochInfo(): Promise<KoiosEpochInfo> {
  const now = Date.now();
  if (_epochInfoCache && now - _epochInfoCache.fetchedAt < EPOCH_INFO_CACHE_TTL_MS) {
    return _epochInfoCache.value;
  }
  const epochNo = await getCurrentEpoch();
  const info = await getEpochInfo(epochNo);
  _epochInfoCache = { fetchedAt: now, value: info };
  return info;
}

/**
 * Explicit epoch lookup. Used internally by `getCurrentEpochInfo`;
 * exported so a future "show epoch N history" page can fetch by epoch
 * number without duplicating the parsing logic.
 */
export async function getEpochInfo(epochNo: number): Promise<KoiosEpochInfo> {
  const res = await koiosFetch(`/epoch_info?_epoch_no=${epochNo}`, {
    method: 'GET',
    timeoutMs: 5_000,
  });
  if (!res.ok) {
    throw new KoiosError(
      '/epoch_info',
      `HTTP ${res.status} ${res.statusText}`,
      res.status,
    );
  }
  const parsed = (await readJsonCapped(res, '/epoch_info')) as unknown;
  const row = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!row || typeof row !== 'object' || typeof (row as { epoch_no?: unknown }).epoch_no !== 'number') {
    throw new KoiosError('/epoch_info', 'missing epoch_no');
  }
  return row as KoiosEpochInfo;
}

// ---- Epoch protocol parameters (Sprint 5 — DRep voting thresholds) ----
//
// `/epoch_params` returns the live protocol params for an epoch — most
// notably the `dvt_*` fields that encode the DRep voting thresholds per
// governance action type (NoConfidence, UpdateCommittee normal/no-confidence,
// HardFork, NewConstitution, TreasuryWithdrawal, ParameterChange in four
// flavors, MotionNoConfidence's UpdateToConstitution, …). The concentration
// donut uses these to mark the 60/67/75 thresholds.

/** Subset of `/epoch_params` fields the concentration donut cares about. All
 *  values are fractional doubles in [0, 1] (e.g. 0.67 for 67%). Optional
 *  because not every field is guaranteed to be present in every epoch — we
 *  drop the markers we couldn't resolve rather than failing the request. */
export interface KoiosEpochDvtParams {
  /** No-confidence motion threshold. */
  dvt_motion_no_confidence?: number;
  /** Update committee — normal mode. */
  dvt_committee_normal?: number;
  /** Update committee — no-confidence mode. */
  dvt_committee_no_confidence?: number;
  /** Update to the constitution. */
  dvt_update_to_constitution?: number;
  /** Hard fork initiation. */
  dvt_hard_fork_initiation?: number;
  /** Protocol parameter change — network group. */
  dvt_p_p_network_group?: number;
  /** Protocol parameter change — economic group. */
  dvt_p_p_economic_group?: number;
  /** Protocol parameter change — technical group. */
  dvt_p_p_technical_group?: number;
  /** Protocol parameter change — governance group. */
  dvt_p_p_gov_group?: number;
  /** Treasury withdrawal. */
  dvt_treasury_withdrawal?: number;
}

/**
 * Fetch DRep voting thresholds for an epoch. Returns null on any failure
 * — callers should treat the donut markers as "thresholds unknown" rather
 * than blocking the response.
 */
export async function getEpochParams(epochNo: number): Promise<KoiosEpochDvtParams | null> {
  try {
    const res = await koiosFetch(`/epoch_params?_epoch_no=${epochNo}`, {
      method: 'GET',
      timeoutMs: 5_000,
    });
    if (!res.ok) {
      console.warn(`[Koios /epoch_params] HTTP ${res.status} for epoch ${epochNo}`);
      return null;
    }
    const parsed = (await readJsonCapped(res, '/epoch_params')) as unknown;
    const row = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!row || typeof row !== 'object') return null;
    const r = row as Record<string, unknown>;
    const pick = (k: string): number | undefined => {
      const v = r[k];
      return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    };
    return {
      dvt_motion_no_confidence: pick('dvt_motion_no_confidence'),
      dvt_committee_normal: pick('dvt_committee_normal'),
      dvt_committee_no_confidence: pick('dvt_committee_no_confidence'),
      dvt_update_to_constitution: pick('dvt_update_to_constitution'),
      dvt_hard_fork_initiation: pick('dvt_hard_fork_initiation'),
      dvt_p_p_network_group: pick('dvt_p_p_network_group'),
      dvt_p_p_economic_group: pick('dvt_p_p_economic_group'),
      dvt_p_p_technical_group: pick('dvt_p_p_technical_group'),
      dvt_p_p_gov_group: pick('dvt_p_p_gov_group'),
      dvt_treasury_withdrawal: pick('dvt_treasury_withdrawal'),
    };
  } catch (err) {
    console.warn(`[Koios /epoch_params] fetch failed for epoch ${epochNo}:`, err);
    return null;
  }
}

// ---- DRep voting power history (Phase C: new sync) ----
//
// `/drep_voting_power_history` returns one row per epoch this DRep has
// existed in, with the voting power they carried at the snapshot
// boundary. Used by the new daily voting-power-history sync to populate
// the per-DRep sparkline on the directory detail page.

/** One row of `drep_voting_power_history`. */
export interface KoiosDRepPowerHistoryRow {
  drep_id: string;
  epoch_no: number;
  /** Voting power in lovelace, stringified BigInt. */
  amount: string;
}

/**
 * Fetch the full voting-power history for one DRep. Returns null on any
 * failure — the daily sync treats this as best-effort per row and skips
 * over DReps whose history call fails.
 */
export async function fetchDRepPowerHistory(
  drepId: string,
): Promise<KoiosDRepPowerHistoryRow[] | null> {
  try {
    // Note: the endpoint takes a SINGULAR `_drep_id` parameter, unlike
    // most other Koios `_drep_*` endpoints which accept an array. Sending
    // `_drep_ids` instead returns 404 with no error message.
    const res = await koiosFetch('/drep_voting_power_history', {
      method: 'POST',
      body: JSON.stringify({ _drep_id: drepId }),
      timeoutMs: 8_000,
    });
    if (!res.ok) {
      console.warn(
        `[Koios /drep_voting_power_history] HTTP ${res.status} for ${drepId}`,
      );
      return null;
    }
    const parsed = (await readJsonCapped(res, '/drep_voting_power_history')) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed as KoiosDRepPowerHistoryRow[];
  } catch (err) {
    console.warn(
      `[Koios /drep_voting_power_history] fetch failed for ${drepId}:`,
      err,
    );
    return null;
  }
}

/**
 * Fetch every action this DRep has voted on. Single endpoint; not paged
 * server-side beyond Koios's default 1000-row cap, which is far more
 * than any DRep has voted on today. No caching — the per-DRep detail
 * handler caches at its own scope.
 *
 * Returns null on any failure — voting history is best-effort and the
 * detail handler must continue without it. The DRep page just won't
 * show the recent-votes table.
 */
export async function fetchDRepVotes(
  drepId: string,
): Promise<KoiosDRepVote[] | null> {
  try {
    const res = await koiosFetch('/drep_voters', {
      method: 'POST',
      body: JSON.stringify({ _drep_id: drepId }),
      timeoutMs: 8_000,
    });
    if (!res.ok) {
      console.warn(`[Koios /drep_voters] HTTP ${res.status} for ${drepId}`);
      return null;
    }
    const parsed = (await readJsonCapped(res, '/drep_voters')) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed as KoiosDRepVote[];
  } catch (err) {
    console.warn(`[Koios /drep_voters] fetch failed for ${drepId}:`, err);
    return null;
  }
}

/** Defensive ceiling on the row count we'll accumulate before declaring
 *  the answer "approximate." Each Koios page is one HTTP round-trip
 *  (1000 rows max), so this also bounds the round-trips on hot DReps.
 *
 *  Background (2026-05-27): the previous design used a 5-page cap
 *  (effective ceiling of 5000 rows) which on the largest DReps stretched
 *  wall-clock to ~30-40s — uncomfortably close to the API Lambda's 30s
 *  timeout. Worse, as the directory grows organically more DReps cross
 *  the cap, so the worst-case latency was creeping up over time. Cutting
 *  the cap to 1000 means the worst case is a single Koios round-trip
 *  (page 0 fills the cap; we stop) and the answer is "1000+" — which is
 *  not less actionable than "5000+" to a human looking at it.
 *
 *  Predefined DReps (Always Abstain, Always No Confidence) already
 *  bypass this walk in `directory/get.ts` — they have millions of
 *  delegators and the walk would dwarf the Lambda budget regardless.
 *
 *  Env override: `MAX_DELEGATORS_WALK` (a positive integer) lets us
 *  bump the cap from CDK without a code change if the UX value of a
 *  precise tail count ever outweighs the latency hit. */
const MAX_DELEGATORS_WALK_DEFAULT = 1000;

function getMaxDelegatorsWalk(): number {
  const raw = process.env['MAX_DELEGATORS_WALK'];
  if (!raw) return MAX_DELEGATORS_WALK_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return MAX_DELEGATORS_WALK_DEFAULT;
  return parsed;
}

/** Hard upper bound on Koios page count. Even with `MAX_DELEGATORS_WALK`
 *  bumped, we won't walk more than this many pages — a defense against
 *  a misconfigured override accidentally exhausting the Lambda budget.
 *  At PAGE_SIZE=1000, this caps the walk at 10k rows. */
const DREP_DELEGATORS_MAX_PAGES = 10;

/**
 * Result shape for `fetchDRepDelegatorCount`. We deliberately do NOT return
 * the full delegator list — most callers only need the count, and shipping
 * a 1000+ row array through serializers wastes Lambda memory + bytes.
 *
 * `isApprox: true` means we hit the configured cap (`MAX_DELEGATORS_WALK`)
 * and stopped — the real count is `>= count`. The UI should render
 * "{count}+" rather than a precise number. Same flag also surfaces
 * partial counts from mid-walk failures (Koios rate-limit, network
 * blip) so the frontend treats them uniformly as "≥ count, don't trust
 * exactly."
 *
 * Renamed from `truncated` on 2026-05-27 for semantic clarity — "approx"
 * better describes the contract ("the real number is at least this big")
 * than "truncated" did.
 */
export interface DRepDelegatorCountResult {
  count: number;
  /** True when the count is a lower bound, not the exact total. See above. */
  isApprox: boolean;
}

/**
 * Resolve the number of stake accounts delegated to this DRep, walking
 * Koios's `/drep_delegators` PostgREST pagination (1000 rows per page).
 *
 * # Why this exists
 *
 * Earlier revisions returned the full delegator-list array and the
 * detail handler used `.length` as the count. Two issues with that:
 *   1. Koios paginates at 1000 rows per page (`?limit=1000` is the
 *      PostgREST cap). A single-page call silently truncated to 1000,
 *      so every popular DRep on mainnet (Yoroi, EMURGO, Cardano Vision,
 *      etc.) reported "1,000 delegators" indefinitely.
 *   2. Returning the full array allocated multi-MB on hot DReps and
 *      forced the JSON serializer to walk every row, even though the
 *      handler discarded everything but the length.
 *
 * The new shape returns `{ count, isApprox }`. The boolean lets the UI
 * render "{count}+" when we hit the configured walk cap. Whether the
 * actual tail is 1043 or 8721 is not actionable — "1000+" is enough
 * for the user to know "this is a popular DRep."
 *
 * # Failure modes
 *
 * - First-page failure (network / 5xx / parse): returns `null` so the
 *   handler can degrade to the cached lifecycle count.
 * - Mid-walk failure (rare; Koios sometimes rate-limits or gets slow
 *   on later offsets): returns `{ count: rows_so_far, isApprox: true }`.
 *   Partial-but-flagged is more useful than `null` here.
 */
export async function fetchDRepDelegatorCount(
  drepId: string,
): Promise<DRepDelegatorCountResult | null> {
  const body = JSON.stringify({ _drep_id: drepId });
  const maxWalk = getMaxDelegatorsWalk();
  let count = 0;
  for (let page = 0; page < DREP_DELEGATORS_MAX_PAGES; page++) {
    let res: Response;
    try {
      res = await koiosFetch('/drep_delegators', {
        method: 'POST',
        body,
        offset: page * PAGE_SIZE,
        limit: PAGE_SIZE,
        timeoutMs: 8_000,
      });
    } catch (err) {
      if (page === 0) {
        console.warn(`[Koios /drep_delegators] fetch failed for ${drepId}:`, err);
        return null;
      }
      console.warn(
        `[Koios /drep_delegators] page ${page} failed for ${drepId}, returning partial:`,
        err,
      );
      return { count, isApprox: true };
    }
    if (!res.ok) {
      if (page === 0) {
        console.warn(`[Koios /drep_delegators] HTTP ${res.status} for ${drepId}`);
        return null;
      }
      console.warn(
        `[Koios /drep_delegators] page ${page} returned HTTP ${res.status}, returning partial`,
      );
      return { count, isApprox: true };
    }
    let parsed: unknown;
    try {
      parsed = await readJsonCapped(res, '/drep_delegators');
    } catch (err) {
      if (page === 0) {
        console.warn(`[Koios /drep_delegators] body parse failed for ${drepId}:`, err);
        return null;
      }
      return { count, isApprox: true };
    }
    if (!Array.isArray(parsed)) {
      if (page === 0) return null;
      return { count, isApprox: true };
    }
    const rows = parsed as KoiosDRepDelegator[];
    count += rows.length;
    // PostgREST signals "no more pages" by returning a page shorter than
    // the requested limit. That's the ONLY way we know we got the full
    // tail — explicit count or `Content-Range` total would be cleaner but
    // PostgREST's defaults don't surface either reliably.
    if (rows.length < PAGE_SIZE) {
      return { count, isApprox: false };
    }
    // Stop once we've accumulated MAX_DELEGATORS_WALK rows. The next
    // page would push count past the cap; on popular DReps the
    // marginal value of an exact count drops to zero past this point.
    if (count >= maxWalk) {
      return { count, isApprox: true };
    }
  }
  // We hit the hard MAX_PAGES safety cap without seeing a short page.
  // Same flag — the UI doesn't care whether we stopped at the soft cap
  // or the hard one.
  return { count, isApprox: true };
}

/**
 * Walk Koios `/drep_delegators` to count the stake accounts delegating to
 * one of the two predefined DReps (`drep_always_abstain` /
 * `drep_always_no_confidence`).
 *
 * # Why this is a single request, not a page walk
 *
 * The predefined accounts have hundreds of thousands of delegators on
 * mainnet (Abstain alone was 181,308 on 2026-05-28). An earlier revision
 * walked `/drep_delegators` 100 pages × 1000 rows = up to 100k rows per
 * cycle — but Abstain genuinely has more than that, so the walk always
 * hit the cap, persisted an underestimate, and (worse) routinely timed
 * out the 5-min directory-sync Lambda. The on-record symptom was
 * `delegatorCount: 5000` on production while Koios reported 181k.
 *
 * The fix uses PostgREST's exact-count header. Sending
 * `Prefer: count=exact` on any `/drep_delegators` request makes Koios
 * include `Content-Range: 0-{returned-1}/{total}` on the response. We
 * issue one request with `Range: 0-0` (one row, minimal payload),
 * discard the body, and parse `<TOTAL>` from `Content-Range`. One
 * sub-second round-trip per cycle per predefined DRep — fully precise.
 *
 * # Failure modes
 *
 * - Transport / 4xx / 5xx failure: `null`. Caller treats `null` as
 *   "preserve the previous cycle's count" rather than clobbering with
 *   `undefined`.
 * - Successful response but missing or malformed `Content-Range`
 *   header: `null` (treat as a complete failure — better to keep the
 *   prior cycle's value than synthesize a fake count).
 *
 * Returns `{ count, isApprox: false }` on success — the exact-count
 * path is, by definition, exact. The `isApprox` field is kept in the
 * shape for API parity with `fetchDRepDelegatorCount`, which still
 * uses a walk-with-cap path for non-predefined DReps.
 */
export async function fetchPredefinedDRepDelegatorCount(
  drepId: string,
): Promise<DRepDelegatorCountResult | null> {
  let res: Response;
  try {
    res = await koiosFetch('/drep_delegators', {
      method: 'POST',
      body: JSON.stringify({ _drep_id: drepId }),
      // Range 0-0 means "give me at most 1 row." Combined with
      // `Prefer: count=exact` Koios returns one delegator (which we
      // discard) plus the full population total in the response header.
      rangeFrom: 0,
      rangeTo: 0,
      headers: { Prefer: 'count=exact' },
      // `count=exact` forces a server-side COUNT(*) over the full
      // delegator set. For `drep_always_abstain` (~181k delegators) that
      // measured ~25s against live Koios — the previous 8s cap timed out
      // and the sync silently preserved a stale count (1000). 30s clears
      // it with margin; only two predefined DReps are fetched per cycle
      // and the directory-sync Lambda has a 300s budget. If Koios ever
      // slows past 30s the caller already falls back to preserving the
      // prior count; `count=estimated` (~8s) is the next lever, at the
      // cost of an approximate value.
      timeoutMs: 30_000,
    });
  } catch (err) {
    console.warn(
      `[Koios /drep_delegators predefined count=exact] fetch failed for ${drepId}:`,
      err,
    );
    return null;
  }
  // PostgREST returns 206 Partial Content (not 200) for any request that
  // includes a Range header — the row(s) returned represent a partial
  // slice. We accept both 200 and 206 as success.
  if (!res.ok && res.status !== 206) {
    console.warn(
      `[Koios /drep_delegators predefined count=exact] HTTP ${res.status} ${res.statusText} for ${drepId}`,
    );
    return null;
  }
  // Body must be drained to release the connection back to the pool —
  // even though we only care about the header, fetch leaves the socket
  // open until the body is consumed or cancelled.
  try {
    await res.body?.cancel();
  } catch {
    // Best-effort drain; ignore any cancellation error.
  }
  const contentRange = res.headers.get('content-range');
  const total = parseContentRangeTotal(contentRange);
  if (total === null) {
    console.warn(
      `[Koios /drep_delegators predefined count=exact] missing/unparseable Content-Range for ${drepId}: ${contentRange ?? '<absent>'}`,
    );
    return null;
  }
  return { count: total, isApprox: false };
}

/**
 * Parse the total row count out of a PostgREST `Content-Range` header.
 *
 * The header shape is `<from>-<to>/<total>` (e.g. `0-0/181308`) when
 * `Prefer: count=exact` is sent. The total can also be `*` when the
 * server declines to count (it won't for us — `count=exact` forces a
 * number) so we treat `*` as failure rather than coerce to NaN.
 *
 * Returns the parsed total, or `null` on any malformed input.
 *
 * Exported for direct testing — the round-trip integration is exercised
 * via `fetchPredefinedDRepDelegatorCount` with a mocked Response, but
 * the parser itself is easier to lock down with a focused unit test.
 */
export function parseContentRangeTotal(header: string | null | undefined): number | null {
  if (!header) return null;
  const slash = header.lastIndexOf('/');
  if (slash < 0) return null;
  const totalStr = header.slice(slash + 1).trim();
  if (totalStr.length === 0 || totalStr === '*') return null;
  // Reject "0.5" / "1e5" style values that parseInt would silently
  // truncate. Insist on an all-digits string for safety.
  if (!/^\d+$/.test(totalStr)) return null;
  const total = Number.parseInt(totalStr, 10);
  if (!Number.isFinite(total) || total < 0) return null;
  return total;
}

/**
 * @deprecated Use `fetchDRepDelegatorCount` instead. Kept temporarily to
 * give callers a soft migration; this function still exists but now
 * returns at most `DREP_DELEGATORS_MAX_PAGES * PAGE_SIZE` rows even when
 * the underlying DRep has more. New code paths should not invoke this.
 *
 * Existing callers used `.length` as the count; they continue to work
 * (with the same truncation caveat) until they're migrated to the count-
 * only helper.
 */
export async function fetchDRepDelegators(
  drepId: string,
): Promise<KoiosDRepDelegator[] | null> {
  const body = JSON.stringify({ _drep_id: drepId });
  const all: KoiosDRepDelegator[] = [];
  for (let page = 0; page < DREP_DELEGATORS_MAX_PAGES; page++) {
    let res: Response;
    try {
      res = await koiosFetch('/drep_delegators', {
        method: 'POST',
        body,
        offset: page * PAGE_SIZE,
        limit: PAGE_SIZE,
        timeoutMs: 8_000,
      });
    } catch (err) {
      if (page === 0) {
        console.warn(`[Koios /drep_delegators] fetch failed for ${drepId}:`, err);
        return null;
      }
      return all;
    }
    if (!res.ok) {
      if (page === 0) {
        console.warn(`[Koios /drep_delegators] HTTP ${res.status} for ${drepId}`);
        return null;
      }
      return all;
    }
    let parsed: unknown;
    try {
      parsed = await readJsonCapped(res, '/drep_delegators');
    } catch (err) {
      if (page === 0) return null;
      return all;
    }
    if (!Array.isArray(parsed)) {
      if (page === 0) return null;
      return all;
    }
    const rows = parsed as KoiosDRepDelegator[];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return all;
}

/**
 * List every currently-active stake pool with its active stake (lovelace).
 *
 * Filter: `pool_status === 'registered'` AND `retiring_epoch === null`.
 * Retiring pools may still have stake delegated but cannot reliably vote
 * on actions enacting after their retirement epoch — using only currently-
 * active pools is the conservative choice.
 *
 * Cached for 30 minutes — pool registrations move slowly. On any error
 * the cache burns and the next call retries fresh.
 */
export async function listActivePools(): Promise<KoiosActivePool[]> {
  const now = Date.now();
  if (_poolCache && now - _poolCache.fetchedAt < POOL_CACHE_TTL_MS) {
    return _poolCache.value;
  }
  let rows: KoiosPool[];
  try {
    rows = await fetchAllPaged<KoiosPool>('/pool_list', '{}', POOL_MAX_PAGES);
  } catch (err) {
    _poolCache = null;
    throw err;
  }
  const active: KoiosActivePool[] = [];
  for (const p of rows) {
    if (p.pool_status !== 'registered') continue;
    if (p.retiring_epoch != null) continue;
    if (typeof p.active_stake !== 'string' || p.active_stake.length === 0) continue;
    active.push({
      pool_id_bech32: p.pool_id_bech32,
      pool_id_hex: p.pool_id_hex,
      ticker: p.ticker,
      active_stake: p.active_stake,
    });
  }
  _poolCache = { fetchedAt: now, value: active };
  return active;
}

/**
 * One row of the `/pool_metadata` response. Returned only for pools that
 * have registered metadata (a `meta_url` on the pool registration cert);
 * pools without metadata are absent from the response. The `meta_json`
 * field is the parsed off-chain CIP-0017 body — typically carries
 * `name`, `ticker`, `homepage`, and `description`.
 *
 * Caller should NOT assume `meta_json` is non-null — Koios returns null
 * when the off-chain metadata is unreachable, returns 404, or fails to
 * parse / validate.
 */
export interface KoiosPoolMetadata {
  pool_id_bech32: string;
  meta_url: string | null;
  meta_hash: string | null;
  /** Parsed off-chain metadata body. Null on fetch/parse failure. */
  meta_json: {
    name?: string;
    ticker?: string;
    homepage?: string;
    description?: string;
    [key: string]: unknown;
  } | null;
}

/**
 * Fetch off-chain metadata for one or more registered pools via
 * `/pool_metadata`. Returns the raw rows; the caller is responsible for
 * extracting whichever body fields it needs. Pools that have no
 * registered metadata (no `meta_url` on their cert) are simply absent
 * from the response — that's a normal answer, not an error.
 *
 * Batched at 50 IDs per request to match the `/drep_info` payload size
 * sweet spot. Per-batch failures log and continue; the caller
 * accumulates whatever succeeded.
 */
export async function fetchPoolMetadata(
  poolIds: readonly string[],
): Promise<KoiosPoolMetadata[]> {
  if (poolIds.length === 0) return [];
  const all: KoiosPoolMetadata[] = [];
  // Use the same batch size as drep_info — well under Koios's empirical
  // payload cap (200 IDs returned 413 in our probe of drep_info; play it
  // safe on pool_metadata too).
  for (let i = 0; i < poolIds.length; i += DREP_INFO_BATCH_SIZE) {
    const batch = poolIds.slice(i, i + DREP_INFO_BATCH_SIZE);
    try {
      const res = await koiosFetch('/pool_metadata', {
        method: 'POST',
        body: JSON.stringify({ _pool_bech32_ids: batch }),
        timeoutMs: 8_000,
      });
      if (!res.ok) {
        console.warn(
          `[Koios /pool_metadata] HTTP ${res.status} ${res.statusText} on batch ${i}-${i + batch.length}; skipping`,
        );
        continue;
      }
      const parsed = (await readJsonCapped(res, '/pool_metadata')) as unknown;
      if (!Array.isArray(parsed)) {
        console.warn('[Koios /pool_metadata] non-array response; skipping batch');
        continue;
      }
      all.push(...(parsed as KoiosPoolMetadata[]));
    } catch (err) {
      console.warn(`[Koios /pool_metadata] batch ${i} failed:`, err);
    }
  }
  return all;
}

/**
 * Fetch the full mainnet `pool_list` (registered + retired). Returns the
 * raw rows — the caller decides how to filter. Used by the pool-metadata
 * sync to enumerate every pool ID before bulk-fetching metadata.
 *
 * Same paginated walk as `listActivePools` but without the active-only
 * filter. Throws `KoiosError` on failure so the sync can abort the
 * cycle cleanly.
 */
export async function listAllPools(): Promise<KoiosPool[]> {
  return fetchAllPaged<KoiosPool>('/pool_list', '{}', POOL_MAX_PAGES);
}

/**
 * Fetch the current Constitutional Committee. Filter to `status ===
 * 'authorized'` — resigned or expired members cannot vote.
 *
 * `committee_info` is a tiny endpoint (~7 active members on mainnet today,
 * total payload < 5KB). One-hour cache is plenty.
 */
export async function getCommitteeMembers(): Promise<KoiosCommitteeMember[]> {
  const now = Date.now();
  if (_committeeCache && now - _committeeCache.fetchedAt < COMMITTEE_CACHE_TTL_MS) {
    return _committeeCache.value;
  }
  const res = await koiosFetch('/committee_info', {
    method: 'POST',
    body: '{}',
    timeoutMs: 8_000,
  });
  if (!res.ok) {
    _committeeCache = null;
    throw new KoiosError(
      '/committee_info',
      `HTTP ${res.status} ${res.statusText}`,
      res.status,
    );
  }
  const parsed = (await readJsonCapped(res, '/committee_info')) as unknown;
  // committee_info returns an array (PostgREST RPC convention) wrapping a
  // single committee object. Sometimes it's the raw object; handle both.
  const obj = Array.isArray(parsed) ? (parsed[0] as unknown) : parsed;
  if (!obj || typeof obj !== 'object') {
    _committeeCache = null;
    throw new KoiosError('/committee_info', 'expected committee object');
  }
  const members = (obj as { members?: unknown }).members;
  if (!Array.isArray(members)) {
    _committeeCache = null;
    throw new KoiosError('/committee_info', 'missing members array');
  }
  const active = (members as KoiosCommitteeMember[]).filter(
    (m) => m.status === 'authorized' && typeof m.cc_hot_id === 'string',
  );
  _committeeCache = { fetchedAt: now, value: active };
  return active;
}
