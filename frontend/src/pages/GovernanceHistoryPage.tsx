import type React from 'react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  useGovernanceHistory,
  useGovernanceStats,
} from '@/hooks/useGovernanceActions';
import { GovernanceActionCard } from '@/components/GovernanceActionCard';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import type { GovernanceAction, GovernanceActionStatus, GovernanceActionType } from '@/types';

/**
 * Governance History — comprehensive reference of every governance action
 * ever submitted to chain, from a single chronological feed.
 *
 * Differs from `/governance` (the lifecycle-tab list) in three ways:
 *  1. Single unified list, sorted by `submittedAt` desc, not bucketed.
 *  2. Summary panel up top: total count, by-status / by-type breakdowns,
 *     total ADA withdrawn from treasury (enacted only).
 *  3. Independent type + status filters, plus user-selectable sort.
 *
 * Pagination is page-side via "Load more" so the wire fetch stays single-
 * shot (4 parallel `/governance?status=…` calls). With ~109 actions today
 * the whole list is well under 1MB; we'll only need real pagination when
 * the chain crosses a couple hundred actions.
 */

const STATUS_FILTERS: Array<{
  id: GovernanceActionStatus | 'all';
  labelKey: string;
  glyph: string;
}> = [
  { id: 'all', labelKey: 'governanceHistory.filterAll', glyph: '·' },
  { id: 'enacted', labelKey: 'governanceHistory.filterEnacted', glyph: '✓' },
  { id: 'dropped', labelKey: 'governanceHistory.filterDropped', glyph: '✗' },
  { id: 'expired', labelKey: 'governanceHistory.filterExpired', glyph: '⏱' },
  { id: 'active', labelKey: 'governanceHistory.filterActive', glyph: '●' },
];

const TYPE_LABEL_KEYS: Record<GovernanceActionType, string> = {
  ParameterChange: 'governanceHistory.typeParameterChange',
  HardForkInitiation: 'governanceHistory.typeHardForkInitiation',
  TreasuryWithdrawals: 'governanceHistory.typeTreasuryWithdrawals',
  NoConfidence: 'governanceHistory.typeNoConfidence',
  UpdateCommittee: 'governanceHistory.typeUpdateCommittee',
  NewConstitution: 'governanceHistory.typeNewConstitution',
  InfoAction: 'governanceHistory.typeInfoAction',
};

type SortKey = 'recent' | 'lifecycle-epoch' | 'type' | 'yes-power';

const SORT_OPTIONS: Array<{ id: SortKey; labelKey: string }> = [
  { id: 'recent', labelKey: 'governanceHistory.sortRecent' },
  { id: 'lifecycle-epoch', labelKey: 'governanceHistory.sortLifecycleEpoch' },
  { id: 'type', labelKey: 'governanceHistory.sortType' },
  { id: 'yes-power', labelKey: 'governanceHistory.sortYesPower' },
];

const PAGE_SIZE = 20;

/** Compact ADA renderer for the headline tile — same logic as the
 *  dashboard widget, kept inline to avoid premature abstraction. */
function formatAdaCompact(lovelace: string | undefined): string {
  if (!lovelace) return '0 ₳';
  let n: bigint;
  try {
    n = BigInt(lovelace);
  } catch {
    return '0 ₳';
  }
  if (n === 0n) return '0 ₳';
  const ada = Number(n) / 1_000_000;
  const abs = Math.abs(ada);
  const fmt = (v: number, suffix: string): string => {
    const rounded = v < 10 ? v.toFixed(1) : Math.round(v).toString();
    return `${rounded.replace(/\.0$/, '')}${suffix} ₳`;
  };
  if (abs >= 1_000_000_000_000) return fmt(ada / 1_000_000_000_000, 'T');
  if (abs >= 1_000_000_000) return fmt(ada / 1_000_000_000, 'B');
  if (abs >= 1_000_000) return fmt(ada / 1_000_000, 'M');
  if (abs >= 1_000) return fmt(ada / 1_000, 'K');
  return `${Math.round(ada)} ₳`;
}

/** Best-effort epoch derived from the lifecycle slot. Newer actions use
 *  `epochDeadline` as the active proposal expiration — for non-active
 *  actions it stays as the original deadline. We don't currently surface
 *  enacted/dropped epoch separately on the row, so this sort uses the
 *  deadline epoch as a stable proxy. */
function lifecycleEpoch(a: GovernanceAction): number {
  return typeof a.epochDeadline === 'number' ? a.epochDeadline : 0;
}

/** Yes power as a fraction of totalActive across all role tallies. Returns
 *  -1 when the action has no votes data (sorts last under desc). */
function yesPowerFraction(a: GovernanceAction): number {
  if (!a.votes) return -1;
  const includeDrep = a.votingRoles?.drep ?? true;
  const includeSpo = a.votingRoles?.spo ?? true;
  const includeCc = a.votingRoles?.cc ?? true;
  let yes = 0n;
  let total = 0n;
  const parse = (s: string): bigint => {
    try {
      return BigInt(s);
    } catch {
      return 0n;
    }
  };
  if (includeDrep) {
    yes += parse(a.votes.drep.yes.power);
    total += parse(a.votes.drep.totalActive.power);
  }
  if (includeSpo) {
    yes += parse(a.votes.spo.yes.power);
    total += parse(a.votes.spo.totalActive.power);
  }
  if (includeCc) {
    yes += parse(a.votes.cc.yes.power);
    total += parse(a.votes.cc.totalActive.power);
  }
  if (total === 0n) return -1;
  // Convert to a small float ratio. Acceptable precision since this is
  // used only as a sort key, not for display.
  return Number((yes * 10_000n) / total) / 10_000;
}

export function GovernanceHistoryPage(): React.ReactElement {
  const { t } = useTranslation();
  const { data: stats, isLoading: statsLoading } = useGovernanceStats();
  const { data: history, isLoading: historyLoading, error } = useGovernanceHistory();

  const [statusFilter, setStatusFilter] = useState<GovernanceActionStatus | 'all'>('all');
  const [typeFilter, setTypeFilter] = useState<'all' | GovernanceActionType>('all');
  const [sortKey, setSortKey] = useState<SortKey>('recent');
  const [pageCount, setPageCount] = useState(1);

  const filtered = useMemo<GovernanceAction[]>(() => {
    const rows = (history ?? []).filter((a) => {
      if (statusFilter !== 'all' && a.status !== statusFilter) return false;
      if (typeFilter !== 'all' && a.actionType !== typeFilter) return false;
      return true;
    });
    const sorted = [...rows];
    switch (sortKey) {
      case 'recent':
        sorted.sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1));
        break;
      case 'lifecycle-epoch':
        sorted.sort((a, b) => lifecycleEpoch(b) - lifecycleEpoch(a));
        break;
      case 'type':
        sorted.sort((a, b) => a.actionType.localeCompare(b.actionType));
        break;
      case 'yes-power':
        sorted.sort((a, b) => yesPowerFraction(b) - yesPowerFraction(a));
        break;
    }
    return sorted;
  }, [history, statusFilter, typeFilter, sortKey]);

  // Reset pagination when the filter set narrows under the current page.
  const visibleCount = pageCount * PAGE_SIZE;
  const visible = filtered.slice(0, visibleCount);
  const hasMore = filtered.length > visibleCount;

  // Build the ordered "by type" breakdown for the summary line.
  const byTypeLabel = useMemo(() => {
    const entries = Object.entries(stats?.byType ?? {})
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1]);
    return entries
      .map(([type, count]) => {
        const key = TYPE_LABEL_KEYS[type as GovernanceActionType];
        const label = key ? t(key) : type;
        return `${count} ${label}`;
      })
      .join(' · ');
  }, [stats, t]);

  const earliestLabel = stats?.earliestSubmittedAt
    ? new Date(stats.earliestSubmittedAt).toLocaleDateString()
    : '—';
  const latestLabel = stats?.latestSubmittedAt
    ? new Date(stats.latestSubmittedAt).toLocaleDateString()
    : '—';

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <header className="space-y-1">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <h1 className="text-[26px] font-bold tracking-tight text-[var(--text-primary)]">
            {t('governanceHistory.title')}
          </h1>
          <Link
            to="/governance"
            className="text-sm text-[var(--brand-primary)] hover:underline"
          >
            {t('governanceHistory.backToLive')}
          </Link>
        </div>
        <p className="text-sm text-[var(--text-secondary)]">
          {t('governanceHistory.intro')}
        </p>
      </header>

      {/* Summary panel */}
      <section
        className={cn(
          'bg-[var(--bg-canvas)] border border-[var(--border-default)]',
          'rounded-token-xl shadow-token-sm p-5 space-y-3',
        )}
        aria-label={t('governanceHistory.summaryAriaLabel')}
      >
        <div className="flex items-baseline gap-3 flex-wrap">
          <span className="text-[28px] font-bold tabular-nums text-[var(--text-primary)] leading-none">
            {statsLoading ? '—' : stats?.total ?? 0}
          </span>
          <span className="text-[13px] text-[var(--text-secondary)]">
            {t('governanceHistory.actionsEverOnChain')}
          </span>
          {!statsLoading && stats?.earliestSubmittedAt && (
            <span className="text-[12.5px] text-[var(--text-tertiary)] ml-auto">
              {earliestLabel} – {latestLabel}
            </span>
          )}
        </div>

        {/* Status pills as filter buttons */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {STATUS_FILTERS.map((f) => {
            const count =
              f.id === 'all'
                ? stats?.total ?? 0
                : stats?.byStatus[f.id] ?? 0;
            const isActive = statusFilter === f.id;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => {
                  setStatusFilter(f.id);
                  setPageCount(1);
                }}
                className={cn(
                  'inline-flex items-center gap-1.5 px-3 py-1 rounded-token-full',
                  'text-[12.5px] font-medium tabular-nums',
                  'border transition-colors',
                  isActive
                    ? 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)]'
                    : 'bg-[var(--bg-canvas)] text-[var(--text-secondary)] border-[var(--border-default)] hover:bg-[var(--bg-muted)]',
                )}
                aria-pressed={isActive}
              >
                <span aria-hidden="true">{f.glyph}</span>
                {t(f.labelKey)}
                <span
                  className={cn(
                    'rounded-token-full px-1.5',
                    isActive
                      ? 'bg-white/20 text-white'
                      : 'bg-[var(--bg-muted)] text-[var(--text-tertiary)]',
                  )}
                >
                  {statsLoading ? '…' : count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="grid gap-3 sm:grid-cols-2 pt-1">
          <div>
            <div className="text-[11.5px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-0.5">
              {t('governanceHistory.treasuryWithdrawn')}
            </div>
            <div className="text-[18px] font-bold text-[var(--text-primary)] tabular-nums">
              {statsLoading ? '—' : formatAdaCompact(stats?.treasuryWithdrawnLovelace)}
            </div>
            <div className="text-[11.5px] text-[var(--text-tertiary)]">
              {t('governanceHistory.treasuryWithdrawnCaption')}
            </div>
          </div>
          <div>
            <div className="text-[11.5px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-0.5">
              {t('governanceHistory.byType')}
            </div>
            <div className="text-[12.5px] text-[var(--text-secondary)] tabular-nums leading-relaxed">
              {statsLoading ? '—' : byTypeLabel || t('governanceHistory.noActionsYet')}
            </div>
          </div>
        </div>
      </section>

      {/* Filter / sort row */}
      <div
        className={cn(
          'flex flex-wrap items-center gap-3',
          'text-[12.5px] text-[var(--text-secondary)]',
        )}
      >
        <label className="inline-flex items-center gap-2">
          <span className="text-[var(--text-tertiary)]">{t('governanceHistory.typeLabel')}</span>
          <select
            value={typeFilter}
            onChange={(e) => {
              setTypeFilter(e.target.value as 'all' | GovernanceActionType);
              setPageCount(1);
            }}
            className={cn(
              'h-8 px-2 rounded-token-md border',
              'border-[var(--border-default)] bg-[var(--bg-canvas)]',
              'text-[var(--text-primary)] focus-visible:outline-none focus-visible:shadow-token-focus',
            )}
          >
            <option value="all">{t('governanceHistory.allTypes')}</option>
            {(Object.keys(TYPE_LABEL_KEYS) as GovernanceActionType[]).map((type) => (
              <option key={type} value={type}>
                {t(TYPE_LABEL_KEYS[type])}
                {stats?.byType[type] != null ? ` (${stats.byType[type]})` : ''}
              </option>
            ))}
          </select>
        </label>

        <label className="inline-flex items-center gap-2">
          <span className="text-[var(--text-tertiary)]">{t('governanceHistory.sortLabel')}</span>
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            className={cn(
              'h-8 px-2 rounded-token-md border',
              'border-[var(--border-default)] bg-[var(--bg-canvas)]',
              'text-[var(--text-primary)] focus-visible:outline-none focus-visible:shadow-token-focus',
            )}
          >
            {SORT_OPTIONS.map((s) => (
              <option key={s.id} value={s.id}>
                {t(s.labelKey)}
              </option>
            ))}
          </select>
        </label>

        <span className="ml-auto text-[var(--text-tertiary)] tabular-nums">
          {t('governanceHistory.showingCount', {
            visible: visible.length,
            total: filtered.length,
          })}
        </span>
      </div>

      {/* Loading skeletons */}
      {historyLoading && (
        <ul className="space-y-2.5">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <li
              key={i}
              className="h-20 rounded-token-xl border border-[var(--border-default)] bg-[var(--bg-canvas)] animate-pulse"
            />
          ))}
        </ul>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-token-lg border border-[var(--danger)]/40 bg-[var(--danger-soft)] p-4 text-sm">
          <p className="font-semibold text-[var(--danger)]">
            {t('governanceHistory.loadFailed')}
          </p>
          <p className="text-[var(--text-secondary)] mt-1">
            {(error as Error).message}
          </p>
        </div>
      )}

      {/* Empty state */}
      {!historyLoading && !error && filtered.length === 0 && (
        <div className="text-center py-12 text-[var(--text-tertiary)]">
          <p>{t('governanceHistory.emptyState')}</p>
        </div>
      )}

      {/* List */}
      {visible.length > 0 && (
        <ul className="space-y-2.5">
          {visible.map((action) => (
            <li key={action.actionId}>
              <GovernanceActionCard action={action} />
            </li>
          ))}
        </ul>
      )}

      {/* Pagination */}
      {hasMore && (
        <div className="text-center pt-4">
          <Button variant="secondary" onClick={() => setPageCount((c) => c + 1)}>
            {t('governanceHistory.loadMore')}
          </Button>
        </div>
      )}
    </div>
  );
}
