import React from 'react';
import { Check, X, MoreHorizontal, Minus } from 'lucide-react';
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
/** Neutral gray for "Not Voted". Distinct from abstain so a viewer can tell
 *  "they didn't vote" apart from "they voted abstain" at a glance. */
const NOT_VOTED_COLOR = '#9CA3AF';

/** Compact ADA formatter. Lovelace -> human-readable. BigInt internal so
 *  giant DRep totals don't lose precision; divide at the boundary. */
function formatLovelaceAda(power: bigint): string {
  if (power <= 0n) return '0 ADA';
  const ada = Number(power / 1_000_000n);
  if (ada >= 1_000_000_000) return `${(ada / 1_000_000_000).toFixed(2)}B ADA`;
  if (ada >= 1_000_000) return `${(ada / 1_000_000).toFixed(2)}M ADA`;
  if (ada >= 1_000) return `${(ada / 1_000).toFixed(2)}K ADA`;
  return `${ada} ADA`;
}

/** Best-effort BigInt parse — VoteSlice power is always a stringified
 *  integer from the backend, but we still guard against malformed values. */
function parseSlicePower(slice: VoteSlice | undefined): bigint {
  if (!slice) return 0n;
  try {
    return BigInt(slice.power);
  } catch {
    return 0n;
  }
}

function parseStrPower(s: string | undefined): bigint {
  if (!s) return 0n;
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}

/** % of a BigInt total. Returns 0 when total is zero. One decimal place. */
function pctOfPower(part: bigint, total: bigint): number {
  if (total <= 0n) return 0;
  // Multiply by 1000 first to keep one decimal of precision in BigInt math.
  const x = (part * 1000n) / total;
  return Number(x) / 10;
}

/** Headcount label. Singular when count == 1 ("1 voter") for a tiny dignity
 *  bump on early-voting actions. */
function voterLabel(role: 'drep' | 'spo' | 'cc', count: number): string {
  if (role === 'cc') return count === 1 ? '1 member' : `${count.toLocaleString('en-US')} members`;
  if (role === 'spo') return count === 1 ? '1 SPO' : `${count.toLocaleString('en-US')} SPOs`;
  return count === 1 ? '1 DRep' : `${count.toLocaleString('en-US')} DReps`;
}

function totalLabel(role: 'drep' | 'spo' | 'cc'): string {
  if (role === 'cc') return 'committee members';
  if (role === 'spo') return 'active SPOs';
  return 'active DReps';
}

/** Per-role 3-slice donut + breakdown + abstain footnote. The center of
 *  the donut shows total active voting power; below the donut, three rows
 *  show Yes / No / Not Voted with counts, ADA, and percentages summing to
 *  100% of `totalActive`. The Abstain row is rendered as a divider-
 *  separated footnote with explanatory copy — it is NOT a 4th slice. */
function RoleSection({
  label,
  role,
  roleKey,
}: {
  label: string;
  role: VoteRoleTally;
  roleKey: 'drep' | 'spo' | 'cc';
}): React.ReactElement {
  const isCount = roleKey === 'cc';
  const yesPower = parseSlicePower(role.yes);
  const noPower = parseSlicePower(role.no);
  const notVotedPower = parseSlicePower(role.notVoted);
  const abstainPower = parseSlicePower(role.abstain);
  const totalActivePower = parseSlicePower(role.totalActive);
  const autoAbstainPower = parseStrPower(role.autoAbstainPower);
  const autoNoConfPower = parseStrPower(role.autoNoConfidencePower);

  // Percentages — 3 ratification slices over totalActive.
  const yesPct = pctOfPower(yesPower, totalActivePower);
  const noPct = pctOfPower(noPower, totalActivePower);
  // Use the residual for `notVoted` so the three slices always sum to 100
  // when the backend identity holds — protects against display-side
  // floating-point drift where 33.3 + 33.3 + 33.3 = 99.9.
  const notVotedPct =
    totalActivePower > 0n ? Math.max(0, 100 - yesPct - noPct) : 0;

  // Donut segments are sized by power. We scale BigInt down by 1e6
  // (lovelace -> ADA) before handing to the SVG primitive, which expects
  // Number. Even at 1e16 lovelace this is safe; dividing first sidesteps
  // any future precision jitter.
  const sliceForDonut = (p: bigint): number =>
    isCount ? Number(p) : Number(p / 1_000_000n);

  const segments: DonutSegment[] = [
    { label: 'Yes', value: sliceForDonut(yesPower), color: SUCCESS_COLOR },
    { label: 'No', value: sliceForDonut(noPower), color: DANGER_COLOR },
    {
      label: 'Not Voted',
      value: sliceForDonut(notVotedPower),
      color: NOT_VOTED_COLOR,
    },
  ];

  const centerValue = isCount
    ? `${role.totalActive.count}`
    : formatLovelaceAda(totalActivePower);
  const centerLabel = isCount ? 'CC members' : 'active stake';

  // Abstain percentage is informational only. Per CIP-1694 abstain stake
  // is excluded from active voting stake, so we express it against the
  // larger denominator (totalActive + auto-abstain) so the "% of registered
  // DRep stake" framing is honest. For roles where totalRegistered ==
  // totalActive (SPO, CC), we just show abstain / totalRegistered.
  const totalRegisteredPower = parseSlicePower(role.totalRegistered);
  const abstainPctRegistered = pctOfPower(abstainPower, totalRegisteredPower);

  return (
    <section className="space-y-3">
      <header className="flex items-baseline justify-between gap-3 flex-wrap">
        <h4 className="text-[14px] font-semibold text-[var(--text-primary)] m-0">
          {label}
        </h4>
        <span className="text-[11.5px] text-[var(--text-tertiary)] tabular-nums">
          {voterLabel(roleKey, role.totalActive.count)} {totalLabel(roleKey)}
        </span>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-[auto_1fr] gap-5 items-center">
        {/* Donut */}
        <div className="flex justify-center md:justify-start">
          <Donut
            segments={segments}
            size={140}
            strokeWidth={20}
            centerValue={centerValue}
            centerLabel={centerLabel}
          />
        </div>

        {/* 3-row breakdown */}
        <div className="space-y-2">
          <BreakdownRow
            icon={<Check size={14} strokeWidth={2.25} />}
            iconClass="text-[var(--success)]"
            label="Yes"
            count={role.yes.count}
            secondaryLabel={isCount ? '' : formatLovelaceAda(yesPower)}
            pct={yesPct}
            roleKey={roleKey}
          />
          <BreakdownRow
            icon={<X size={14} strokeWidth={2.25} />}
            iconClass="text-[var(--danger)]"
            label="No"
            count={role.no.count}
            secondaryLabel={isCount ? '' : formatLovelaceAda(noPower)}
            pct={noPct}
            roleKey={roleKey}
          />
          <BreakdownRow
            icon={<MoreHorizontal size={14} strokeWidth={2.25} />}
            iconClass="text-[var(--text-muted)]"
            label="Not Voted"
            count={role.notVoted.count}
            secondaryLabel={isCount ? '' : formatLovelaceAda(notVotedPower)}
            pct={notVotedPct}
            roleKey={roleKey}
          />

          {/* Abstain footnote — sits OUTSIDE the ratification denominator. */}
          {(abstainPower > 0n || role.abstain.count > 0) && (
            <div className="pt-2 mt-2 border-t border-[var(--border-subtle)] space-y-1">
              <div className="flex items-center gap-2 text-[12px] text-[var(--text-tertiary)]">
                <Minus
                  size={14}
                  strokeWidth={2.25}
                  className="text-[var(--text-muted)] flex-shrink-0"
                  aria-hidden="true"
                />
                <span className="font-semibold">Abstain</span>
                <span className="tabular-nums">
                  {role.abstain.count > 0
                    ? `${role.abstain.count.toLocaleString('en-US')} ${
                        role.abstain.count === 1 ? 'voter' : 'voters'
                      }`
                    : ''}
                </span>
                {!isCount && (
                  <span className="tabular-nums text-[var(--text-muted)]">
                    · {formatLovelaceAda(abstainPower)}
                  </span>
                )}
                {abstainPctRegistered > 0 && !isCount && (
                  <span className="tabular-nums text-[var(--text-muted)]">
                    · {abstainPctRegistered.toFixed(1)}% of registered
                  </span>
                )}
              </div>
              <div className="text-[11px] text-[var(--text-muted)] leading-snug pl-6">
                Delegated to abstain — not in ratification denominator.
              </div>
              {roleKey === 'drep' && autoAbstainPower > 0n && (
                <div className="text-[11px] text-[var(--text-muted)] leading-snug pl-6 tabular-nums">
                  └ of which auto-abstain (drep_always_abstain):{' '}
                  {formatLovelaceAda(autoAbstainPower)}
                </div>
              )}
              {roleKey === 'drep' && autoNoConfPower > 0n && (
                <div className="text-[11px] text-[var(--text-muted)] leading-snug pl-6 tabular-nums">
                  Note: auto-no-confidence ({formatLovelaceAda(autoNoConfPower)})
                  is included in {label === 'DRep' ? '' : 'DRep '}
                  active stake and counts as{' '}
                  {/* The action-type-dependent direction is rendered by the
                      parent context — the auto-no-confidence stake is in
                      Yes for NoConfidence actions, otherwise in No. */}
                  Yes/No based on action type.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

interface BreakdownRowProps {
  icon: React.ReactNode;
  iconClass: string;
  label: string;
  count: number;
  secondaryLabel: string;
  pct: number;
  roleKey: 'drep' | 'spo' | 'cc';
}

function BreakdownRow({
  icon,
  iconClass,
  label,
  count,
  secondaryLabel,
  pct,
  roleKey,
}: BreakdownRowProps): React.ReactElement {
  const unit = roleKey === 'cc' ? 'member' : 'voter';
  const unitPlural = roleKey === 'cc' ? 'members' : 'voters';
  return (
    <div className="flex items-center gap-2 text-[13px]">
      <span
        className={cn('inline-flex items-center justify-center flex-shrink-0', iconClass)}
        aria-hidden="true"
      >
        {icon}
      </span>
      <span className="font-semibold text-[var(--text-primary)] w-20 flex-shrink-0">
        {label}
      </span>
      <span className="text-[12px] text-[var(--text-tertiary)] tabular-nums w-24 flex-shrink-0">
        {count.toLocaleString('en-US')} {count === 1 ? unit : unitPlural}
      </span>
      {secondaryLabel && (
        <span className="text-[12px] text-[var(--text-tertiary)] tabular-nums flex-1">
          {secondaryLabel}
        </span>
      )}
      <span className="font-bold text-[var(--text-primary)] tabular-nums w-14 text-right flex-shrink-0">
        {pct.toFixed(1)}%
      </span>
    </div>
  );
}

/**
 * On-Chain Votes block. One section per role (DRep / SPO / Constitutional
 * Committee). Each section renders a 3-slice donut (Yes / No / Not Voted)
 * sized by voting power, summing to 100% of that role's total ACTIVE
 * voting stake — the CIP-1694 ratification denominator. Abstain is
 * surfaced as a footnote BELOW the breakdown, deliberately separated
 * because per CIP-1694 abstain stake is "actively marked as not
 * participating in governance" and therefore excluded from the
 * ratification math.
 *
 * Why per-role sections (not aggregated): governance ratification rules
 * differ per role (DRep vs SPO vs CC have different thresholds), and
 * mixing power-units (lovelace) with headcount (CC has 1 vote per member)
 * into a single donut is misleading. Each role gets its own ratification
 * picture.
 */
export function SentimentBlock({
  title,
  caption,
  tally,
  className,
}: SentimentBlockProps): React.ReactElement {
  return (
    <section className={cn('space-y-6', className)}>
      <header className="flex items-baseline justify-between gap-3 flex-wrap">
        <h3 className="text-[15px] font-semibold text-[var(--text-primary)] m-0">
          {title}
          {caption && (
            <span className="ml-2 text-xs font-normal text-[var(--text-muted)]">{caption}</span>
          )}
        </h3>
        <span className="text-[11.5px] text-[var(--text-muted)]">
          % of active voting stake (CIP-1694)
        </span>
      </header>

      <RoleSection label="DRep" roleKey="drep" role={tally.drep} />
      <div className="border-t border-[var(--border-subtle)]" />
      <RoleSection label="SPO" roleKey="spo" role={tally.spo} />
      <div className="border-t border-[var(--border-subtle)]" />
      <RoleSection
        label="Constitutional Committee"
        roleKey="cc"
        role={tally.cc}
      />
    </section>
  );
}

// Re-export helpers for unit-test ergonomics or other callers.
export {
  pctOfPower as _pctOfPower,
  parseSlicePower as _parseSlicePower,
  formatLovelaceAda as _formatLovelaceAda,
};
