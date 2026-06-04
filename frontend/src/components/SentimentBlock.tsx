import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Check, X, MoreHorizontal, Minus } from 'lucide-react';
import { Donut, type DonutSegment } from '@/components/ui/Donut';
import { cn } from '@/lib/utils';
import type { VoteRoleTally, VoteSlice, VoteTally, VotingRoles } from '@/types';

interface SentimentBlockProps {
  /** Section title — "On-Chain Votes", "Delegator Sentiment", etc. */
  title: string;
  /** Optional small caption shown after the title (design uses this for
   *  scoped sub-titles like "DRep voting power"). */
  caption?: string;
  tally: VoteTally;
  /** CIP-1694 role-applicability map. When a role is `false`, the entire
   *  section (donut + breakdown + abstain footnote) is suppressed —
   *  rendering "0 voters / 0 ADA / 0%" for a non-applicable role would
   *  imply non-participation rather than non-applicability. When omitted
   *  (legacy actions written before v9) all three sections render. */
  votingRoles?: VotingRoles;
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

/** % of a BigInt total. Returns 0 when total is zero. One decimal place. */
function pctOfPower(part: bigint, total: bigint): number {
  if (total <= 0n) return 0;
  // Multiply by 1000 first to keep one decimal of precision in BigInt math.
  const x = (part * 1000n) / total;
  return Number(x) / 10;
}

/** Headcount label. Singular when count == 1 ("1 voter") for a tiny dignity
 *  bump on early-voting actions. */
function voterLabel(role: 'drep' | 'spo' | 'cc', count: number, t: TFunction): string {
  if (role === 'cc') return t(count === 1 ? 'sentiment.memberOne' : 'sentiment.memberOther', { count });
  if (role === 'spo') return t(count === 1 ? 'sentiment.spoOne' : 'sentiment.spoOther', { count });
  return t(count === 1 ? 'sentiment.drepOne' : 'sentiment.drepOther', { count });
}

function totalLabel(role: 'drep' | 'spo' | 'cc', t: TFunction): string {
  if (role === 'cc') return t('sentiment.totalCommitteeMembers');
  if (role === 'spo') return t('sentiment.totalActiveSpos');
  return t('sentiment.totalActiveDreps');
}

/** Per-role 3-slice donut + breakdown + abstain footnote. The center of
 *  the donut shows the Active Governance Stake (the CIP-1694 ratification
 *  denominator); below the donut, three rows show Yes / No / Not Voted
 *  with counts, ADA, and percentages summing to 100% of `totalActive`.
 *  The Abstain row is rendered as a divider-separated footnote with
 *  explanatory copy — it is NOT a 4th slice. Auto-abstain stake is
 *  intentionally NOT surfaced anywhere on this UI: those wallets are
 *  treated as "opted out" (effectively unregistered) per CIP-1694, and
 *  showing them as a separate bucket was misleading users into thinking
 *  the explicit-abstain count was bigger than it really is. */
function RoleSection({
  label,
  role,
  roleKey,
}: {
  label: string;
  role: VoteRoleTally;
  roleKey: 'drep' | 'spo' | 'cc';
}): React.ReactElement {
  const { t } = useTranslation();
  const isCount = roleKey === 'cc';
  const yesPower = parseSlicePower(role.yes);
  const noPower = parseSlicePower(role.no);
  const notVotedPower = parseSlicePower(role.notVoted);
  const abstainPower = parseSlicePower(role.abstain);
  const totalActivePower = parseSlicePower(role.totalActive);

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
    { label: t('sentiment.choiceYes'), value: sliceForDonut(yesPower), color: SUCCESS_COLOR },
    { label: t('sentiment.choiceNo'), value: sliceForDonut(noPower), color: DANGER_COLOR },
    {
      label: t('sentiment.choiceNotVoted'),
      value: sliceForDonut(notVotedPower),
      color: NOT_VOTED_COLOR,
    },
  ];

  const centerValue = isCount
    ? `${role.totalActive.count}`
    : formatLovelaceAda(totalActivePower);
  // "Active Governance Stake" is the user-facing name for the CIP-1694
  // ratification denominator. CC has no stake-weighted denominator, so we
  // keep that label as a member count.
  const centerLabel = isCount ? t('sentiment.ccMembers') : t('sentiment.activeGovStake');

  // Abstain percentage — expressed against `totalActive` (the ratification
  // denominator) plus the explicit abstain count itself. We deliberately
  // do NOT pull `totalRegistered` here, since v9 the UI no longer surfaces
  // the bigger informational denominator anywhere.
  const abstainPctVsActive =
    totalActivePower > 0n
      ? pctOfPower(abstainPower, totalActivePower + abstainPower)
      : 0;

  return (
    <section className="space-y-3">
      <header className="flex items-baseline justify-between gap-3 flex-wrap">
        <h4 className="text-[14px] font-semibold text-[var(--text-primary)] m-0">
          {label}
        </h4>
        <span className="text-[11.5px] text-[var(--text-tertiary)] tabular-nums">
          {voterLabel(roleKey, role.totalActive.count, t)} {totalLabel(roleKey, t)}
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
            label={t('sentiment.choiceYes')}
            count={role.yes.count}
            secondaryLabel={isCount ? '' : formatLovelaceAda(yesPower)}
            pct={yesPct}
            roleKey={roleKey}
          />
          <BreakdownRow
            icon={<X size={14} strokeWidth={2.25} />}
            iconClass="text-[var(--danger)]"
            label={t('sentiment.choiceNo')}
            count={role.no.count}
            secondaryLabel={isCount ? '' : formatLovelaceAda(noPower)}
            pct={noPct}
            roleKey={roleKey}
          />
          <BreakdownRow
            icon={<MoreHorizontal size={14} strokeWidth={2.25} />}
            iconClass="text-[var(--text-muted)]"
            label={t('sentiment.choiceNotVoted')}
            count={role.notVoted.count}
            secondaryLabel={isCount ? '' : formatLovelaceAda(notVotedPower)}
            pct={notVotedPct}
            roleKey={roleKey}
          />

          {/* Abstain footnote — explicit on-chain abstains only.
              v9: auto-abstain is no longer summed into `abstain.power` by
              the backend, so this row reflects only DReps / SPOs who
              actively voted Abstain. We deliberately omit auto-no-
              confidence and totalRegistered from any displayed text — the
              donut already accounts for those numbers internally. */}
          {(abstainPower > 0n || role.abstain.count > 0) && (
            <div className="pt-2 mt-2 border-t border-[var(--border-subtle)] space-y-1">
              <div className="flex items-center gap-2 text-[12px] text-[var(--text-tertiary)]">
                <Minus
                  size={14}
                  strokeWidth={2.25}
                  className="text-[var(--text-muted)] flex-shrink-0"
                  aria-hidden="true"
                />
                <span className="font-semibold">{t('sentiment.abstain')}</span>
                <span className="tabular-nums">
                  {role.abstain.count > 0
                    ? t(
                        (() => {
                          const isOne = role.abstain.count === 1;
                          if (roleKey === 'drep')
                            return isOne ? 'sentiment.abstainedDrepOne' : 'sentiment.abstainedDrepOther';
                          if (roleKey === 'spo')
                            return isOne ? 'sentiment.abstainedSpoOne' : 'sentiment.abstainedSpoOther';
                          return isOne ? 'sentiment.abstainedCcOne' : 'sentiment.abstainedCcOther';
                        })(),
                        { count: role.abstain.count },
                      )
                    : ''}
                </span>
                {!isCount && (
                  <span className="tabular-nums text-[var(--text-muted)]">
                    · {formatLovelaceAda(abstainPower)}
                  </span>
                )}
                {abstainPctVsActive > 0 && !isCount && (
                  <span className="tabular-nums text-[var(--text-muted)]">
                    · {abstainPctVsActive.toFixed(1)}%
                  </span>
                )}
              </div>
              <div className="text-[11px] text-[var(--text-muted)] leading-snug pl-6">
                {t('sentiment.notInDenominator')}
              </div>
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
  const { t } = useTranslation();
  const countLabel =
    roleKey === 'cc'
      ? t(count === 1 ? 'sentiment.ccMemberOne' : 'sentiment.ccMemberOther', { count })
      : t(count === 1 ? 'sentiment.voterOne' : 'sentiment.voterOther', { count });
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
        {countLabel}
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
 * On-Chain Votes block. One section per applicable role (DRep / SPO /
 * Constitutional Committee). Each section renders a 3-slice donut
 * (Yes / No / Not Voted) sized by voting power, summing to 100% of that
 * role's Active Governance Stake — the CIP-1694 ratification denominator.
 * Abstain is surfaced as a footnote BELOW the breakdown, deliberately
 * separated because per CIP-1694 abstain stake is "actively marked as not
 * participating in governance" and therefore excluded from the
 * ratification math.
 *
 * Why per-role sections (not aggregated): governance ratification rules
 * differ per role (DRep vs SPO vs CC have different thresholds), and
 * mixing power-units (lovelace) with headcount (CC has 1 vote per member)
 * into a single donut is misleading. Each role gets its own ratification
 * picture.
 *
 * Role-applicability gate: per CIP-1694 §Ratification §Restrictions, not
 * every governance body votes on every action type. SPOs are NOT called
 * on Treasury Withdrawals or NewConstitution; CC is NOT called on
 * NoConfidence or UpdateCommittee. When `votingRoles[roleKey]` is false
 * we suppress the entire section — rendering "0 voters / 0 ADA / 0%"
 * placeholders for non-applicable bodies misleads readers into thinking
 * those voters chose not to participate. When `votingRoles` is undefined
 * (legacy actions written before sync v9), all three sections render
 * (the previous default).
 */
export function SentimentBlock({
  title,
  caption,
  tally,
  votingRoles,
  className,
}: SentimentBlockProps): React.ReactElement {
  const { t } = useTranslation();
  // Default to all-applicable when the backend hasn't provided the map
  // yet — older stored items omit the field, and showing all three
  // sections matches pre-v9 behavior.
  const showDrep = votingRoles?.drep ?? true;
  const showSpo = votingRoles?.spo ?? true;
  const showCc = votingRoles?.cc ?? true;

  // Compute a flat list of sections so we don't end up with stray
  // dividers when one role is hidden (e.g. Treasury Withdrawals → no SPO
  // section means we shouldn't render a divider between DRep and CC).
  const sections: React.ReactElement[] = [];
  if (showDrep) {
    sections.push(
      <RoleSection key="drep" label={t('sentiment.roleDrep')} roleKey="drep" role={tally.drep} />,
    );
  }
  if (showSpo) {
    sections.push(
      <RoleSection key="spo" label={t('sentiment.roleSpo')} roleKey="spo" role={tally.spo} />,
    );
  }
  if (showCc) {
    sections.push(
      <RoleSection
        key="cc"
        label={t('sentiment.roleCc')}
        roleKey="cc"
        role={tally.cc}
      />,
    );
  }

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
          {t('sentiment.percentOfStake')}
        </span>
      </header>

      {sections.length === 0 ? (
        // Defensive — every action type calls at least one body per the
        // CIP-1694 matrix. A visible "no applicable voters" message beats
        // a silently-blank panel if a future action type ever lands here.
        <div className="text-sm text-[var(--text-tertiary)]">
          {t('sentiment.noBodies')}
        </div>
      ) : (
        sections.flatMap((section, i) =>
          i === 0
            ? [section]
            : [
                <div
                  key={`divider-${i}`}
                  className="border-t border-[var(--border-subtle)]"
                />,
                section,
              ],
        )
      )}
    </section>
  );
}

// Re-export helpers for unit-test ergonomics or other callers.
export {
  pctOfPower as _pctOfPower,
  parseSlicePower as _parseSlicePower,
  formatLovelaceAda as _formatLovelaceAda,
};
