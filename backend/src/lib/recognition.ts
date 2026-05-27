/**
 * Recognition pills — backend enrichment helpers.
 *
 * The design ships a comment / clubhouse-post header pill stack that
 * surfaces the author's on-chain stake amount and which DRep they
 * delegate to. We populate those two fields best-effort at write time.
 *
 * **Phase C migration (2026-05-17):** Koios `/account_info_cached` is
 * now primary; Blockfrost `accounts/{stake_address}` is the fallback
 * when Koios is unreachable. The two providers source from the same
 * cardano-db-sync database, so the underlying state is identical — only
 * the response field naming differs. Migration cuts steady-state
 * Blockfrost call volume on the comment / clubhouse-post write paths
 * to zero.
 *
 * Errors on BOTH providers are deliberately swallowed — a comment write
 * must not fail because upstream is throttled or down. The pills will
 * simply not render until the next successful write.
 *
 * See: governance.jsx:294-305 + DESIGN_PARITY_VISUAL.md "comment header
 * pill stack" line.
 */
import { getAccountInfo } from './blockfrost';
import { fetchAccountInfo, KoiosError } from './koios';
import { batchGetItems, tableNames } from './dynamodb';

export interface RecognitionInfo {
  /** Pre-formatted ADA stake string ("5.2M ₳") or undefined when the
   *  stake account isn't registered or lookup failed. */
  stakeAda?: string;
  /** DRep id this wallet currently delegates to. We surface the raw
   *  `drep_id` — the frontend can resolve it to a display name later. */
  drep?: string;
}

/** Convert a lovelace string to a compact ADA display string. */
function formatAda(lovelace: string | null | undefined): string | undefined {
  if (!lovelace) return undefined;
  const n = Number(lovelace);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const ada = n / 1_000_000;
  if (ada >= 1_000_000) {
    return `${(ada / 1_000_000).toFixed(1).replace(/\.0$/, '')}M ₳`;
  }
  if (ada >= 1_000) {
    return `${(ada / 1_000).toFixed(1).replace(/\.0$/, '')}K ₳`;
  }
  return `${Math.round(ada).toLocaleString()} ₳`;
}

/**
 * Pull the author's stake amount + DRep delegation. Tries Koios
 * `/account_info_cached` first (no API key, no rate-limit budget impact)
 * and falls back to Blockfrost `accounts/{stake_address}` on KoiosError.
 *
 * Treats every error as a soft miss: the caller must keep going if both
 * upstreams are unavailable. The source-tag in the log line tells the
 * next audit how often Blockfrost was meaningfully reached.
 */
export async function lookupRecognition(stakeAddress: string): Promise<RecognitionInfo> {
  // ---- Koios primary (Phase C) ----
  try {
    const account = await fetchAccountInfo(stakeAddress);
    // null = address not in the Koios cache (unregistered / never-staked).
    // That's a real answer — return empty fields rather than falling back.
    if (account === null) {
      console.log(`lookupRecognition source=koios stake=${stakeAddress} result=not-registered`);
      return {};
    }
    console.log(`lookupRecognition source=koios stake=${stakeAddress}`);
    return {
      stakeAda: formatAda(account.total_balance),
      drep: account.delegated_drep ?? undefined,
    };
  } catch (koiosErr) {
    if (koiosErr instanceof KoiosError) {
      console.warn(
        `lookupRecognition: Koios unavailable (${koiosErr.message}); falling back to Blockfrost`,
      );
    } else {
      console.warn(
        'lookupRecognition: unexpected Koios error; falling back to Blockfrost:',
        koiosErr,
      );
    }
  }

  // ---- Blockfrost fallback ----
  try {
    const account = await getAccountInfo(stakeAddress);
    console.log(`lookupRecognition source=blockfrost-fallback stake=${stakeAddress}`);
    return {
      stakeAda: formatAda(account.controlled_amount),
      drep: account.drep_id ?? undefined,
    };
  } catch (err) {
    // Both providers failed. Soft failure — pills just won't render. Log
    // so we can monitor breakage but don't propagate; the comment write
    // must succeed.
    console.warn('lookupRecognition failed on both providers:', stakeAddress, err);
    return {};
  }
}

// ---- Current-DRep lookup (used by /auth/me and similar live-read paths) ----
//
// The wallet-auth flow stores `drepId` in the JWT at sign-in time, but that
// captures the user's REGISTERED-DRep id (set when they ran the
// `/drep/register` flow) — not the DRep they currently DELEGATE to. The
// "DRep my wallet backs" is an on-chain fact that changes any time the
// user re-delegates and must be re-read live. We use Koios primary +
// Blockfrost fallback (same as `lookupRecognition`) with a short module-
// level cache so a hot `/auth/me` page-load burst doesn't hammer upstream.

/**
 * Result of `lookupCurrentDrep`. `drepId` is `null` when the lookup ran
 * cleanly but the address is unregistered, undelegated, or not a stake
 * address. `undefined` (via the `notDeterminable` variant) means both
 * upstreams failed — caller decides whether to retry or render
 * "unknown" placeholder.
 */
export interface CurrentDrepResult {
  /** `drep_id` bech32 (including `drep_always_abstain` /
   *  `drep_always_no_confidence` predefined IDs) when the address is
   *  registered and delegated; `null` when registered but not delegated
   *  (or not registered at all). */
  drepId: string | null;
  /** Which provider answered. `null` source means both providers errored
   *  — `drepId` will also be `null` in that case but the meaning is
   *  "unknown" rather than "confirmed not delegated". */
  source: 'koios' | 'blockfrost-fallback' | null;
}

interface CurrentDrepCacheEntry {
  fetchedAt: number;
  result: CurrentDrepResult;
}

/** Same TTL as the per-handler caches in `delegationHistory.ts` (60s).
 *  Long enough that bursting reloads of the same profile share one
 *  upstream call, short enough that a new delegation lands in the UI
 *  within ~1 min. */
const CURRENT_DREP_TTL_MS = 60_000;
const CURRENT_DREP_MAX_ENTRIES = 500;
const _currentDrepCache = new Map<string, CurrentDrepCacheEntry>();

/** Test-only escape hatch. Not part of the public API surface. */
export function _resetCurrentDrepCache(): void {
  _currentDrepCache.clear();
}

/**
 * Resolve the DRep this stake address currently delegates to. Koios
 * primary, Blockfrost fallback, cached for 60s per-Lambda-container.
 *
 * Returns:
 *   - `{drepId: '<bech32>', source: 'koios' | 'blockfrost-fallback'}` —
 *     address is delegated; caller should use this `drepId`.
 *   - `{drepId: null, source: 'koios' | 'blockfrost-fallback'}` —
 *     address is NOT delegated (or not registered). This is a confirmed
 *     answer, not an error — render "no DRep" rather than retrying.
 *   - `{drepId: null, source: null}` — both providers failed. Caller
 *     decides between "unknown" placeholder and a retry.
 *
 * If `walletAddress` doesn't start with `stake` (a payment address
 * fallback case from `useWalletAuth` when no reward address is exposed
 * by the wallet), returns `{drepId: null, source: null}` — the upstream
 * `account_info_cached` endpoint only accepts stake addresses.
 */
export async function lookupCurrentDrep(walletAddress: string): Promise<CurrentDrepResult> {
  // Only stake addresses can be looked up against `account_info_cached`.
  // A payment address fallback (`addr1...`) from `useWalletAuth.ts:60` —
  // which happens when the wallet doesn't expose a reward address — has
  // no associated stake key from the on-chain side until a delegation
  // certificate is registered. Return "unknown" without burning an
  // upstream call.
  if (!walletAddress.startsWith('stake')) {
    return { drepId: null, source: null };
  }

  const now = Date.now();
  const cached = _currentDrepCache.get(walletAddress);
  if (cached && now - cached.fetchedAt < CURRENT_DREP_TTL_MS) {
    return cached.result;
  }

  // ---- Koios primary ----
  try {
    const account = await fetchAccountInfo(walletAddress);
    const result: CurrentDrepResult = {
      drepId: account?.delegated_drep ?? null,
      source: 'koios',
    };
    cacheCurrentDrep(walletAddress, now, result);
    return result;
  } catch (koiosErr) {
    if (koiosErr instanceof KoiosError) {
      console.warn(
        `lookupCurrentDrep: Koios unavailable (${koiosErr.message}); falling back to Blockfrost`,
      );
    } else {
      console.warn(
        'lookupCurrentDrep: unexpected Koios error; falling back to Blockfrost:',
        koiosErr,
      );
    }
  }

  // ---- Blockfrost fallback ----
  try {
    const account = await getAccountInfo(walletAddress);
    const result: CurrentDrepResult = {
      drepId: account.drep_id ?? null,
      source: 'blockfrost-fallback',
    };
    cacheCurrentDrep(walletAddress, now, result);
    return result;
  } catch (err) {
    console.warn('lookupCurrentDrep failed on both providers:', walletAddress, err);
    // Do NOT cache the both-providers-failed case — the next request
    // should retry rather than serve a stale "unknown" for 60s.
    return { drepId: null, source: null };
  }
}

function cacheCurrentDrep(key: string, fetchedAt: number, result: CurrentDrepResult): void {
  _currentDrepCache.set(key, { fetchedAt, result });
  if (_currentDrepCache.size > CURRENT_DREP_MAX_ENTRIES) {
    // Map iteration order is insertion order — first key is oldest.
    const oldest = _currentDrepCache.keys().next().value;
    if (oldest !== undefined) _currentDrepCache.delete(oldest);
  }
}

// ---- Live stake lookup (used by the comment-voting / support-level path) ----
//
// Comment up/downvotes are weighted by the voter's current wallet stake in
// lovelace. We snapshot that stake on the vote row at vote time (so the
// support level is reproducible — re-reading wouldn't be), and the
// snapshot needs a fresh on-chain read. Same Koios-primary / Blockfrost-
// fallback pattern as `lookupCurrentDrep`, same 60s LRU, same "do NOT
// cache the both-failed case so a transient outage doesn't pin a user at
// zero stake for a full minute."

/**
 * Result of `lookupStake`. `lovelace` is `null` when the lookup ran cleanly
 * but the address is unregistered / not a stake address; `source: null`
 * means both providers errored and the caller cannot distinguish "unknown"
 * from "confirmed zero." Comment-vote handler treats `source: null` as a
 * hard failure (vote rejected with 503) — we will NOT silently record a
 * zero-weight vote when we have no idea what the real stake is.
 */
export interface StakeLookupResult {
  /** Stake amount in lovelace, stringified BigInt. `null` when registered
   *  but zero / unregistered. */
  lovelace: string | null;
  /** Which provider answered; `null` means both failed. */
  source: 'koios' | 'blockfrost-fallback' | null;
}

interface StakeCacheEntry {
  fetchedAt: number;
  result: StakeLookupResult;
}

const STAKE_TTL_MS = 60_000;
const STAKE_MAX_ENTRIES = 500;
const _stakeCache = new Map<string, StakeCacheEntry>();

/** Test-only escape hatch — same convention as `_resetCurrentDrepCache`. */
export function _resetStakeCache(): void {
  _stakeCache.clear();
}

/**
 * Evict the in-Lambda LRU entries for `stakeAddress` from BOTH
 * `lookupCurrentDrep` and `lookupStake`. Called from `/auth/verify`
 * (on successful sign-in) and `/auth/session DELETE` (on logout) so a
 * user who re-delegated immediately before authenticating doesn't see
 * the OLD DRep's clubhouse routing for up to 60s (the cache TTL).
 *
 * # Per-container scope (NOT global)
 *
 * The caches are PER-LAMBDA-CONTAINER. This invalidation runs in
 * whatever container served the auth request and clears its local LRU.
 * Other containers serving the same stake address through their own
 * concurrent handlers will keep the stale entry until their own 60s
 * TTL expires — exactly the same staleness window as before this
 * helper existed.
 *
 * # Why we accept the per-container limitation
 *
 * The fix here is "first hit after login routes to the right DRep,"
 * not "all hits cluster-wide route correctly within 1 second." A
 * cluster-wide invalidation would require a Redis-like distributed
 * cache, which is overkill for a 60s consistency window — the
 * pre-existing TTL already bounds the worst case at 60s, and this
 * helper improves the typical case (single container, single user)
 * to ~0s. The other containers' staleness was ALREADY part of the
 * design contract.
 *
 * # Idempotency
 *
 * Safe to call when the cache is empty (Map.delete on a missing key
 * is a no-op). Safe to call repeatedly. Returns nothing — the caller
 * doesn't need to know whether an entry was evicted.
 */
export function _invalidateForStake(stakeAddress: string): void {
  _currentDrepCache.delete(stakeAddress);
  _stakeCache.delete(stakeAddress);
}

/**
 * Resolve the current lovelace stake controlled by this stake address.
 * Koios `/account_info_cached` `total_balance` is primary; Blockfrost
 * `/accounts/{stake_addr}` `controlled_amount` is the fallback.
 *
 * Same 60s LRU as `lookupCurrentDrep`. Payment-address fallback
 * (`addr1...`) short-circuits because the upstream endpoints don't
 * accept payment addresses — caller will see `source: null` and should
 * surface "could not determine stake" to the user.
 */
export async function lookupStake(stakeAddress: string): Promise<StakeLookupResult> {
  if (!stakeAddress.startsWith('stake')) {
    return { lovelace: null, source: null };
  }

  const now = Date.now();
  const cached = _stakeCache.get(stakeAddress);
  if (cached && now - cached.fetchedAt < STAKE_TTL_MS) {
    return cached.result;
  }

  // ---- Koios primary ----
  try {
    const account = await fetchAccountInfo(stakeAddress);
    const result: StakeLookupResult = {
      lovelace: account?.total_balance ?? null,
      source: 'koios',
    };
    cacheStake(stakeAddress, now, result);
    return result;
  } catch (koiosErr) {
    if (koiosErr instanceof KoiosError) {
      console.warn(
        `lookupStake: Koios unavailable (${koiosErr.message}); falling back to Blockfrost`,
      );
    } else {
      console.warn('lookupStake: unexpected Koios error; falling back to Blockfrost:', koiosErr);
    }
  }

  // ---- Blockfrost fallback ----
  try {
    const account = await getAccountInfo(stakeAddress);
    const result: StakeLookupResult = {
      lovelace: account.controlled_amount ?? null,
      source: 'blockfrost-fallback',
    };
    cacheStake(stakeAddress, now, result);
    return result;
  } catch (err) {
    console.warn('lookupStake failed on both providers:', stakeAddress, err);
    // Do NOT cache the both-providers-failed case.
    return { lovelace: null, source: null };
  }
}

function cacheStake(key: string, fetchedAt: number, result: StakeLookupResult): void {
  _stakeCache.set(key, { fetchedAt, result });
  if (_stakeCache.size > STAKE_MAX_ENTRIES) {
    const oldest = _stakeCache.keys().next().value;
    if (oldest !== undefined) _stakeCache.delete(oldest);
  }
}

// ---- Pool name lookup (Votes-tab SPO display) ----
//
// SPO voter rows on the per-action Votes tab show the pool's registered
// ticker + name when available, falling back to truncated bech32. The
// data lives in the `pool_metadata` DDB cache, refreshed daily by
// `sync/pool-metadata.ts`. We cache lookups in-Lambda for 60s so a
// burst of requests for the same action's votes shares one DDB read.

/** Subset of `PoolMetadataItem` the read path needs. */
export interface PoolNameResult {
  ticker?: string;
  name?: string;
}

interface PoolNameCacheEntry {
  fetchedAt: number;
  result: PoolNameResult;
}

/** 60-second in-Lambda cache, mirroring the existing
 *  `_currentDrepCache` pattern. The daily pool-metadata sync is the
 *  canonical source; a 60s LRU absorbs hot-path bursts without
 *  serving meaningfully stale data. */
const POOL_NAME_TTL_MS = 60_000;
const POOL_NAME_MAX_ENTRIES = 1000;
const _poolNameCache = new Map<string, PoolNameCacheEntry>();

/** Test-only escape hatch. */
export function _resetPoolNameCache(): void {
  _poolNameCache.clear();
}

/**
 * Resolve human-readable identifiers for one pool. Returns an empty
 * object when the pool isn't in the cache (read failure or pool with
 * no registered metadata). Caller is responsible for rendering a
 * sensible fallback (truncated bech32).
 *
 * Cached for 60s per (Lambda container, poolId) — a burst of votes
 * tab loads for the same action shares one DDB read.
 */
export async function getPoolName(poolId: string): Promise<PoolNameResult> {
  const now = Date.now();
  const cached = _poolNameCache.get(poolId);
  if (cached && now - cached.fetchedAt < POOL_NAME_TTL_MS) {
    return cached.result;
  }
  try {
    const items = await batchGetItems<{
      poolId: string;
      ticker?: string;
      name?: string;
    }>(tableNames.poolMetadata, [{ poolId }]);
    const row = items[0];
    const result: PoolNameResult = {};
    if (row?.ticker) result.ticker = row.ticker;
    if (row?.name) result.name = row.name;
    cachePoolName(poolId, now, result);
    return result;
  } catch (err) {
    console.warn(`getPoolName: cache lookup failed for ${poolId}:`, err);
    // Do NOT cache the error case — let the next request retry rather
    // than serve a stale empty result for 60s.
    return {};
  }
}

/**
 * Bulk variant — resolve names for many pools in one BatchGet. Used by
 * `lib/votes.ts` to enrich SPO vote rows in a single round-trip per
 * page of votes. Returns a Map keyed by `poolId`; pools with no
 * registered metadata land in the map with an empty value so callers
 * can distinguish "missing from cache" from "cache lookup failed".
 *
 * Honors the 60s in-Lambda cache for already-seen pools — only the
 * uncached subset hits DDB. The `batchGetItems` helper internally
 * chunks at the 100-key BatchGet cap.
 */
export async function getPoolNamesBulk(
  poolIds: readonly string[],
): Promise<Map<string, PoolNameResult>> {
  const out = new Map<string, PoolNameResult>();
  if (poolIds.length === 0) return out;
  const now = Date.now();
  const toFetch: string[] = [];
  for (const id of poolIds) {
    const cached = _poolNameCache.get(id);
    if (cached && now - cached.fetchedAt < POOL_NAME_TTL_MS) {
      out.set(id, cached.result);
    } else {
      toFetch.push(id);
    }
  }
  if (toFetch.length === 0) return out;
  try {
    const items = await batchGetItems<{
      poolId: string;
      ticker?: string;
      name?: string;
    }>(
      tableNames.poolMetadata,
      toFetch.map((poolId) => ({ poolId })),
    );
    const foundByPool = new Map<string, { ticker?: string; name?: string }>(
      items.map((it) => [it.poolId, it]),
    );
    for (const id of toFetch) {
      const row = foundByPool.get(id);
      const result: PoolNameResult = {};
      if (row?.ticker) result.ticker = row.ticker;
      if (row?.name) result.name = row.name;
      cachePoolName(id, now, result);
      out.set(id, result);
    }
  } catch (err) {
    console.warn('getPoolNamesBulk: cache lookup failed:', err);
    // Pool IDs we didn't manage to fetch get an empty record so the
    // caller's iteration order isn't disrupted.
    for (const id of toFetch) {
      if (!out.has(id)) out.set(id, {});
    }
  }
  return out;
}

function cachePoolName(key: string, fetchedAt: number, result: PoolNameResult): void {
  _poolNameCache.set(key, { fetchedAt, result });
  if (_poolNameCache.size > POOL_NAME_MAX_ENTRIES) {
    const oldest = _poolNameCache.keys().next().value;
    if (oldest !== undefined) _poolNameCache.delete(oldest);
  }
}

// ---- CC member name lookup (Votes-tab CC display) ----
//
// Constitutional Committee voters surface as bech32 `cc_hot...` strings.
// The `cc_members` DDB cache (populated per-epoch by
// `sync/cc-members.ts`) lets us join those to a display name when one
// is registered. Today Koios doesn't surface CC names so this almost
// always resolves to undefined — the frontend then falls back to
// "CC Member ({hotCred truncated})". Schema is forward-compatible for
// the future UpdateCommittee anchor walk.

interface CCNameCacheEntry {
  fetchedAt: number;
  result: string | undefined;
}

/** 60s LRU, same as the pool cache. CC membership only changes at
 *  epoch boundaries (~every 5 days on mainnet), so the in-Lambda
 *  cache could be even longer, but 60s keeps the pattern uniform
 *  with the rest of `recognition.ts`. */
const CC_NAME_TTL_MS = 60_000;
const CC_NAME_MAX_ENTRIES = 100;
const _ccNameCache = new Map<string, CCNameCacheEntry>();

/** Test-only escape hatch. */
export function _resetCCNameCache(): void {
  _ccNameCache.clear();
}

/**
 * Resolve a CC member's display name. Returns `undefined` when the
 * member isn't in the cache OR when they're in the cache but have no
 * `ccName` (the normal case today — Koios `/committee_info` doesn't
 * expose names). Caller renders "CC Member ({hotCred truncated})" as
 * a fallback.
 *
 * The reserved cache PK `META` is filtered out — that row is the
 * epoch-skip cursor, never a real CC member.
 */
export async function getCCMemberName(hotCred: string): Promise<string | undefined> {
  if (hotCred === 'META') return undefined; // defensive: never look up the cursor row
  const now = Date.now();
  const cached = _ccNameCache.get(hotCred);
  if (cached && now - cached.fetchedAt < CC_NAME_TTL_MS) {
    return cached.result;
  }
  try {
    const items = await batchGetItems<{ ccHotCred: string; ccName?: string }>(
      tableNames.ccMembers,
      [{ ccHotCred: hotCred }],
    );
    const row = items[0];
    const name = row?.ccName && row.ccName.length > 0 ? row.ccName : undefined;
    cacheCCName(hotCred, now, name);
    return name;
  } catch (err) {
    console.warn(`getCCMemberName: cache lookup failed for ${hotCred}:`, err);
    return undefined;
  }
}

/**
 * Bulk variant — resolve names for many CC members in one BatchGet.
 * Returns a Map keyed by `ccHotCred` containing only entries that
 * resolved to a non-empty name; absent entries mean "no name on file"
 * which the caller treats as fallback-to-truncated-bech32.
 *
 * CC membership is tiny (~7 members on mainnet today) so this is one
 * DDB call total. Honors the 60s in-Lambda cache.
 */
export async function getCCMemberNamesBulk(
  hotCreds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (hotCreds.length === 0) return out;
  const now = Date.now();
  const toFetch: string[] = [];
  for (const hc of hotCreds) {
    if (hc === 'META') continue;
    const cached = _ccNameCache.get(hc);
    if (cached && now - cached.fetchedAt < CC_NAME_TTL_MS) {
      if (cached.result) out.set(hc, cached.result);
    } else {
      toFetch.push(hc);
    }
  }
  if (toFetch.length === 0) return out;
  try {
    const items = await batchGetItems<{ ccHotCred: string; ccName?: string }>(
      tableNames.ccMembers,
      toFetch.map((ccHotCred) => ({ ccHotCred })),
    );
    const found = new Map<string, string | undefined>(
      items.map((it) => [it.ccHotCred, it.ccName]),
    );
    for (const hc of toFetch) {
      const name = found.get(hc);
      const resolved = name && name.length > 0 ? name : undefined;
      cacheCCName(hc, now, resolved);
      if (resolved) out.set(hc, resolved);
    }
  } catch (err) {
    console.warn('getCCMemberNamesBulk: cache lookup failed:', err);
  }
  return out;
}

function cacheCCName(key: string, fetchedAt: number, result: string | undefined): void {
  _ccNameCache.set(key, { fetchedAt, result });
  if (_ccNameCache.size > CC_NAME_MAX_ENTRIES) {
    const oldest = _ccNameCache.keys().next().value;
    if (oldest !== undefined) _ccNameCache.delete(oldest);
  }
}
