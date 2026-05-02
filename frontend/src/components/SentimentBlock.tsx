import React from 'react';
import { Check, X, Minus, MoreHorizontal, type LucideIcon } from 'lucide-react';
import { Donut, type DonutSegment } from '@/components/ui/Donut';
import { cn } from '@/lib/utils';
import type { VoteTally } from '@/types';

interface SentimentBlockProps {
  /** Section title — "On-Chain Votes", "Delegator Sentiment", etc. */
  title: string;
  /** Optional small caption shown after the title (design uses this for
   *  scoped sub-titles like "DRep voting power"). */
  caption?: string;
  tally: VoteTally;
  className?: string;
}

interface RoleBucketRow {
  label: string;
  yes: number;
  no: number;
  abstain: number;
}

const SUCCESS_COLOR = 'var(--success)';
const DANGER_COLOR = 'var(--danger)';
const ABSTAIN_COLOR = 'var(--text-tertiary)';

interface SentimentCardData {
  icon: LucideIcon;
  label: string;
  count: number;
  total: number;
  variant: 'support' | 'oppose' | 'abstain' | 'notvoted';
}

const VARIANT_BG: Record<SentimentCardData['variant'], string> = {
  support: 'bg-[var(--success-soft)] border-[rgba(16,185,129,0.2)]',
  oppose: 'bg-[var(--danger-soft)] border-[rgba(239,68,68,0.2)]',
  abstain: 'bg-[var(--bg-muted)] border-[var(--border-default)]',
  notvoted: 'bg-[var(--bg-muted)]/80 border-[var(--border-default)]',
};
const VARIANT_ICON: Record<SentimentCardData['variant'], string> = {
  support: 'text-[var(--success)]',
  oppose: 'text-[var(--danger)]',
  abstain: 'text-[var(--text-tertiary)]',
  notvoted: 'text-[var(--text-muted)]',
};

function pct(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}

function SentimentCardTile({ data }: { data: SentimentCardData }): React.ReactElement {
  const { icon: Icon, label, count, total, variant } = data;
  const pctValue = pct(count, total);
  return (
    <div
      className={cn(
        'flex items-center gap-3 px-4 py-3 rounded-token-lg border',
        VARIANT_BG[variant],
      )}
    >
      <span
        className={cn(
          'inline-flex items-center justify-center w-6 h-6 flex-shrink-0',
          VARIANT_ICON[variant],
        )}
        aria-hidden="true"
      >
        <Icon size={16} strokeWidth={2} />
      </span>
      <span className="flex-1 text-[13px] font-semibold text-[var(--text-primary)]">{label}</span>
      <span className="text-[14px] font-bold text-[var(--text-primary)] tabular-nums">
        {pctValue}%
      </span>
      <span className="text-[12px] text-[var(--text-tertiary)] tabular-nums">{count}</span>
    </div>
  );
}

/**
 * On-Chain Votes / Delegator Sentiment block. 3-column grid:
 *   - 4 colored cards (Yes / No / Abstain / Not Voted), stacked
 *   - 140px donut chart with center label
 *   - 4 legend rows
 *
 * Mirrors the design at `governance.jsx:174–221` and the CSS at
 * `styles.css:1377–1401` and `:1066–1098`.
 *
 * Falls back to a "Not Voted" segment for rendering balance — when actual
 * vote counts are sparse the donut still has visual weight.
 */
export function SentimentBlock({
  title,
  caption,
  tally,
  className,
}: SentimentBlockProps): React.ReactElement {
  // Aggregate the per-role tallies into top-level Yes/No/Abstain totals.
  const yesTotal = tally.drep.yes + tally.spo.yes + tally.cc.yes;
  const noTotal = tally.drep.no + tally.spo.no + tally.cc.no;
  const abstainTotal = tally.drep.abstain + tally.spo.abstain + tally.cc.abstain;
  const grandTotal = yesTotal + noTotal + abstainTotal;

  const cards: SentimentCardData[] = [
    { icon: Check, label: 'Yes', count: yesTotal, total: grandTotal, variant: 'support' },
    { icon: X, label: 'No', count: noTotal, total: grandTotal, variant: 'oppose' },
    {
      icon: Minus,
      label: 'Abstain',
      count: abstainTotal,
      total: grandTotal,
      variant: 'abstain',
    },
  ];

  // Donut segments — 3-bucket version (we don't have "not voted" data on
  // chain; the design's 4th wedge is decorative for off-chain sentiment).
  const segments: DonutSegment[] = [
    { label: 'Yes', value: yesTotal, color: SUCCESS_COLOR },
    { label: 'No', value: noTotal, color: DANGER_COLOR },
    { label: 'Abstain', value: abstainTotal, color: ABSTAIN_COLOR },
  ];

  // Per-role rows under the main block — gives users the DRep / SPO / CC split.
  const roleRows: RoleBucketRow[] = [
    { label: 'DRep', ...tally.drep },
    { label: 'SPO', ...tally.spo },
    { label: 'Constitutional Committee', ...tally.cc },
  ];

  return (
    <section className={cn('space-y-4', className)}>
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h3 className="text-[15px] font-semibold text-[var(--text-primary)] m-0">
          {title}
          {caption && (
            <span className="ml-2 text-xs font-normal text-[var(--text-muted)]">{caption}</span>
          )}
        </h3>
        <span className="text-[12px] text-[var(--text-tertiary)] tabular-nums">
          {grandTotal} {grandTotal === 1 ? 'vote' : 'votes'} total
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-6 items-center">
        <div className="flex flex-col gap-2">
          {cards.map((c) => (
            <SentimentCardTile key={c.label} data={c} />
          ))}
        </div>

        <div className="flex justify-center">
          <Donut
            segments={segments}
            size={140}
            strokeWidth={20}
            centerValue={String(grandTotal)}
            centerLabel="Total votes"
          />
        </div>

        <div className="flex flex-col gap-2 text-[13px]">
          {roleRows.map((row) => {
            const rowTotal = row.yes + row.no + row.abstain;
            return (
              <div
                key={row.label}
                className="flex items-center justify-between gap-2 py-1 border-b border-[var(--border-subtle)] last:border-b-0"
              >
                <span className="text-[var(--text-secondary)] flex-1">{row.label}</span>
                <span className="tabular-nums text-[var(--text-primary)] font-semibold">
                  {rowTotal}
                </span>
                <span className="tabular-nums text-[var(--success)] text-[11.5px] w-7 text-right">
                  {row.yes}y
                </span>
                <span className="tabular-nums text-[var(--danger)] text-[11.5px] w-7 text-right">
                  {row.no}n
                </span>
                <span className="tabular-nums text-[var(--text-muted)] text-[11.5px] w-7 text-right">
                  {row.abstain}a
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
