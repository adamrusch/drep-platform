import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Check, X, Clock, AlarmClock } from 'lucide-react';
import {
  useGovernanceHistory,
  useGovernanceStats,
} from '@/hooks/useGovernanceActions';
import { useFormatters } from '@/hooks/useFormatters';
import { cn } from '@/lib/utils';
import type { GovernanceActionStatus } from '@/types';

/**
 * Compact "Governance History" reference card surfaced on both dashboards.
 * Shows aggregate counts, total ADA withdrawn, and the last 5 actions of
 * any status. Clicking through goes to `/governance/history`.
 *
 * The widget is purely read-only and unauthenticated — it composes the
 * same `useGovernanceStats` / `useGovernanceHistory` hooks the full
 * history page uses, so the dashboard surface stays in sync with the
 * authoritative data.
 */

/** Format a stringified-BigInt lovelace amount as a compact ADA figure
 *  (e.g. "1.2B ₳", "832M ₳", "12.4K ₳"). The treasury figure is on the
 *  order of 10^15 lovelace = 10^9 ADA today, so we need at least the
 *  billions prefix; we go to trillions for headroom. Returns "0 ₳" for
 *  empty / unparseable input. */
function formatAdaCompact(lovelace: string | undefined): string {
  if (!lovelace) return '0 ₳';
  let n: bigint;
  try {
    n = BigInt(lovelace);
  } catch {
    return '0 ₳';
  }
  if (n === 0n) return '0 ₳';
  // Convert lovelace → ADA via Number once we're below ~1e15 lovelace
  // (which is well past Number safety past 2^53 = 9.007e15). Treasury
  // sums today are ~1.2e15 lovelace; we render with enough precision for
  // a header tile and accept the float rounding.
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

const STATUS_GLYPH: Record<GovernanceActionStatus, React.ReactNode> = {
  enacted: <Check size={12} strokeWidth={2.5} className="text-[var(--info)]" aria-hidden="true" />,
  dropped: <X size={12} strokeWidth={2.5} className="text-[var(--danger)]" aria-hidden="true" />,
  active: (
    <Clock
      size={12}
      strokeWidth={2.5}
      className="text-[var(--success)]"
      aria-hidden="true"
    />
  ),
  expired: (
    <AlarmClock
      size={12}
      strokeWidth={2.5}
      className="text-[var(--text-muted)]"
      aria-hidden="true"
    />
  ),
};

export function GovernanceHistoryWidget(): React.ReactElement {
  const { t } = useTranslation();
  const { formatRelativeTime } = useFormatters();
  const { data: stats, isLoading: statsLoading } = useGovernanceStats();
  const { data: history, isLoading: historyLoading } = useGovernanceHistory();

  const recent = (history ?? []).slice(0, 5);
  const total = stats?.total ?? 0;
  const enacted = stats?.byStatus.enacted ?? 0;
  const dropped = stats?.byStatus.dropped ?? 0;
  const expired = stats?.byStatus.expired ?? 0;
  const active = stats?.byStatus.active ?? 0;

  return (
    <div
      className={cn(
        'bg-[var(--bg-canvas)] border border-[var(--border-default)]',
        'rounded-token-xl shadow-token-sm p-5',
      )}
    >
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
          {t('historyWidget.title')}
        </h2>
        <Link
          to="/governance/history"
          className="inline-flex items-center gap-1 text-sm text-[var(--brand-primary)] hover:underline"
        >
          {t('historyWidget.viewAll')}
          <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
        </Link>
      </div>

      {/* Headline counts */}
      <div className="space-y-1.5 mb-4">
        <div className="text-[13px] text-[var(--text-secondary)]">
          {statsLoading ? (
            <span className="inline-block h-4 w-32 bg-[var(--bg-muted)] rounded animate-pulse" />
          ) : (
            <>
              <span className="font-semibold text-[var(--text-primary)] tabular-nums">
                {total}
              </span>{' '}
              {t('historyWidget.actionsEverOnChain')}
            </>
          )}
        </div>
        <div className="text-[12.5px] text-[var(--text-tertiary)] tabular-nums">
          {statsLoading ? (
            <span className="inline-block h-3.5 w-48 bg-[var(--bg-muted)] rounded animate-pulse" />
          ) : (
            <>
              {t('historyWidget.statusBreakdown', { enacted, dropped, expired, active })}
            </>
          )}
        </div>
        <div className="text-[12.5px] text-[var(--text-tertiary)] tabular-nums">
          {statsLoading ? (
            <span className="inline-block h-3.5 w-40 bg-[var(--bg-muted)] rounded animate-pulse" />
          ) : (
            <>
              <span className="font-semibold text-[var(--text-secondary)]">
                {formatAdaCompact(stats?.treasuryWithdrawnLovelace)}
              </span>{' '}
              {t('historyWidget.withdrawnFromTreasury')}
            </>
          )}
        </div>
      </div>

      {/* Recent activity list */}
      <div className="border-t border-[var(--border-subtle)] pt-3">
        <div className="text-[11.5px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-2">
          {t('historyWidget.recentActivity')}
        </div>
        {historyLoading ? (
          <ul className="space-y-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <li
                key={i}
                className="h-5 bg-[var(--bg-muted)] rounded animate-pulse"
              />
            ))}
          </ul>
        ) : recent.length === 0 ? (
          <div className="text-[12.5px] text-[var(--text-tertiary)] py-2">
            {t('historyWidget.noActionsYet')}
          </div>
        ) : (
          <ul className="space-y-1.5">
            {recent.map((action) => {
              const status = action.status as GovernanceActionStatus;
              const label =
                action.title && action.title.length > 0
                  ? action.title
                  : action.summary && action.summary.length > 0
                    ? action.summary
                    : action.actionType;
              return (
                <li key={action.actionId}>
                  <Link
                    to={`/governance/${encodeURIComponent(action.actionId)}`}
                    className="flex items-center gap-2 text-[12.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:underline"
                    title={t('historyWidget.itemTitle', {
                      status: t(`historyWidget.status.${status}`),
                      label,
                    })}
                  >
                    <span className="flex-shrink-0">{STATUS_GLYPH[status]}</span>
                    <span className="flex-1 truncate">{label}</span>
                    <span className="flex-shrink-0 text-[11.5px] text-[var(--text-muted)] tabular-nums">
                      {formatRelativeTime(action.submittedAt)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-3 pt-2">
          <Link
            to="/governance/history"
            className="inline-flex items-center gap-1 text-[12.5px] text-[var(--brand-primary)] hover:underline"
          >
            {t('historyWidget.viewFullHistory')}
            <ArrowRight size={12} strokeWidth={2} aria-hidden="true" />
          </Link>
        </div>
      </div>
    </div>
  );
}
