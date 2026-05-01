import React from 'react';
import { Link } from 'react-router-dom';
import { useGovernanceActions } from '@/hooks/useGovernanceActions';
import { useAuthStore } from '@/stores/authStore';
import { GovernanceActionCard } from '@/components/GovernanceActionCard';
import { useMe } from '@/hooks/useAuth';

export function DelegatorDashboard(): React.ReactElement {
  const { walletAddress } = useAuthStore();
  const { data: profile } = useMe();
  const { data, isLoading } = useGovernanceActions('active');

  const allActions = data?.pages.flatMap((p) => p.items) ?? [];
  const currentDrep = profile?.delegationHistory?.[profile.delegationHistory.length - 1];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">
            Welcome{profile?.displayName ? `, ${profile.displayName}` : ' back'}
          </h1>
          <p className="text-sm text-muted-foreground">
            {walletAddress ? `${walletAddress.slice(0, 12)}…` : ''}
          </p>
        </div>
        <Link
          to="/profile"
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent transition-colors"
        >
          Edit Profile
        </Link>
      </div>

      {/* Current delegation */}
      {currentDrep && (
        <div className="rounded-lg border border-cardano-blue/30 bg-blue-50/30 p-4">
          <div className="text-xs text-muted-foreground mb-1">Currently Delegated To</div>
          <Link
            to={`/drep/${currentDrep.drepId}`}
            className="font-semibold hover:underline"
          >
            {currentDrep.drepName ?? currentDrep.drepId.slice(0, 16) + '…'}
          </Link>
          <div className="text-xs text-muted-foreground mt-1">
            Since epoch {currentDrep.epochStart}
          </div>
        </div>
      )}

      {/* Active proposals */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Active Proposals</h2>
          <Link to="/governance" className="text-sm text-primary hover:underline">
            View all
          </Link>
        </div>
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-24 bg-muted rounded-lg animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            {allActions.slice(0, 5).map((action) => (
              <GovernanceActionCard key={action.actionId} action={action} />
            ))}
            {allActions.length === 0 && (
              <div className="text-center py-8 text-muted-foreground text-sm">
                No active governance actions.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
