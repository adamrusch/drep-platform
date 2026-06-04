import { Trans, useTranslation } from 'react-i18next';
import { Donut } from '@/components/ui/Donut';
import type { CommitteeTally } from '@/types/committee';

const COLORS = {
  agree: 'var(--success)',
  disagree: 'var(--danger)',
  abstain: 'var(--text-secondary)',
};

/**
 * Agree / Disagree / Abstain ring with the live X-of-N rule at center —
 * "{agreeCount} / {memberCount}" with the X-of-N rule + "Committee Approved"
 * status in the legend.
 */
export function VoteTallyDonut({
  tally,
  size = 140,
}: {
  tally: CommitteeTally;
  size?: number;
}): React.ReactElement {
  const { t } = useTranslation();
  const segments = [
    { label: t('committeeRoom.tally.agree'), value: tally.agreeCount, color: COLORS.agree },
    { label: t('committeeRoom.tally.disagree'), value: tally.disagreeCount, color: COLORS.disagree },
    { label: t('committeeRoom.tally.abstain'), value: tally.abstainCount, color: COLORS.abstain },
  ];
  return (
    <div className="flex items-center gap-5">
      <Donut
        segments={segments}
        size={size}
        strokeWidth={size >= 140 ? 20 : 14}
        centerValue={
          tally.memberCount > 0 ? `${tally.agreeCount}/${tally.memberCount}` : '—'
        }
        centerLabel={t('committeeRoom.tally.centerLabel')}
      />
      <ul className="space-y-1 text-[13px]">
        <LegendRow color={COLORS.agree} label={t('committeeRoom.tally.agree')} value={tally.agreeCount} />
        <LegendRow color={COLORS.disagree} label={t('committeeRoom.tally.disagree')} value={tally.disagreeCount} />
        <LegendRow color={COLORS.abstain} label={t('committeeRoom.tally.abstain')} value={tally.abstainCount} />
        <li className="pt-1 text-[12px] text-[var(--text-secondary)]">
          {tally.isApproved ? (
            <Trans
              i18nKey="committeeRoom.tally.needs"
              values={{ x: tally.approvalThreshold, n: tally.memberCount }}
              components={{ strong: <strong className="text-[var(--text-primary)]" /> }}
            />
          ) : (
            <Trans
              i18nKey="committeeRoom.tally.needsMore"
              values={{ x: tally.approvalThreshold, n: tally.memberCount, remaining: tally.agreeNeeded }}
              components={{ strong: <strong className="text-[var(--text-primary)]" /> }}
            />
          )}
        </li>
        {tally.isApproved && (
          <li className="pt-1">
            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--success)] px-2 py-0.5 text-[11.5px] font-semibold text-white">
              {t('committeeRoom.tally.approvedBadge')}
            </span>
          </li>
        )}
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
