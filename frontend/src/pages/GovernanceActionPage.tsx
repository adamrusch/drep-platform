import React from 'react';
import { useParams, Link } from 'react-router-dom';
import { useGovernanceAction } from '@/hooks/useGovernanceActions';
import { useComments } from '@/hooks/useComments';
import { CommentList } from '@/components/CommentList';
import { CommentForm } from '@/components/CommentForm';
import { epochsToDate, formatRelativeTime, cn } from '@/lib/utils';
import type { GovernanceAction } from '@/types';

const STATUS_CLASSES: Record<string, string> = {
  active: 'bg-green-100 text-green-800',
  expired: 'bg-gray-100 text-gray-600',
  enacted: 'bg-blue-100 text-blue-800',
  dropped: 'bg-red-100 text-red-700',
};

function displayTitle(action: GovernanceAction): string {
  if (!action.title || action.title === action.actionId) {
    return 'Untitled governance action';
  }
  return action.title;
}

function isSafeReferenceUri(uri: string): boolean {
  // Allow http(s) and ipfs only — anchor metadata is untrusted user input.
  return /^(https?:|ipfs:)/i.test(uri);
}

/** Render multi-paragraph text safely as plain paragraphs (no HTML). */
function ProseBlock({ text }: { text: string }): React.ReactElement {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length === 0) {
    return <p className="text-sm text-foreground/90 whitespace-pre-wrap">{text}</p>;
  }
  return (
    <div className="space-y-3">
      {paragraphs.map((p, i) => (
        <p key={i} className="text-sm text-foreground/90 whitespace-pre-wrap">
          {p}
        </p>
      ))}
    </div>
  );
}

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

  const title = displayTitle(action);
  const hasAnchorIndicator = typeof action.anchorVerified === 'boolean';

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Breadcrumb */}
      <nav className="text-sm text-muted-foreground">
        <Link to="/governance" className="hover:text-foreground">
          Governance
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground truncate">{title}</span>
      </nav>

      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground font-medium">{action.actionType}</span>
          <span
            className={cn(
              'text-xs font-medium px-2 py-0.5 rounded-full',
              STATUS_CLASSES[action.status] ?? '',
            )}
          >
            {action.adminOverrideLabel ?? action.status}
          </span>
          {hasAnchorIndicator && action.anchorVerified ? (
            <span
              className="text-xs font-medium px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800"
              title="Anchor body matches the on-chain blake2b-256 hash"
            >
              Anchor verified
            </span>
          ) : hasAnchorIndicator ? (
            <span
              className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-800"
              title="Anchor body did not match the on-chain hash"
            >
              Anchor hash mismatch
            </span>
          ) : null}
        </div>
        <h1 className="text-2xl font-bold">{title}</h1>
        {action.summary && action.summary.length > 0 && (
          <p className="text-sm text-muted-foreground">{action.summary}</p>
        )}
        <code className="text-[11px] font-mono text-muted-foreground/80 break-all block">
          {action.actionId}
        </code>
      </div>

      {/* Meta */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 rounded-lg border border-border bg-card p-4 text-sm">
        <div>
          <div className="text-xs text-muted-foreground mb-0.5">Submitted</div>
          <div>{formatRelativeTime(action.submittedAt)}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground mb-0.5">Epoch Deadline</div>
          <div>
            Epoch {action.epochDeadline} ({epochsToDate(action.epochDeadline)})
          </div>
        </div>
        {action.lastSyncedAt && (
          <div>
            <div className="text-xs text-muted-foreground mb-0.5">Last Synced</div>
            <div>{formatRelativeTime(action.lastSyncedAt)}</div>
          </div>
        )}
      </div>

      {/* Abstract */}
      {action.abstract && (
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="font-semibold mb-2">Abstract</h2>
          <ProseBlock text={action.abstract} />
        </section>
      )}

      {/* Motivation */}
      {action.motivation && (
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="font-semibold mb-2">Motivation</h2>
          <ProseBlock text={action.motivation} />
        </section>
      )}

      {/* Rationale */}
      {action.rationale && (
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="font-semibold mb-2">Rationale</h2>
          <ProseBlock text={action.rationale} />
        </section>
      )}

      {/* On-chain details */}
      {action.details && action.details.length > 0 && (
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="font-semibold mb-2">On-chain Details</h2>
          <dl className="grid grid-cols-1 sm:grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
            {action.details.map((d, i) => (
              <React.Fragment key={`${d.label}-${i}`}>
                <dt className="text-muted-foreground">{d.label}</dt>
                <dd className="break-all font-mono text-xs sm:text-sm">{d.value}</dd>
              </React.Fragment>
            ))}
          </dl>
        </section>
      )}

      {/* Fallback description (only if no abstract/motivation/rationale) */}
      {!action.abstract && !action.motivation && !action.rationale && action.description && (
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="font-semibold mb-2">Description</h2>
          <ProseBlock text={action.description} />
        </section>
      )}

      {/* References */}
      {action.references && action.references.length > 0 && (
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="font-semibold mb-2">References</h2>
          <ul className="space-y-1">
            {action.references.map((ref, i) =>
              isSafeReferenceUri(ref.uri) ? (
                <li key={`${ref.uri}-${i}`}>
                  <a
                    href={ref.uri}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-primary hover:underline break-all"
                  >
                    {ref.label || ref.uri}
                  </a>
                </li>
              ) : (
                <li key={`${ref.uri}-${i}`} className="text-sm text-muted-foreground break-all">
                  {ref.label || ref.uri}{' '}
                  <span className="text-xs">(unsupported scheme)</span>
                </li>
              ),
            )}
          </ul>
        </section>
      )}

      {/* Anchor metadata footer */}
      {action.anchorUrl && (
        <section className="rounded-lg border border-border bg-card p-4 text-xs text-muted-foreground space-y-1">
          <div>
            <span className="font-medium">Anchor URL: </span>
            <span className="break-all">{action.anchorUrl}</span>
          </div>
          {action.anchorHash && (
            <div>
              <span className="font-medium">Anchor hash: </span>
              <span className="break-all font-mono">{action.anchorHash}</span>
            </div>
          )}
          {action.proposerAddress && (
            <div>
              <span className="font-medium">Deposit return address: </span>
              <span className="break-all font-mono">{action.proposerAddress}</span>
            </div>
          )}
        </section>
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
