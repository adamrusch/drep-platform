import React from 'react';
import { useParams, Link } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { useGovernanceAction } from '@/hooks/useGovernanceActions';
import { useComments } from '@/hooks/useComments';
import { CommentList } from '@/components/CommentList';
import { CommentForm } from '@/components/CommentForm';
import { Card } from '@/components/ui/Card';
import { StatusPill } from '@/components/ui/StatusPill';
import { epochsToDate, formatRelativeTime } from '@/lib/utils';
import type { GovernanceAction } from '@/types';

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
    return (
      <p className="text-sm text-[var(--text-secondary)] whitespace-pre-wrap leading-relaxed">
        {text}
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {paragraphs.map((p, i) => (
        <p
          key={i}
          className="text-sm text-[var(--text-secondary)] whitespace-pre-wrap leading-relaxed"
        >
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
        <div className="h-8 bg-[var(--bg-muted)] rounded w-3/4" />
        <div className="h-4 bg-[var(--bg-muted)] rounded w-1/2" />
        <div className="h-32 bg-[var(--bg-muted)] rounded" />
      </div>
    );
  }

  if (error || !action) {
    return (
      <div className="text-center py-16">
        <h2 className="text-xl font-semibold mb-2">Governance action not found</h2>
        <Link
          to="/governance"
          className="text-[var(--brand-primary)] hover:underline text-sm"
        >
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
      <nav className="crumbs">
        <Link
          to="/governance"
          className="flex items-center gap-1 hover:text-[var(--brand-primary)]"
        >
          <ChevronLeft size={14} strokeWidth={1.75} />
          <span>Governance</span>
        </Link>
        <span className="crumbs__sep">/</span>
        <span className="text-[var(--text-primary)] truncate">{title}</span>
      </nav>

      {/* Header */}
      <div className="space-y-2.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11.5px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
            {action.actionType}
          </span>
          <StatusPill
            status={action.status}
            label={action.adminOverrideLabel ?? undefined}
          />
          {hasAnchorIndicator && action.anchorVerified ? (
            <StatusPill status="passed" label="Anchor verified" />
          ) : hasAnchorIndicator ? (
            <StatusPill status="warning" label="Anchor mismatch" />
          ) : null}
        </div>
        <h1 className="text-[26px] font-bold leading-tight tracking-tight text-[var(--text-primary)]">
          {title}
        </h1>
        {action.summary && action.summary.length > 0 && (
          <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
            {action.summary}
          </p>
        )}
        <code className="text-[11px] font-mono text-[var(--text-muted)] break-all block">
          {action.actionId}
        </code>
      </div>

      {/* Meta strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 rounded-token-lg border border-[var(--border-default)] bg-[var(--bg-subtle)] p-4 text-sm">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-0.5">
            Submitted
          </div>
          <div className="font-medium text-[var(--text-primary)]">
            {formatRelativeTime(action.submittedAt)}
          </div>
        </div>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-0.5">
            Epoch Deadline
          </div>
          <div className="font-medium text-[var(--text-primary)]">
            Epoch {action.epochDeadline} ({epochsToDate(action.epochDeadline)})
          </div>
        </div>
        {action.lastSyncedAt && (
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-0.5">
              Last Synced
            </div>
            <div className="font-medium text-[var(--text-primary)]">
              {formatRelativeTime(action.lastSyncedAt)}
            </div>
          </div>
        )}
      </div>

      {/* Abstract */}
      {action.abstract && (
        <Card>
          <h2 className="font-semibold text-[15px] mb-2 text-[var(--text-primary)]">
            Abstract
          </h2>
          <ProseBlock text={action.abstract} />
        </Card>
      )}

      {/* Motivation */}
      {action.motivation && (
        <Card>
          <h2 className="font-semibold text-[15px] mb-2 text-[var(--text-primary)]">
            Motivation
          </h2>
          <ProseBlock text={action.motivation} />
        </Card>
      )}

      {/* Rationale */}
      {action.rationale && (
        <Card>
          <h2 className="font-semibold text-[15px] mb-2 text-[var(--text-primary)]">
            Rationale
          </h2>
          <ProseBlock text={action.rationale} />
        </Card>
      )}

      {/* On-chain details */}
      {action.details && action.details.length > 0 && (
        <Card>
          <h2 className="font-semibold text-[15px] mb-2 text-[var(--text-primary)]">
            On-chain Details
          </h2>
          <dl className="grid grid-cols-1 sm:grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
            {action.details.map((d, i) => (
              <React.Fragment key={`${d.label}-${i}`}>
                <dt className="text-[var(--text-tertiary)]">{d.label}</dt>
                <dd className="break-all font-mono text-xs sm:text-sm text-[var(--text-primary)]">
                  {d.value}
                </dd>
              </React.Fragment>
            ))}
          </dl>
        </Card>
      )}

      {/* Fallback description (only if no abstract/motivation/rationale) */}
      {!action.abstract && !action.motivation && !action.rationale && action.description && (
        <Card>
          <h2 className="font-semibold text-[15px] mb-2 text-[var(--text-primary)]">
            Description
          </h2>
          <ProseBlock text={action.description} />
        </Card>
      )}

      {/* References */}
      {action.references && action.references.length > 0 && (
        <Card>
          <h2 className="font-semibold text-[15px] mb-2 text-[var(--text-primary)]">
            References
          </h2>
          <ul className="space-y-1.5">
            {action.references.map((ref, i) =>
              isSafeReferenceUri(ref.uri) ? (
                <li key={`${ref.uri}-${i}`}>
                  <a
                    href={ref.uri}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-[var(--brand-primary)] hover:underline break-all"
                  >
                    {ref.label || ref.uri}
                  </a>
                </li>
              ) : (
                <li
                  key={`${ref.uri}-${i}`}
                  className="text-sm text-[var(--text-tertiary)] break-all"
                >
                  {ref.label || ref.uri}{' '}
                  <span className="text-xs">(unsupported scheme)</span>
                </li>
              ),
            )}
          </ul>
        </Card>
      )}

      {/* Anchor metadata footer */}
      {action.anchorUrl && (
        <Card className="text-xs text-[var(--text-tertiary)] space-y-1">
          <div>
            <span className="font-medium text-[var(--text-secondary)]">Anchor URL: </span>
            <span className="break-all">{action.anchorUrl}</span>
          </div>
          {action.anchorHash && (
            <div>
              <span className="font-medium text-[var(--text-secondary)]">Anchor hash: </span>
              <span className="break-all font-mono">{action.anchorHash}</span>
            </div>
          )}
          {action.proposerAddress && (
            <div>
              <span className="font-medium text-[var(--text-secondary)]">
                Deposit return address:{' '}
              </span>
              <span className="break-all font-mono">{action.proposerAddress}</span>
            </div>
          )}
        </Card>
      )}

      {/* Comments */}
      <div className="space-y-4 pt-2">
        <h2 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">
          Discussion
          {commentsData && (
            <span className="ml-2 text-sm font-normal text-[var(--text-tertiary)]">
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
