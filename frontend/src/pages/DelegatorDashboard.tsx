import React from 'react';
import { Link } from 'react-router-dom';
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
import { formatRelativeTime } from '@/lib/utils';

function formatCountdown(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  if (d > 0) return `Ends in ${d}d ${h}h`;
  const m = Math.floor((seconds % 3600) / 60);
  return `Ends in ${h}h ${m}m`;
}

export function DelegatorDashboard(): React.ReactElement {
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
        title={`Welcome${profile?.displayName ? `, ${profile.displayName}` : ' back'}`}
        subtitle="Track active governance, follow your DRep, and weigh in on proposals you care about."
        actions={
          <Button asChild variant="secondary" size="sm">
            <Link to="/profile/setup">Edit Profile</Link>
          </Button>
        }
      />

      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
        <StatTile
          label="Active Proposals"
          value={isLoading ? '—' : activeCount}
          icon={FileText}
          iconVariant="indigo"
        />
        <StatTile
          label="Your Delegation"
          value={
            currentDrep
              ? currentDrep.drepName ?? `${currentDrep.drepId.slice(0, 10)}…`
              : 'Not delegated'
          }
          icon={Users}
          iconVariant="violet"
        />
        <StatTile
          label="Current Epoch"
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
          label="Last Sync"
          value={lastSyncedAt ? formatRelativeTime(lastSyncedAt) : '—'}
          icon={RefreshCw}
          iconVariant="amber"
        />
      </div>

      {/* Current delegation card — kept as a secondary tile */}
      {currentDrep && (
        <div className="rounded-token-xl border border-[var(--brand-primary)]/30 bg-[var(--brand-primary-soft)]/30 p-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-1">
            Currently Delegated To
          </div>
          <Link
            to={`/drep/${currentDrep.drepId}`}
            className="font-semibold text-[var(--text-primary)] hover:underline"
          >
            {currentDrep.drepName ?? `${currentDrep.drepId.slice(0, 16)}…`}
          </Link>
          <div className="text-xs text-[var(--text-tertiary)] mt-0.5">
            Since epoch {currentDrep.epochStart}
          </div>
        </div>
      )}

      {/* Governance History — reference card sitting above Hot Actions
          so delegators see the full historical picture (with the
          treasury-spend headline) before scanning live work. */}
      <GovernanceHistoryWidget />

      {/* Hot Actions */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
            Hot Actions
          </h2>
          <Link
            to="/governance"
            className="text-sm text-[var(--brand-primary)] hover:underline"
          >
            View all →
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
            No active governance actions right now.
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
