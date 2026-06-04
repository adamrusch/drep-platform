import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { FileText, Users, Calendar, RefreshCw } from 'lucide-react';
import { useGovernanceActions } from '@/hooks/useGovernanceActions';
import { useEpoch } from '@/hooks/useEpoch';
import { useAuthStore } from '@/stores/authStore';
import { useMe } from '@/hooks/useAuth';
import { GovernanceActionCard } from '@/components/GovernanceActionCard';
import { GovernanceHistoryWidget } from '@/components/GovernanceHistoryWidget';
import { HeroBand } from '@/components/HeroBand';
import { StatTile } from '@/components/ui/StatTile';
import { Button } from '@/components/ui/Button';
import { DashboardRail } from '@/components/rails/DashboardRail';
import { PageWithRail } from '@/components/Layout';
import { useFormatters } from '@/hooks/useFormatters';
import { formatWalletAddress } from '@/lib/utils';
import { get } from '@/lib/api';
import type { DRepDetail } from '@/types';

export function DelegatorDashboard(): React.ReactElement {
  const { t } = useTranslation();
  const { formatRelativeTime } = useFormatters();

  const formatCountdown = (seconds: number): string => {
    const d = Math.floor(seconds / 86_400);
    const h = Math.floor((seconds % 86_400) / 3600);
    if (d > 0) return t('dashboard.countdown.days', { days: d, hours: h });
    const m = Math.floor((seconds % 3600) / 60);
    return t('dashboard.countdown.hours', { hours: h, minutes: m });
  };

  useAuthStore();
  const { data: profile } = useMe();
  const { data, isLoading } = useGovernanceActions('active');
  const { data: epoch } = useEpoch();

  const allActions = data?.pages.flatMap((p) => p.items) ?? [];
  const activeCount = allActions.filter((a) => a.status === 'active').length;

  // Resolve "Currently delegated to" with the same priority order as
  // ClubhouseLanding.tsx (PR #1):
  //   1. `profile.delegatedToDrepId` — live answer from /auth/me, which
  //      asks Koios (then Blockfrost) directly. Three states:
  //        - string         → confirmed delegated to that DRep
  //        - null           → confirmed undelegated (real "Not delegated")
  //        - undefined      → unknown (upstreams down OR payment-address auth)
  //   2. `delegationHistory[-1]` — sync-snapshotted history. Used as a
  //      fallback only when the live lookup is undefined (unknown), AND
  //      as the source for the DRep display name + epoch metadata that
  //      the live field doesn't carry.
  //
  // The previous implementation read ONLY from `delegationHistory[-1]`,
  // which silently showed "Not delegated" whenever the directory sync
  // hadn't yet captured the wallet's current delegation — even when
  // ClubhouseLanding (which uses the live field) showed it correctly.
  const liveDrepId = profile?.delegatedToDrepId;
  const historyEntry =
    profile?.delegationHistory?.[(profile.delegationHistory.length ?? 1) - 1];
  const currentDrep: { drepId: string; drepName?: string; epochStart?: number } | undefined =
    typeof liveDrepId === 'string'
      ? historyEntry?.drepId === liveDrepId
        ? historyEntry // name + epoch from history when it agrees with the live ID
        : { drepId: liveDrepId } // live truth wins; show truncated bech32 until history catches up
      : liveDrepId === null
        ? undefined // confirmed undelegated — DO NOT fall back to stale history
        : historyEntry; // unknown live state — best-effort history fallback

  // Resolve the DRep's display name from the directory. Shares the
  // `drep-detail` cache key with DRepPublicProfile.tsx and
  // DelegatorClubhouse.tsx so React-Query reuses the entry across pages.
  // The history fallback `drepName` is a snapshotted value from the
  // sync — usable when the live DRep ID agrees with history, but stale
  // otherwise (e.g. a DRep changed their CIP-119 anchor name).
  const { data: currentDrepDetail } = useQuery({
    queryKey: ['drep-detail', currentDrep?.drepId],
    queryFn: () => get<DRepDetail>(`/dreps/${encodeURIComponent(currentDrep?.drepId ?? '')}`),
    enabled: Boolean(currentDrep?.drepId),
    staleTime: 5 * 60 * 1000,
  });
  const currentDrepName =
    currentDrepDetail?.givenName?.trim() ||
    currentDrep?.drepName ||
    (currentDrep ? formatWalletAddress(currentDrep.drepId, 8) : '');

  const hotActions = [...allActions]
    .filter((a) => a.status === 'active')
    .sort((a, b) => a.epochDeadline - b.epochDeadline)
    .slice(0, 5);

  const lastSyncedAt = allActions
    .map((a) => a.lastSyncedAt)
    .filter((s): s is string => Boolean(s))
    .sort()
    .reverse()[0];

  const center = (
    <>
      <HeroBand
        title={
          profile?.displayName
            ? t('dashboard.welcomeNamed', { name: profile.displayName })
            : t('dashboard.welcomeBack')
        }
        subtitle={t('dashboard.delegatorSubtitle')}
        actions={
          <Button asChild variant="secondary" size="sm">
            <Link to="/profile/setup">{t('dashboard.editProfile')}</Link>
          </Button>
        }
      />

      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
        <StatTile
          label={t('dashboard.stat.activeProposals')}
          value={isLoading ? '—' : activeCount}
          icon={FileText}
          iconVariant="indigo"
        />
        {currentDrep ? (
          <Link
            to={`/drep/${encodeURIComponent(currentDrep.drepId)}`}
            className="block rounded-token-xl outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)] focus-visible:ring-offset-2 transition-colors hover:[&>div]:border-[var(--brand-primary)]"
            aria-label={t('dashboard.viewProfileAria', { name: currentDrepName })}
          >
            <StatTile
              label={t('dashboard.stat.yourDrep')}
              value={currentDrepName}
              icon={Users}
              iconVariant="violet"
            />
          </Link>
        ) : (
          <StatTile
            label={t('dashboard.stat.yourDrep')}
            value={t('dashboard.stat.notDelegated')}
            icon={Users}
            iconVariant="violet"
          />
        )}
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
          so delegators see the full historical picture (with the
          treasury-spend headline) before scanning live work. */}
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
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="h-24 bg-[var(--bg-muted)] rounded-token-xl animate-pulse"
              />
            ))}
          </div>
        ) : hotActions.length === 0 ? (
          <div className="text-center py-10 text-[var(--text-tertiary)] text-sm rounded-token-xl border border-[var(--border-default)] bg-[var(--bg-canvas)]">
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
