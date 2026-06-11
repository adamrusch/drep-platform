import type React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FileText, Users, Calendar, RefreshCw } from 'lucide-react';
import { useGovernanceActions, useGovernanceSync } from '@/hooks/useGovernanceActions';
import { useEpoch } from '@/hooks/useEpoch';
import { useAuthStore } from '@/stores/authStore';
import { GovernanceActionCard } from '@/components/GovernanceActionCard';
import { GovernanceHistoryWidget } from '@/components/GovernanceHistoryWidget';
import { HeroBand } from '@/components/HeroBand';
import { InvitationsCard } from '@/components/InvitationsCard';
import { StatTile } from '@/components/ui/StatTile';
import { Button } from '@/components/ui/Button';
import { DashboardRail } from '@/components/rails/DashboardRail';
import { PageWithRail } from '@/components/Layout';
import { useFormatters } from '@/hooks/useFormatters';

export function DRepDashboard(): React.ReactElement {
  const { t } = useTranslation();
  const { formatRelativeTime } = useFormatters();

  const formatCountdown = (seconds: number): string => {
    const d = Math.floor(seconds / 86_400);
    const h = Math.floor((seconds % 86_400) / 3600);
    if (d > 0) return t('dashboard.countdown.days', { days: d, hours: h });
    const m = Math.floor((seconds % 3600) / 60);
    return t('dashboard.countdown.hours', { hours: h, minutes: m });
  };

  const { drepId, roles } = useAuthStore();
  const { data, isLoading } = useGovernanceActions('active');
  const { data: epoch } = useEpoch();
  const syncMutation = useGovernanceSync();

  const allActions = data?.pages.flatMap((p) => p.items) ?? [];
  const activeCount = allActions.filter((a) => a.status === 'active').length;
  const isLeadDRep = roles.includes('lead_drep');

  // "Hot Actions" — top 5 active by deadline-proximity (lowest epochDeadline first).
  const hotActions = [...allActions]
    .filter((a) => a.status === 'active')
    .sort((a, b) => a.epochDeadline - b.epochDeadline)
    .slice(0, 5);

  // Find the most recent lastSyncedAt across all loaded actions.
  const lastSyncedAt = allActions
    .map((a) => a.lastSyncedAt)
    .filter((s): s is string => Boolean(s))
    .sort()
    .reverse()[0];

  const center = (
    <>
      <HeroBand
        title={
          roles.includes('lead_drep')
            ? t('dashboard.welcomeBackDrep')
            : t('dashboard.welcomeBack')
        }
        subtitle={t('dashboard.drepSubtitle')}
        actions={
          <>
            {drepId && (
              <Button asChild variant="secondary" size="sm">
                <Link to={`/drep/${drepId}`}>{t('dashboard.myCommittee')}</Link>
              </Button>
            )}
            {isLeadDRep && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => syncMutation.mutate()}
                disabled={syncMutation.isPending}
              >
                <RefreshCw size={14} strokeWidth={2} />
                {syncMutation.isPending ? t('dashboard.syncing') : t('dashboard.syncGovernance')}
              </Button>
            )}
          </>
        }
      />

      {/* Pending committee invitation(s). Self-hides when empty. A DRep can
          also be invited to ANOTHER committee, so this surface belongs here
          too. */}
      <InvitationsCard />

      {/* Stat grid — 4 tiles, auto-fit minmax(180px, 1fr) per design */}
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
        <StatTile
          label={t('dashboard.stat.activeProposals')}
          value={isLoading ? '—' : activeCount}
          icon={FileText}
          iconVariant="indigo"
        />
        <StatTile
          label={t('dashboard.stat.yourDrepId')}
          value={drepId ? `${drepId.slice(0, 10)}…` : t('dashboard.stat.notRegistered')}
          icon={Users}
          iconVariant="violet"
        />
        <StatTile
          label={t('dashboard.stat.currentEpoch')}
          value={epoch ? epoch.epoch : '—'}
          icon={Calendar}
          iconVariant="cyan"
          trend={
            epoch
              ? { direction: 'flat', delta: formatCountdown(epoch.endsInSeconds) }
              : undefined
          }
        />
        <StatTile
          label={t('dashboard.stat.lastSync')}
          value={lastSyncedAt ? formatRelativeTime(lastSyncedAt) : '—'}
          icon={RefreshCw}
          iconVariant="amber"
        />
      </div>

      {/* Governance History — reference card sitting above Hot Actions
          so DReps land on the comprehensive picture before drilling into
          live work. The widget is self-contained (its own data hooks)
          and links through to /governance/history for the full reference. */}
      <GovernanceHistoryWidget />

      {/* Hot Actions */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
            {t('dashboard.hotActions')}
          </h2>
          <Link
            to="/governance"
            className="text-sm text-[var(--brand-primary)] hover:underline"
          >
            {t('dashboard.viewAll')}
          </Link>
        </div>
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="h-24 bg-[var(--bg-muted)] rounded-token-xl animate-pulse"
              />
            ))}
          </div>
        ) : hotActions.length === 0 ? (
          <div className="text-center py-12 text-[var(--text-tertiary)] text-sm rounded-token-xl border border-[var(--border-default)] bg-[var(--bg-canvas)]">
            {t('dashboard.noActiveActions')}
          </div>
        ) : (
          <div className="space-y-3">
            {hotActions.map((action) => (
              <GovernanceActionCard key={action.actionId} action={action} />
            ))}
          </div>
        )}
      </div>
    </>
  );

  return <PageWithRail rail={<DashboardRail />}>{center}</PageWithRail>;
}
