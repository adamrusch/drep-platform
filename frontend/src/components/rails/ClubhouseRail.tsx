import React from 'react';
import { Sparkles, Users } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';

const SoonPill = (): React.ReactElement => (
  <span className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-token-full bg-[var(--bg-muted)] text-[var(--text-tertiary)]">
    Soon
  </span>
);

/**
 * Right-rail for the Delegator Clubhouse. Mirrors the chrome from
 * `clubhouse.jsx:358–467` (ClubhouseRail) but with placeholder data —
 * the real per-DRep activity stream + contributor leaderboard isn't
 * wired up yet, but the design layout needs to be visible.
 */
export function ClubhouseRail(): React.ReactElement {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>
            <Sparkles size={14} strokeWidth={2} className="text-[var(--brand-primary)]" />
            Active threads
          </CardTitle>
          <SoonPill />
        </CardHeader>
        <ul className="space-y-3 text-sm">
          {[
            'Treasury withdrawal milestones',
            'Constitutional update feedback',
            'Stake-weighted committee votes',
          ].map((thread) => (
            <li
              key={thread}
              className="flex items-start justify-between gap-2 text-[var(--text-secondary)]"
            >
              <span className="truncate">{thread}</span>
              <span className="text-[11px] text-[var(--text-tertiary)] tabular-nums flex-shrink-0">
                —
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <Users size={14} strokeWidth={2} className="text-[var(--brand-primary)]" />
            Top contributors
          </CardTitle>
          <SoonPill />
        </CardHeader>
        <ol className="space-y-2.5 text-sm">
          {[
            { rank: 1, name: 'LUCID_STAKER', count: 48 },
            { rank: 2, name: 'block_Architect', count: 36 },
            { rank: 3, name: 'ada_pioneer', count: 29 },
          ].map((c) => (
            <li key={c.rank} className="flex items-center gap-3">
              <span className="text-[11px] font-semibold text-[var(--text-tertiary)] w-4 tabular-nums">
                {c.rank}
              </span>
              <span className="w-7 h-7 rounded-token-full bg-[var(--brand-primary-soft)] text-[var(--brand-primary)] flex items-center justify-center text-[11px] font-semibold flex-shrink-0">
                {c.name.slice(0, 2).toUpperCase()}
              </span>
              <span className="flex-1 truncate text-[var(--text-secondary)]">{c.name}</span>
              <span className="text-[11px] tabular-nums text-[var(--text-tertiary)]">{c.count}</span>
            </li>
          ))}
        </ol>
      </Card>
    </>
  );
}
