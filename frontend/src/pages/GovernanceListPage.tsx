import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useGovernanceActions } from '@/hooks/useGovernanceActions';
import { GovernanceActionCard } from '@/components/GovernanceActionCard';
import { Button } from '@/components/ui/Button';
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
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <h1 className="text-[26px] font-bold tracking-tight text-[var(--text-primary)]">
            Governance Actions
          </h1>
          <Link
            to="/governance/history"
            className="text-sm text-[var(--brand-primary)] hover:underline"
          >
            View on-chain history →
          </Link>
        </div>
        <p className="text-sm text-[var(--text-secondary)]">
          Live from the Cardano mainnet. Updated every minute.
        </p>
      </header>

      {/* Status tabs — design `.tabs` pattern */}
      <div role="tablist" className="tabs">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={status === tab.id}
            onClick={() => setStatus(tab.id)}
            className={cn('tab', status === tab.id && 'tab--active')}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Loading skeletons */}
      {isLoading && (
        <div className="space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="rounded-token-xl border border-[var(--border-default)] bg-[var(--bg-canvas)] shadow-token-sm p-5 animate-pulse"
            >
              <div className="h-4 bg-[var(--bg-muted)] rounded w-1/3 mb-3" />
              <div className="h-5 bg-[var(--bg-muted)] rounded w-3/4 mb-2" />
              <div className="h-4 bg-[var(--bg-muted)] rounded w-full" />
            </div>
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-token-lg border border-[var(--danger)]/40 bg-[var(--danger-soft)] p-4 text-sm">
          <p className="font-semibold text-[var(--danger)]">Failed to load governance actions</p>
          <p className="text-[var(--text-secondary)] mt-1">{(error as Error).message}</p>
        </div>
      )}

      {/* Empty */}
      {!isLoading && !error && actions.length === 0 && (
        <div className="text-center py-12 text-[var(--text-tertiary)]">
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
          <Button
            variant="secondary"
            onClick={() => void fetchNextPage()}
            disabled={isFetchingNextPage}
          >
            {isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  );
}
