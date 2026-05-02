import React from 'react';
import { Link } from 'react-router-dom';
import type { GovernanceAction } from '@/types';
import { formatRelativeTime, epochsToDate, cn } from '@/lib/utils';

interface GovernanceActionCardProps {
  action: GovernanceAction;
  className?: string;
}

const STATUS_CLASSES: Record<GovernanceAction['status'], string> = {
  active: 'bg-green-100 text-green-800',
  expired: 'bg-gray-100 text-gray-600',
  enacted: 'bg-blue-100 text-blue-800',
  dropped: 'bg-red-100 text-red-700',
};

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
        'block rounded-lg border border-border bg-card p-4',
        'hover:border-primary/50 hover:shadow-sm transition-all',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-medium text-muted-foreground">
              {TYPE_LABELS[action.actionType]}
            </span>
            <span
              className={cn(
                'text-xs font-medium px-1.5 py-0.5 rounded-full',
                STATUS_CLASSES[action.status],
              )}
            >
              {action.adminOverrideLabel ?? action.status}
            </span>
          </div>
          <h3 className="font-semibold text-sm leading-tight line-clamp-2">{displayTitle(action)}</h3>
          {subtitle && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{subtitle}</p>
          )}
          <code
            className="mt-2 inline-block text-[10px] text-muted-foreground/70 font-mono"
            title={action.actionId}
          >
            {shortActionId(action.actionId)}
          </code>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
        <span>Submitted {formatRelativeTime(action.submittedAt)}</span>
        <span>
          Deadline: Epoch {action.epochDeadline} ({epochsToDate(action.epochDeadline)})
        </span>
      </div>
    </Link>
  );
}
