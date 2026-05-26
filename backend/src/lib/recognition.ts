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
