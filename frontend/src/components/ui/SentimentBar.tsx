import React from 'react';
import { cn } from '@/lib/utils';

interface SentimentBarProps {
  /** Voting power for each slice in lovelace, as stringified BigInt. */
  yes: string;
  no: string;
  abstain: string;
  /** Voting power that hasn't yet voted (i.e. totalActive - cast). */
  notVoted: string;
  /** Render percentage labels above the bar. Default false (compact list use). */
  showLabels?: boolean;
  /** Bar height in px. Design uses 8 in lists, 10 on detail. */
  height?: number;
  className?: string;
}

/** Best-effort BigInt parse — VoteSlice power is always a stringified
 *  integer from the backend, but bad rows shouldn't crash the list. */
function parsePower(s: string): bigint {
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}

/** Percent of the four-slice total, with one decimal of precision in
 *  BigInt math so a 0.3% slice is still rendered (not rounded to zero). */
function pctOf(part: bigint, total: bigint): number {
  if (total <= 0n) return 0;
  const x = (part * 1000n) / total;
  return Number(x) / 10;
}

/**
 * 4-segment horizontal bar — yes / no / abstain / notVoted. Segments are
 * sized by VOTING POWER (lovelace), not voter headcount: Cardano governance
 * thresholds evaluate against total active stake, so showing a 51%-of-power
 * Yes slice is what tells the reader whether ratification is on track.
 *
 * When all four are zero the bar renders empty — this is the "no data yet"
 * state and the caller is expected to gate rendering above this component
 * if it wants to suppress entirely.
 */
export function SentimentBar({
  yes,
  no,
  abstain,
  notVoted,
  showLabels = false,
  height = 8,
  className,
}: SentimentBarProps): React.ReactElement {
  const yesP = parsePower(yes);
  const noP = parsePower(no);
  const absP = parsePower(abstain);
  const nvP = parsePower(notVoted);
  const total = yesP + noP + absP + nvP;
  const yesPct = pctOf(yesP, total);
  const noPct = pctOf(noP, total);
  const absPct = pctOf(absP, total);
  // Use remainder for the last slice so the four labels always sum to
  // exactly 100 — protects against floating-point drift in the chart.
  const nvPct = total > 0n ? Math.max(0, 100 - yesPct - noPct - absPct) : 0;

  return (
    <div className={cn('w-full', className)}>
      {showLabels && (
        <div className="flex items-center gap-3 mb-1.5 text-[12px] tabular-nums">
          <span className="font-semibold text-[var(--success)]">{yesPct.toFixed(1)}%</span>
          <span className="font-semibold text-[var(--danger)]">{noPct.toFixed(1)}%</span>
          <span className="font-semibold text-[var(--text-tertiary)]">
            {absPct.toFixed(1)}%
          </span>
          <span className="font-semibold text-[var(--text-muted)]">
            {nvPct.toFixed(1)}%
          </span>
        </div>
      )}
      <div
        className="w-full overflow-hidden flex bg-[var(--bg-muted)] rounded-token-full"
        style={{ height }}
        role="img"
        aria-label={`Yes ${yesPct.toFixed(1)}%, No ${noPct.toFixed(1)}%, Abstain ${absPct.toFixed(1)}%, Not Voted ${nvPct.toFixed(1)}%`}
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
        {absPct > 0 && (
          <div
            className="h-full bg-[var(--text-tertiary)]"
            style={{ width: `${absPct}%`, transition: 'width 0.4s ease' }}
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
