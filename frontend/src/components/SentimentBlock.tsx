import React from 'react';
import { Check, X, Minus, MoreHorizontal, type LucideIcon } from 'lucide-react';
import { Donut, type DonutSegment } from '@/components/ui/Donut';
import { cn } from '@/lib/utils';
import type { VoteRoleTally, VoteSlice, VoteTally } from '@/types';

interface SentimentBlockProps {
  /** Section title — "On-Chain Votes", "Delegator Sentiment", etc. */
  title: string;
  /** Optional small caption shown after the title (design uses this for
   *  scoped sub-titles like "DRep voting power"). */
  caption?: string;
  tally: VoteTally;
  className?: string;
}

const SUCCESS_COLOR = 'var(--success)';
const DANGER_COLOR = 'var(--danger)';
const ABSTAIN_COLOR = 'var(--text-tertiary)';
/** Neutral gray for the new "Not Voted" slice. Matches the design's muted
 *  ramp; deliberately distinct from the abstain color so a viewer can tell
 *  "they didn't vote" apart from "they voted abstain" at a glance. */
const NOT_VOTED_COLOR = '#9CA3AF';

interface SentimentCardData {
  icon: LucideIcon;
  label: string;
  /** Voter headcount for this slice. */
  count: number;
  /** Voting power for this slice in lovelace, stringified. */
  power: bigint;
  /** Total ACTIVE voting power (denominator for the % of voting power). */
  totalPower: bigint;
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

/** Compact ADA formatter for power values (lovelace -> human-readable).
 *  Uses BigInt internally so the giant DRep / SPO totals don't lose
 *  precision; we then divide once at the boundary to a Number for display. */
function formatLovelaceAda(power: bigint): string {
  if (power <= 0n) return '0 ADA';
  // Convert lovelace -> ADA, keeping enough precision for display.
  // 1 ADA = 1e6 lovelace. We compute integer-millions of ADA and then
  // pick the appropriate suffix.
  const ada = Number(power / 1_000_000n);
  if (ada >= 1_000_000_000) return `${(ada / 1_000_000_000).toFixed(2)}B ADA`;
  if (ada >= 1_000_000) return `${(ada / 1_000_000).toFixed(2)}M ADA`;
  if (ada >= 1_000) return `${(ada / 1_000).toFixed(2)}K ADA`;
  return `${ada} ADA`;
}

/** Best-effort BigInt parse — VoteSlice power is always a stringified
 *  integer from the backend, but we still guard against malformed values
 *  rather than throwing on a single bad row. */
function parseSlicePower(slice: VoteSlice): bigint {
  try {
    return BigInt(slice.power);
  } catch {
    return 0n;
  }
}

/** % of voting power. Returns 0 when total is zero (rather than dividing
 *  by zero). One decimal place keeps small slices visible without making
 *  the headline numbers look fussy. */
function pctOfPower(part: bigint, total: bigint): number {
  if (total <= 0n) return 0;
  // Multiply by 1000 first to keep one decimal of precision in BigInt math.
  const x = (part * 1000n) / total;
  return Number(x) / 10;
}

/** % of headcount, rounded to integer (matches the legacy display). */
function pctOfCount(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}

function SentimentCardTile({ data }: { data: SentimentCardData }): React.ReactElement {
  const { icon: Icon, label, count, power, totalPower, variant } = data;
  const pwrPct = pctOfPower(power, totalPower);
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
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-semibold text-[var(--text-primary)] leading-tight">
          {label}
        </div>
        <div className="text-[11px] text-[var(--text-tertiary)] tabular-nums leading-tight">
          {count.toLocaleString('en-US')}{' '}
          {count === 1 ? 'voter' : 'voters'} · {formatLovelaceAda(power)}
        </div>
      </div>
      <span className="text-[14px] font-bold text-[var(--text-primary)] tabular-nums flex-shrink-0">
        {pwrPct.toFixed(1)}%
      </span>
    </div>
  );
}

/** One row in the per-role breakdown — DRep / SPO / CC. Shows total active
 *  power for that role plus the four slice numbers ("y/n/a/-") so the user
 *  can compare role by role at a glance. */
function RoleRow({
  label,
  role,
}: {
  label: string;
  role: VoteRoleTally;
}): React.ReactElement {
  const totalPower = parseSlicePower(role.totalActive);
  const yesPct = pctOfPower(parseSlicePower(role.yes), totalPower);
  const noPct = pctOfPower(parseSlicePower(role.no), totalPower);
  const abstainPct = pctOfPower(parseSlicePower(role.abstain), totalPower);
  const notVotedPct = pctOfPower(parseSlicePower(role.notVoted), totalPower);
  return (
    <div className="flex items-center justify-between gap-2 py-1 border-b border-[var(--border-subtle)] last:border-b-0">
      <span className="text-[var(--text-secondary)] flex-1 text-[12px]">{label}</span>
      <span
        className="tabular-nums text-[var(--success)] text-[11px] w-12 text-right"
        title={`Yes: ${role.yes.count} voters`}
      >
        {yesPct.toFixed(1)}%y
      </span>
      <span
        className="tabular-nums text-[var(--danger)] text-[11px] w-12 text-right"
        title={`No: ${role.no.count} voters`}
      >
        {noPct.toFixed(1)}%n
      </span>
      <span
        className="tabular-nums text-[var(--text-tertiary)] text-[11px] w-12 text-right"
        title={`Abstain: ${role.abstain.count} voters`}
      >
        {abstainPct.toFixed(1)}%a
      </span>
      <span
        className="tabular-nums text-[var(--text-muted)] text-[11px] w-12 text-right"
        title={`Not Voted: ${role.notVoted.count} eligible`}
      >
        {notVotedPct.toFixed(1)}%-
      </span>
    </div>
  );
}

/**
 * On-Chain Votes block. 3-column grid:
 *   - 4 colored cards (Yes / No / Abstain / Not Voted), stacked
 *   - 140px donut chart sized by VOTING POWER, with center label showing
 *     total active voting power
 *   - Per-role breakdown rows (DRep / SPO / CC), each showing the four
 *     percentages-of-voting-power for that role
 *
 * Cardano governance ratification thresholds (per CIP-1694) are evaluated
 * against TOTAL active voting power, not just power-of-those-who-voted.
 * That's why the denominator everywhere is `totalActive.power` rather than
 * `yes + no + abstain` — the user needs to see "what fraction of the
 * available power has agreed/disagreed" to understand whether a proposal
 * is on track to ratify.
 */
export function SentimentBlock({
  title,
  caption,
  tally,
  className,
}: SentimentBlockProps): React.ReactElement {
  // Aggregate the per-role tallies into top-level slices. Power is summed
  // as BigInt; counts as Number. We treat CC count alongside DRep / SPO
  // counts even though CC has no per-voter power weighting — the
  // headcount is still informative ("4 of 7 CC members voted no").
  const yesCount = tally.drep.yes.count + tally.spo.yes.count + tally.cc.yes.count;
  const noCount = tally.drep.no.count + tally.spo.no.count + tally.cc.no.count;
  const abstainCount =
    tally.drep.abstain.count + tally.spo.abstain.count + tally.cc.abstain.count;
  const notVotedCount =
    tally.drep.notVoted.count + tally.spo.notVoted.count + tally.cc.notVoted.count;

  const yesPower =
    parseSlicePower(tally.drep.yes) +
    parseSlicePower(tally.spo.yes) +
    parseSlicePower(tally.cc.yes);
  const noPower =
    parseSlicePower(tally.drep.no) +
    parseSlicePower(tally.spo.no) +
    parseSlicePower(tally.cc.no);
  const abstainPower =
    parseSlicePower(tally.drep.abstain) +
    parseSlicePower(tally.spo.abstain) +
    parseSlicePower(tally.cc.abstain);
  const notVotedPower =
    parseSlicePower(tally.drep.notVoted) +
    parseSlicePower(tally.spo.notVoted) +
    parseSlicePower(tally.cc.notVoted);
  const totalActivePower =
    parseSlicePower(tally.drep.totalActive) +
    parseSlicePower(tally.spo.totalActive) +
    parseSlicePower(tally.cc.totalActive);
  const totalActiveCount =
    tally.drep.totalActive.count + tally.spo.totalActive.count + tally.cc.totalActive.count;
  const castCount = yesCount + noCount + abstainCount;

  const cards: SentimentCardData[] = [
    {
      icon: Check,
      label: 'Yes',
      count: yesCount,
      power: yesPower,
      totalPower: totalActivePower,
      variant: 'support',
    },
    {
      icon: X,
      label: 'No',
      count: noCount,
      power: noPower,
      totalPower: totalActivePower,
      variant: 'oppose',
    },
    {
      icon: Minus,
      label: 'Abstain',
      count: abstainCount,
      power: abstainPower,
      totalPower: totalActivePower,
      variant: 'abstain',
    },
    {
      icon: MoreHorizontal,
      label: 'Not Voted',
      count: notVotedCount,
      power: notVotedPower,
      totalPower: totalActivePower,
      variant: 'notvoted',
    },
  ];

  // Donut segments are sized by VOTING POWER. The Donut primitive expects
  // `number` values, so we scale the BigInt powers down by 1e6 (lovelace
  // -> ADA) — that brings DRep totals from ~1.5e16 down to ~1.5e10, well
  // inside Number precision and still preserving relative segment sizes.
  // (Even at 1e16 lovelace we're fine for proportional rendering, but
  // dividing first sidesteps any future jitter.)
  const sliceForDonut = (p: bigint): number => Number(p / 1_000_000n);
  const segments: DonutSegment[] = [
    { label: 'Yes', value: sliceForDonut(yesPower), color: SUCCESS_COLOR },
    { label: 'No', value: sliceForDonut(noPower), color: DANGER_COLOR },
    { label: 'Abstain', value: sliceForDonut(abstainPower), color: ABSTAIN_COLOR },
    { label: 'Not Voted', value: sliceForDonut(notVotedPower), color: NOT_VOTED_COLOR },
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
          {castCount.toLocaleString('en-US')} of{' '}
          {totalActiveCount.toLocaleString('en-US')} voted
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
            centerValue={formatLovelaceAda(totalActivePower)}
            centerLabel="active voting power"
          />
        </div>

        <div className="flex flex-col gap-2 text-[13px]">
          <RoleRow label="DRep" role={tally.drep} />
          <RoleRow label="SPO" role={tally.spo} />
          <RoleRow label="Constitutional Committee" role={tally.cc} />
        </div>
      </div>
    </section>
  );
}

// Re-export for callers that want the raw power-percentage helpers.
export {
  pctOfPower as _pctOfPower,
  parseSlicePower as _parseSlicePower,
  formatLovelaceAda as _formatLovelaceAda,
  pctOfCount as _pctOfCount,
};
