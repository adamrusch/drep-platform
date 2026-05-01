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

export function GovernanceActionCard({ action, className }: GovernanceActionCardProps): React.ReactElement {
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
          <h3 className="font-semibold text-sm leading-tight truncate">{action.title}</h3>
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{action.description}</p>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
        <span>Submitted {formatRelativeTime(action.submittedAt)}</span>
        <span>Deadline: Epoch {action.epochDeadline} ({epochsToDate(action.epochDeadline)})</span>
      </div>
    </Link>
  );
}
