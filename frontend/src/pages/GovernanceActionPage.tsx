import React from 'react';
import { useParams, Link } from 'react-router-dom';
import { useGovernanceAction } from '@/hooks/useGovernanceActions';
import { useComments } from '@/hooks/useComments';
import { CommentList } from '@/components/CommentList';
import { CommentForm } from '@/components/CommentForm';
import { epochsToDate, formatRelativeTime, cn } from '@/lib/utils';

const STATUS_CLASSES: Record<string, string> = {
  active: 'bg-green-100 text-green-800',
  expired: 'bg-gray-100 text-gray-600',
  enacted: 'bg-blue-100 text-blue-800',
  dropped: 'bg-red-100 text-red-700',
};

export function GovernanceActionPage(): React.ReactElement {
  const { actionId } = useParams<{ actionId: string }>();
  const { data: action, isLoading, error } = useGovernanceAction(actionId ?? '');
  const { data: commentsData, isLoading: commentsLoading } = useComments(actionId ?? '');

  if (isLoading) {
    return (
      <div className="max-w-3xl mx-auto space-y-4 animate-pulse">
        <div className="h-8 bg-muted rounded w-3/4" />
        <div className="h-4 bg-muted rounded w-1/2" />
        <div className="h-32 bg-muted rounded" />
      </div>
    );
  }

  if (error || !action) {
    return (
      <div className="text-center py-16">
        <h2 className="text-xl font-semibold mb-2">Governance action not found</h2>
        <Link to="/governance" className="text-primary hover:underline text-sm">
          Back to governance list
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Breadcrumb */}
      <nav className="text-sm text-muted-foreground">
        <Link to="/governance" className="hover:text-foreground">Governance</Link>
        <span className="mx-2">/</span>
        <span className="text-foreground truncate">{action.title}</span>
      </nav>

      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground font-medium">{action.actionType}</span>
          <span className={cn('text-xs font-medium px-2 py-0.5 rounded-full', STATUS_CLASSES[action.status] ?? '')}>
            {action.adminOverrideLabel ?? action.status}
          </span>
        </div>
        <h1 className="text-2xl font-bold">{action.title}</h1>
      </div>

      {/* Meta */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 rounded-lg border border-border bg-card p-4 text-sm">
        <div>
          <div className="text-xs text-muted-foreground mb-0.5">Submitted</div>
          <div>{formatRelativeTime(action.submittedAt)}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground mb-0.5">Epoch Deadline</div>
          <div>Epoch {action.epochDeadline} ({epochsToDate(action.epochDeadline)})</div>
        </div>
        {action.lastSyncedAt && (
          <div>
            <div className="text-xs text-muted-foreground mb-0.5">Last Synced</div>
            <div>{formatRelativeTime(action.lastSyncedAt)}</div>
          </div>
        )}
      </div>

      {/* Description */}
      <div className="rounded-lg border border-border bg-card p-4">
        <h2 className="font-semibold mb-2">Description</h2>
        <p className="text-sm text-foreground/90 whitespace-pre-wrap">{action.description}</p>
      </div>

      {/* Links */}
      {action.links && action.links.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-4">
          <h2 className="font-semibold mb-2">References</h2>
          <ul className="space-y-1">
            {action.links.map((link) => (
              <li key={link}>
                <a
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-primary hover:underline break-all"
                >
                  {link}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Comments */}
      <div className="space-y-4">
        <h2 className="text-xl font-semibold">
          Discussion
          {commentsData && (
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              ({commentsData.items.length})
            </span>
          )}
        </h2>
        <CommentForm actionId={actionId ?? ''} />
        <CommentList
          comments={commentsData?.items ?? []}
          actionId={actionId ?? ''}
          isLoading={commentsLoading}
        />
      </div>
    </div>
  );
}
