import React from 'react';
import { cn } from '@/lib/utils';

interface SentimentBarProps {
  /** Voting power for each ratification slice in lovelace, stringified BigInt. */
  yes: string;
  no: string;
  /** Voting power that hasn't yet voted (totalActive - yes - no). */
  notVoted: string;
  /** Total active voting stake (the ratification denominator) in lovelace
   *  as stringified BigInt. The bar segments are sized as fractions of
   *  this. When zero, renders an empty muted track. */
  totalActive: string;
  /** Abstain power in lovelace, stringified BigInt. Accepted for API
   *  symmetry with prior callers but no longer surfaced visually — the
   *  v9 governance UI hides explicit-abstain stake from the compact bar
   *  for consistency with the detail-page treatment, where auto-abstain
   *  was hidden entirely and explicit abstain lives in a footnote below
   *  the donut. Keeping the prop avoids touching every call site. */
  abstain?: string;
  /** Render percentage labels above the bar. Default false (compact list use). */
  showLabels?: boolean;
  /** Bar height in px. Design uses 8 in lists, 10 on detail. */
  height?: number;
  className?: string;
}

/** Best-effort BigInt parse — VoteSlice power is always a stringified
 *  integer from the backend, but bad rows shouldn't crash the list. */
function parsePower(s: string | undefined): bigint {
  if (!s) return 0n;
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}

/** Percent of total, with one decimal of precision in BigInt math so a
 *  0.3% slice is still rendered (not rounded to zero). */
function pctOf(part: bigint, total: bigint): number {
  if (total <= 0n) return 0;
  const x = (part * 1000n) / total;
  return Number(x) / 10;
}

/**
 * 3-segment horizontal bar — Yes / No / Not Voted. Segments are sized as
 * fractions of `totalActive` (the CIP-1694 ratification denominator), so
 * the three widths sum to 100%. Abstain is intentionally NOT a segment:
 * per CIP-1694, abstain stake is excluded from active voting stake. We
 * surface it in the tooltip / aria-label so the data is still visible
 * without distorting the ratification picture.
 *
 * When totalActive is zero the bar renders empty — this is the "no data
 * yet" state; the caller is expected to gate rendering above this
 * component if it wants to suppress entirely.
 */
export function SentimentBar({
  yes,
  no,
  notVoted,
  totalActive,
  // `abstain` accepted but ignored visually — see prop docstring.
  abstain: _abstain,
  showLabels = false,
  height = 8,
  className,
}: SentimentBarProps): React.ReactElement {
  const yesP = parsePower(yes);
  const noP = parsePower(no);
  const totalP = parsePower(totalActive);
  // `notVoted` is the residual of totalActive after yes+no; we recompute
  // it as a percentage rather than parsing the prop, so the three labels
  // always sum to exactly 100% even if the upstream rounding drifts.
  void notVoted;

  const yesPct = pctOf(yesP, totalP);
  const noPct = pctOf(noP, totalP);
  const nvPct = totalP > 0n ? Math.max(0, 100 - yesPct - noPct) : 0;

  const ariaLabel = `Yes ${yesPct.toFixed(1)}%, No ${noPct.toFixed(1)}%, Not Voted ${nvPct.toFixed(1)}% of Active Governance Stake.`;
  const tooltipText = `Yes ${yesPct.toFixed(1)}% / No ${noPct.toFixed(1)}% / Not Voted ${nvPct.toFixed(1)}% of Active Governance Stake.`;

  return (
    <div className={cn('w-full', className)} title={tooltipText}>
      {showLabels && (
        <div className="flex items-center gap-3 mb-1.5 text-[12px] tabular-nums">
          <span className="font-semibold text-[var(--success)]">{yesPct.toFixed(1)}%</span>
          <span className="font-semibold text-[var(--danger)]">{noPct.toFixed(1)}%</span>
          <span className="font-semibold text-[var(--text-muted)]">
            {nvPct.toFixed(1)}%
          </span>
        </div>
      )}
      <div
        className="w-full overflow-hidden flex bg-[var(--bg-muted)] rounded-token-full"
        style={{ height }}
        role="img"
        aria-label={ariaLabel}
      >
        {yesPct > 0 && (
          <div
            className="h-full bg-[var(--success)]"
            style={{ width: `${yesPct}%`, transition: 'width 0.4s ease' }}
          />
        )}
        {noPct > 0 && (
          <div
            className="h-full bg-[var(--danger)]"
            style={{ width: `${noPct}%`, transition: 'width 0.4s ease' }}
          />
        )}
        {nvPct > 0 && (
          <div
            className="h-full"
            style={{
              width: `${nvPct}%`,
              transition: 'width 0.4s ease',
              backgroundColor: '#9CA3AF',
            }}
          />
        )}
      </div>
    </div>
  );
}
