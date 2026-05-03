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

/**
 * Fetch the list of stake addresses delegated to this DRep. Returns null
 * on any failure. The detail handler uses the length of this array as
 * the delegator count — full account list is overkill but Koios's only
 * paid-tier-free endpoint here doesn't expose a count-only variant.
 *
 * For DReps with thousands of delegators this can be a few KB — well
 * under the 10MB cap.
 */
export async function fetchDRepDelegators(
  drepId: string,
): Promise<KoiosDRepDelegator[] | null> {
  try {
    const res = await koiosFetch('/drep_delegators', {
      method: 'POST',
      body: JSON.stringify({ _drep_id: drepId }),
      timeoutMs: 8_000,
    });
    if (!res.ok) {
      console.warn(`[Koios /drep_delegators] HTTP ${res.status} for ${drepId}`);
      return null;
    }
    const parsed = (await readJsonCapped(res, '/drep_delegators')) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed as KoiosDRepDelegator[];
  } catch (err) {
    console.warn(`[Koios /drep_delegators] fetch failed for ${drepId}:`, err);
    return null;
  }
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
