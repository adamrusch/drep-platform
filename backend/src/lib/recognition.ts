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
