import React from 'react';
import { Link } from 'react-router-dom';
import { Calendar, Link2 } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { useGovernanceActions } from '@/hooks/useGovernanceActions';
import { formatRelativeTime } from '@/lib/utils';
import type { GovernanceAction } from '@/types';

const SoonPill = (): React.ReactElement => (
  <span className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-token-full bg-[var(--bg-muted)] text-[var(--text-tertiary)]">
    Soon
  </span>
);

interface ProposalRailProps {
  action: GovernanceAction;
}

/**
 * Right-rail for the Proposal Detail page (`GovernanceActionPage`).
 *
 *  1. On-chain timeline — submitted → ratified/dropped milestones,
 *     uses real `submittedAt` and `epochDeadline` from the action.
 *  2. Related proposals — top 3 active actions of the same `actionType`
 *     (excluding the current one). Real data when available.
 *
 * Mirrors `governance.jsx:346–423` in spirit. The "Cast Vote" card is
 * deliberately *not* in the rail — it lives next to the title via the
 * Cast Vote modal trigger button.
 */
export function ProposalRail({ action }: ProposalRailProps): React.ReactElement {
  const { data: relatedData } = useGovernanceActions('active');
  const related = (relatedData?.pages ?? [])
    .flatMap((p) => p.items)
    .filter(
      (a) => a.actionType === action.actionType && a.actionId !== action.actionId,
    )
    .slice(0, 3);

  // Build timeline events deterministically from the on-chain fields we have.
  const events = [
    {
      label: 'Submitted',
      detail: formatRelativeTime(action.submittedAt),
      done: true,
      color: 'var(--brand-primary)',
    },
    {
      label: 'Voting open',
      detail: action.status === 'active' ? 'Now' : '—',
      done: action.status !== 'active' && action.status !== 'expired',
      color: 'var(--brand-accent)',
    },
    {
      label:
        action.status === 'enacted'
          ? 'Ratified'
          : action.status === 'dropped' || action.status === 'expired'
            ? 'Dropped'
            : 'Decision',
      detail: `Epoch ${action.epochDeadline}`,
      done: action.status === 'enacted' || action.status === 'dropped' || action.status === 'expired',
      color:
        action.status === 'enacted'
          ? 'var(--success)'
          : action.status === 'dropped' || action.status === 'expired'
            ? 'var(--danger)'
            : 'var(--text-tertiary)',
    },
  ];

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>
            <Calendar size={14} strokeWidth={2} className="text-[var(--brand-primary)]" />
            On-chain timeline
          </CardTitle>
        </CardHeader>
        <ol className="space-y-3 ml-2">
          {events.map((e, i) => (
            <li key={i} className="flex items-start gap-3">
              <span
                className="mt-1 w-3 h-3 rounded-full border-2 flex-shrink-0"
                style={{
                  borderColor: e.color,
                  background: e.done ? e.color : 'transparent',
                }}
                aria-hidden="true"
              />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-[var(--text-primary)]">
                  {e.label}
                </div>
                <div className="text-[11.5px] text-[var(--text-tertiary)] tabular-nums">
                  {e.detail}
                </div>
              </div>
            </li>
          ))}
        </ol>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <Link2 size={14} strokeWidth={2} className="text-[var(--brand-primary)]" />
            Related proposals
          </CardTitle>
          {related.length === 0 && <SoonPill />}
        </CardHeader>
        {related.length === 0 ? (
          <p className="text-[12.5px] text-[var(--text-tertiary)]">
            No other active proposals of this type right now.
          </p>
        ) : (
          <ul className="space-y-2.5">
            {related.map((r) => (
              <li key={r.actionId}>
                <Link
                  to={`/governance/${encodeURIComponent(r.actionId)}`}
                  className="block text-[13px] text-[var(--text-primary)] hover:text-[var(--brand-primary)] hover:underline truncate"
                >
                  {r.title || r.summary || 'Untitled action'}
                </Link>
                <div className="text-[11px] text-[var(--text-tertiary)]">
                  Epoch {r.epochDeadline}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
