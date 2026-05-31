import { Donut } from '@/components/ui/Donut';
import type { CommitteeTally } from '@/types/committee';

const COLORS = {
  agree: 'var(--success)',
  disagree: 'var(--danger)',
  abstain: 'var(--text-secondary)',
};

/** Agree/Disagree/Abstain ring with the agree-% of the active pool at center. */
export function VoteTallyDonut({
  tally,
  size = 140,
}: {
  tally: CommitteeTally;
  size?: number;
}): React.ReactElement {
  const segments = [
    { label: 'Agree', value: tally.agreeCount, color: COLORS.agree },
    { label: 'Disagree', value: tally.disagreeCount, color: COLORS.disagree },
    { label: 'Abstain', value: tally.abstainCount, color: COLORS.abstain },
  ];
  return (
    <div className="flex items-center gap-5">
      <Donut
        segments={segments}
        size={size}
        strokeWidth={size >= 140 ? 20 : 14}
        centerValue={tally.activePool > 0 ? `${Math.round(tally.agreePct)}%` : '—'}
        centerLabel="agree / active"
      />
      <ul className="space-y-1 text-[13px]">
        <LegendRow color={COLORS.agree} label="Agree" value={tally.agreeCount} />
        <LegendRow color={COLORS.disagree} label="Disagree" value={tally.disagreeCount} />
        <LegendRow color={COLORS.abstain} label="Abstain" value={tally.abstainCount} />
        <li className="pt-1 text-[12px] text-[var(--text-secondary)]">
          {tally.quorumMet ? 'Quorum met' : `Needs ${3 - tally.activePool} more active vote(s) for quorum`}
        </li>
      </ul>
    </div>
  );
}

function LegendRow({ color, label, value }: { color: string; label: string; value: number }): React.ReactElement {
  return (
    <li className="flex items-center gap-2">
      <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
      <span className="text-[var(--text-secondary)]">{label}</span>
      <span className="font-medium text-[var(--text-primary)]">{value}</span>
    </li>
  );
}
