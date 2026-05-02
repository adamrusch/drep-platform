/**
 * Recognition pills — backend enrichment helpers.
 *
 * The design ships a comment / clubhouse-post header pill stack that
 * surfaces the author's on-chain stake amount and which DRep they
 * delegate to. We populate those two fields best-effort at write time
 * via Blockfrost's `accounts/{stake_address}` endpoint.
 *
 * Errors are deliberately swallowed — a comment write must not fail
 * because Blockfrost is throttled or down. The pills will simply not
 * render until the next successful write.
 *
 * See: governance.jsx:294-305 + DESIGN_PARITY_VISUAL.md "comment header
 * pill stack" line.
 */
import { getAccountInfo } from './blockfrost';

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
 * Pull the author's stake amount + DRep delegation from Blockfrost.
 * Treats every error as a soft miss: the caller must keep going if
 * Blockfrost is unavailable.
 */
export async function lookupRecognition(stakeAddress: string): Promise<RecognitionInfo> {
  try {
    const account = await getAccountInfo(stakeAddress);
    return {
      stakeAda: formatAda(account.controlled_amount),
      drep: account.drep_id ?? undefined,
    };
  } catch (err) {
    // Soft failure — pills just won't render. Log so we can monitor
    // breakage but don't propagate.
    console.warn('lookupRecognition failed:', stakeAddress, err);
    return {};
  }
}
