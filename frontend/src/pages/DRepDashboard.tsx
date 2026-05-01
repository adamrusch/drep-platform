import React from 'react';
import { Link } from 'react-router-dom';
import { useGovernanceActions } from '@/hooks/useGovernanceActions';
import { useAuthStore } from '@/stores/authStore';
import { useGovernanceSync } from '@/hooks/useGovernanceActions';
import { GovernanceActionCard } from '@/components/GovernanceActionCard';

export function DRepDashboard(): React.ReactElement {
  const { walletAddress, drepId, roles } = useAuthStore();
  const { data, isLoading } = useGovernanceActions('active');
  const syncMutation = useGovernanceSync();

  const allActions = data?.pages.flatMap((p) => p.items) ?? [];
  const isLeadDRep = roles.includes('lead_drep');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">DRep Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            {walletAddress ? `${walletAddress.slice(0, 12)}…` : ''}
          </p>
        </div>
        <div className="flex gap-2">
          {drepId && (
            <Link
              to={`/drep/${drepId}`}
              className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-accent transition-colors"
            >
              My Committee
            </Link>
          )}
          {isLeadDRep && (
            <button
              onClick={() => syncMutation.mutate()}
              disabled={syncMutation.isPending}
              className="rounded-md bg-cardano-blue text-white px-3 py-1.5 text-sm font-medium hover:bg-cardano-blue/90 disabled:opacity-50"
            >
              {syncMutation.isPending ? 'Syncing…' : 'Sync Governance'}
            </button>
          )}
        </div>
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Active Proposals', value: allActions.filter((a) => a.status === 'active').length },
          { label: 'Your Role', value: roles[0] ?? 'guest' },
          { label: 'DRep ID', value: drepId ? `${drepId.slice(0, 8)}…` : 'Not registered' },
        ].map(({ label, value }) => (
          <div key={label} className="rounded-lg border border-border bg-card p-3">
            <div className="text-xs text-muted-foreground mb-1">{label}</div>
            <div className="text-sm font-semibold">{String(value)}</div>
          </div>
        ))}
      </div>

      {/* Active governance actions */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Active Governance Actions</h2>
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-24 bg-muted rounded-lg animate-pulse" />
            ))}
          </div>
        ) : allActions.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground text-sm">
            No active governance actions.
          </div>
        ) : (
          <div className="space-y-3">
            {allActions.map((action) => (
              <GovernanceActionCard key={action.actionId} action={action} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
