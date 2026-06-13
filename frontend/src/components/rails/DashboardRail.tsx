import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, BarChart3, RefreshCw } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { useEpoch } from '@/hooks/useEpoch';

const SoonPill = (): React.ReactElement => {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-token-full bg-[var(--bg-muted)] text-[var(--text-tertiary)]">
      {t('dashboardRail.soon')}
    </span>
  );
};

interface ActivityItem {
  kind: 'vote' | 'comment' | 'sync';
  textKey: string;
  time: string;
  color: string;
}

const PLACEHOLDER_ACTIVITY: ActivityItem[] = [
  { kind: 'vote', textKey: 'dashboardRail.activity.notVotedThisEpoch', time: 'now', color: 'var(--brand-primary)' },
  { kind: 'comment', textKey: 'dashboardRail.activity.noComments', time: '—', color: 'var(--brand-accent)' },
  { kind: 'sync', textKey: 'dashboardRail.activity.awaitingSync', time: '—', color: 'var(--text-tertiary)' },
  { kind: 'vote', textKey: 'dashboardRail.activity.pastActivity', time: '—', color: 'var(--text-muted)' },
  { kind: 'comment', textKey: 'dashboardRail.activity.walletRequired', time: '—', color: 'var(--text-muted)' },
];

/**
 * Dashboard right rail — three sections:
 *   1. "Your votes this epoch" stat block
 *   2. "Recent activity" 5-item timeline (placeholders for now)
 *   3. Sync info footer
 *
 * Real data wiring lands in a follow-up; the chrome must be visible
 * today so the design layout reads correctly.
 */
export function DashboardRail(): React.ReactElement {
  const { t } = useTranslation();
  const { data: epoch } = useEpoch();

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>
            <BarChart3 size={14} strokeWidth={2} className="text-[var(--brand-primary)]" />
            {t('dashboardRail.yourVotesThisEpoch')}
          </CardTitle>
          <SoonPill />
        </CardHeader>
        <div className="grid grid-cols-3 gap-3 text-center">
          {[
            { key: 'yes', label: t('dashboardRail.votes.yes'), value: '0', color: 'var(--success)' },
            { key: 'no', label: t('dashboardRail.votes.no'), value: '0', color: 'var(--danger)' },
            { key: 'abstain', label: t('dashboardRail.votes.abstain'), value: '0', color: 'var(--text-tertiary)' },
          ].map((s) => (
            <div
              key={s.key}
              className="rounded-token-md border border-[var(--border-subtle)] py-2 bg-[var(--bg-subtle)]"
            >
              <div
                className="text-[18px] font-bold tabular-nums"
                style={{ color: s.color }}
              >
                {s.value}
              </div>
              <div className="text-[10.5px] uppercase tracking-wider text-[var(--text-tertiary)] mt-0.5">
                {s.label}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <Activity size={14} strokeWidth={2} className="text-[var(--brand-primary)]" />
            {t('dashboardRail.recentActivity')}
          </CardTitle>
          <SoonPill />
        </CardHeader>
        <ul className="space-y-3">
          {PLACEHOLDER_ACTIVITY.map((a, i) => (
            <li key={i} className="flex items-start gap-3 text-sm">
              <span
                className="mt-1.5 w-2 h-2 rounded-full flex-shrink-0"
                style={{ background: a.color }}
                aria-hidden="true"
              />
              <span className="flex-1 min-w-0 text-[var(--text-secondary)] leading-tight">
                {t(a.textKey)}
              </span>
              <span className="text-[11px] text-[var(--text-tertiary)] tabular-nums flex-shrink-0">
                {a.time === 'now' ? t('dashboardRail.now') : a.time}
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <RefreshCw size={14} strokeWidth={2} className="text-[var(--brand-primary)]" />
            {t('dashboardRail.syncInfo')}
          </CardTitle>
        </CardHeader>
        <dl className="space-y-1.5 text-sm">
          <div className="flex justify-between">
            <dt className="text-[var(--text-tertiary)]">{t('dashboardRail.network')}</dt>
            <dd className="font-medium text-[var(--text-primary)]">Mainnet</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-[var(--text-tertiary)]">{t('dashboardRail.currentEpoch')}</dt>
            <dd className="font-medium text-[var(--text-primary)] tabular-nums">
              {epoch?.epoch ?? '—'}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-[var(--text-tertiary)]">{t('dashboardRail.source')}</dt>
            <dd className="font-medium text-[var(--text-primary)]">Blockfrost</dd>
          </div>
        </dl>
      </Card>
    </>
  );
}
