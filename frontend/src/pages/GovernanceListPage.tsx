import React, { useState } from 'react';
import { useGovernanceActions } from '@/hooks/useGovernanceActions';
import { GovernanceActionCard } from '@/components/GovernanceActionCard';
import { cn } from '@/lib/utils';
import type { GovernanceActionStatus } from '@/types';

const STATUS_TABS: Array<{ id: GovernanceActionStatus; label: string }> = [
  { id: 'active', label: 'Active' },
  { id: 'enacted', label: 'Enacted' },
  { id: 'expired', label: 'Expired' },
  { id: 'dropped', label: 'Dropped' },
];

export function GovernanceListPage(): React.ReactElement {
  const [status, setStatus] = useState<GovernanceActionStatus>('active');
  const { data, isLoading, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useGovernanceActions(status);

  const actions = data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">Governance Actions</h1>
        <p className="text-sm text-muted-foreground">
          Live from the Cardano mainnet. Updated every 2 minutes.
        </p>
      </header>

      {/* Status tabs */}
      <div role="tablist" className="flex flex-wrap gap-1 border-b border-border">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={status === tab.id}
            onClick={() => setStatus(tab.id)}
            className={cn(
              'px-3 py-1.5 text-sm font-medium border-b-2 -mb-px transition-colors',
              status === tab.id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Loading skeletons */}
      {isLoading && (
        <div className="space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="rounded-lg border border-border bg-card p-4 animate-pulse">
              <div className="h-4 bg-muted rounded w-1/3 mb-3" />
              <div className="h-5 bg-muted rounded w-3/4 mb-2" />
              <div className="h-4 bg-muted rounded w-full" />
            </div>
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-4 text-sm">
          <p className="font-medium text-destructive">Failed to load governance actions</p>
          <p className="text-muted-foreground mt-1">{(error as Error).message}</p>
        </div>
      )}

      {/* Empty */}
      {!isLoading && !error && actions.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <p>No {status} governance actions.</p>
        </div>
      )}

      {/* List */}
      {actions.length > 0 && (
        <ul className="space-y-3">
          {actions.map((action) => (
            <li key={action.actionId}>
              <GovernanceActionCard action={action} />
            </li>
          ))}
        </ul>
      )}

      {/* Pagination */}
      {hasNextPage && (
        <div className="text-center pt-4">
          <button
            onClick={() => void fetchNextPage()}
            disabled={isFetchingNextPage}
            className={cn(
              'rounded-md border border-border px-4 py-2 text-sm font-medium',
              'hover:bg-accent transition-colors disabled:opacity-50',
            )}
          >
            {isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}
