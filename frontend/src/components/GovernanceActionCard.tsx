import React from 'react';
import { Link } from 'react-router-dom';
import type { GovernanceAction, VoteTally } from '@/types';
import { formatRelativeTime, epochsToDate, cn } from '@/lib/utils';
import { StatusPill } from '@/components/ui/StatusPill';
import { SentimentBar } from '@/components/ui/SentimentBar';

function tallyTotals(votes: VoteTally): { yes: number; no: number; abstain: number; total: number } {
  const yes = votes.drep.yes + votes.spo.yes + votes.cc.yes;
  const no = votes.drep.no + votes.spo.no + votes.cc.no;
  const abstain = votes.drep.abstain + votes.spo.abstain + votes.cc.abstain;
  return { yes, no, abstain, total: yes + no + abstain };
}

interface GovernanceActionCardProps {
  action: GovernanceAction;
  className?: string;
}

const TYPE_LABELS: Record<GovernanceAction['actionType'], string> = {
  ParameterChange: 'Parameter Change',
  HardForkInitiation: 'Hard Fork',
  TreasuryWithdrawals: 'Treasury',
  NoConfidence: 'No Confidence',
  UpdateCommittee: 'Update Committee',
  NewConstitution: 'New Constitution',
  InfoAction: 'Info',
};

/**
 * If the title is just the bare actionId hash (sync hasn't enriched the
 * record yet), display "Untitled action" so users don't see a 64-char hex
 * blob as the prominent header.
 */
function displayTitle(action: GovernanceAction): string {
  if (!action.title || action.title === action.actionId) {
    return 'Untitled governance action';
  }
  return action.title;
}

function shortActionId(actionId: string): string {
  const [hash, idx] = actionId.split('#');
  if (!hash) return actionId;
  return `${hash.slice(0, 8)}…${hash.slice(-4)}#${idx ?? '0'}`;
}

export function GovernanceActionCard({
  action,
  className,
}: GovernanceActionCardProps): React.ReactElement {
  const subtitle = action.summary && action.summary.length > 0 ? action.summary : action.description;
  return (
    <Link
      to={`/governance/${encodeURIComponent(action.actionId)}`}
      className={cn(
        // Card chrome — design system spec, NOT the harsh hand-rolled border.
        'block bg-[var(--bg-canvas)] border border-[var(--border-default)]',
        'rounded-token-xl shadow-token-sm p-5',
        'transition-all duration-150',
        'hover:border-[var(--border-strong)] hover:shadow-token-md hover:-translate-y-px',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <span className="text-[11.5px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
              {TYPE_LABELS[action.actionType]}
            </span>
            <StatusPill
              status={action.status}
              label={action.adminOverrideLabel ?? undefined}
            />
          </div>
          <h3 className="font-semibold text-[15px] leading-snug line-clamp-2 text-[var(--text-primary)] tracking-tight">
            {displayTitle(action)}
          </h3>
          {subtitle && (
            <p className="text-[13px] text-[var(--text-secondary)] mt-1.5 line-clamp-2 leading-relaxed">
              {subtitle}
            </p>
          )}
          <code
            className="mt-2.5 inline-block text-[11px] text-[var(--text-muted)] font-mono"
            title={action.actionId}
          >
            {shortActionId(action.actionId)}
          </code>
        </div>
      </div>

      <div className="mt-3 pt-3 border-t border-[var(--border-subtle)] flex items-center justify-between gap-4 text-[11.5px] text-[var(--text-tertiary)] tabular-nums">
        <span className="flex-shrink-0">Submitted {formatRelativeTime(action.submittedAt)}</span>
        {action.votes && tallyTotals(action.votes).total > 0 ? (
          <div className="flex-1 max-w-[180px]">
            <SentimentBar
              yes={action.votes.drep.yes + action.votes.spo.yes + action.votes.cc.yes}
              no={action.votes.drep.no + action.votes.spo.no + action.votes.cc.no}
              abstain={
                action.votes.drep.abstain + action.votes.spo.abstain + action.votes.cc.abstain
              }
              height={6}
            />
          </div>
        ) : null}
        <span className="flex-shrink-0">
          Epoch {action.epochDeadline} ({epochsToDate(action.epochDeadline)})
        </span>
      </div>
    </Link>
  );
}
