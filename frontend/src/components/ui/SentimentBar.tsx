import React from 'react';
import { cn } from '@/lib/utils';

interface SentimentBarProps {
  yes: number;
  no: number;
  abstain: number;
  /** Render percentage labels above the bar. Default false (compact list use). */
  showLabels?: boolean;
  /** Bar height in px. Design uses 8 in lists, 10 on detail. */
  height?: number;
  className?: string;
}

/**
 * 3-segment horizontal bar — yes (success), no (danger), abstain (muted).
 * Mirrors the design `.sentiment-bar` block at `styles.css:985–998` and the
 * `sentiment-cell` row pattern used in governance lists.
 *
 * Accepts raw counts (not pre-normalized percentages). When all three are 0
 * the bar renders empty — this is the "no votes yet" visual state and the
 * caller is expected to gate rendering above this component if it wants
 * to suppress entirely.
 */
export function SentimentBar({
  yes,
  no,
  abstain,
  showLabels = false,
  height = 8,
  className,
}: SentimentBarProps): React.ReactElement {
  const total = Math.max(0, yes) + Math.max(0, no) + Math.max(0, abstain);
  const pct = (n: number): number => (total > 0 ? Math.round((Math.max(0, n) / total) * 100) : 0);
  const yesPct = pct(yes);
  const noPct = pct(no);
  // Use remainder for abstain so the three labels always sum to exactly 100.
  const abstainPct = total > 0 ? Math.max(0, 100 - yesPct - noPct) : 0;

  return (
    <div className={cn('w-full', className)}>
      {showLabels && (
        <div className="flex items-center gap-3 mb-1.5 text-[12px] tabular-nums">
          <span className="font-semibold text-[var(--success)]">{yesPct}%</span>
          <span className="font-semibold text-[var(--danger)]">{noPct}%</span>
          <span className="font-semibold text-[var(--text-tertiary)]">{abstainPct}%</span>
        </div>
      )}
      <div
        className="w-full overflow-hidden flex bg-[var(--bg-muted)] rounded-token-full"
        style={{ height }}
        role="img"
        aria-label={`Yes ${yesPct}%, No ${noPct}%, Abstain ${abstainPct}%`}
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
        {abstainPct > 0 && (
          <div
            className="h-full bg-[var(--text-muted)]"
            style={{ width: `${abstainPct}%`, transition: 'width 0.4s ease' }}
          />
        )}
      </div>
    </div>
  );
}
