import React from 'react';
import { Activity, BarChart3, RefreshCw } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { useEpoch } from '@/hooks/useEpoch';

const SoonPill = (): React.ReactElement => (
  <span className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-token-full bg-[var(--bg-muted)] text-[var(--text-tertiary)]">
    Soon
  </span>
);

interface ActivityItem {
  kind: 'vote' | 'comment' | 'sync';
  text: string;
  time: string;
  color: string;
}

const PLACEHOLDER_ACTIVITY: ActivityItem[] = [
  { kind: 'vote', text: 'You haven\'t voted this epoch yet', time: 'now', color: 'var(--brand-primary)' },
  { kind: 'comment', text: 'No comments posted recently', time: '—', color: 'var(--brand-accent)' },
  { kind: 'sync', text: 'Awaiting next on-chain sync', time: '—', color: 'var(--text-tertiary)' },
  { kind: 'vote', text: 'Past activity will appear here', time: '—', color: 'var(--text-muted)' },
  { kind: 'comment', text: 'Wallet must be connected to track', time: '—', color: 'var(--text-muted)' },
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
  const { data: epoch } = useEpoch();

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>
            <BarChart3 size={14} strokeWidth={2} className="text-[var(--brand-primary)]" />
            Your votes this epoch
          </CardTitle>
          <SoonPill />
        </CardHeader>
        <div className="grid grid-cols-3 gap-3 text-center">
          {[
            { label: 'Yes', value: '0', color: 'var(--success)' },
            { label: 'No', value: '0', color: 'var(--danger)' },
            { label: 'Abstain', value: '0', color: 'var(--text-tertiary)' },
          ].map((s) => (
            <div
              key={s.label}
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
            Recent activity
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
                {a.text}
              </span>
              <span className="text-[11px] text-[var(--text-tertiary)] tabular-nums flex-shrink-0">
                {a.time}
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <RefreshCw size={14} strokeWidth={2} className="text-[var(--brand-primary)]" />
            Sync info
          </CardTitle>
        </CardHeader>
        <dl className="space-y-1.5 text-sm">
          <div className="flex justify-between">
            <dt className="text-[var(--text-tertiary)]">Network</dt>
            <dd className="font-medium text-[var(--text-primary)]">Mainnet</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-[var(--text-tertiary)]">Current epoch</dt>
            <dd className="font-medium text-[var(--text-primary)] tabular-nums">
              {epoch?.epoch ?? '—'}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-[var(--text-tertiary)]">Source</dt>
            <dd className="font-medium text-[var(--text-primary)]">Blockfrost</dd>
          </div>
        </dl>
      </Card>
    </>
  );
}
