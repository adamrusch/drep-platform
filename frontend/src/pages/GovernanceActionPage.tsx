import React from 'react';
import { useParams, Link } from 'react-router-dom';
import { ChevronLeft, Lock } from 'lucide-react';
import * as Tabs from '@radix-ui/react-tabs';
import { useGovernanceAction } from '@/hooks/useGovernanceActions';
import { useComments } from '@/hooks/useComments';
import { CommentList } from '@/components/CommentList';
import { CommentForm } from '@/components/CommentForm';
import { SentimentBlock } from '@/components/SentimentBlock';
import { Card } from '@/components/ui/Card';
import { StatusPill } from '@/components/ui/StatusPill';
import { cn, epochsToDate, formatRelativeTime } from '@/lib/utils';
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

const TAB_TRIGGER_CLASSES = cn(
  'relative px-3 py-2.5 text-[13px] font-medium text-[var(--text-secondary)]',
  'hover:text-[var(--text-primary)] transition-colors',
  'data-[state=active]:text-[var(--brand-primary)] data-[state=active]:font-semibold',
  'data-[state=active]:after:absolute data-[state=active]:after:left-0 data-[state=active]:after:right-0 data-[state=active]:after:-bottom-px',
  'data-[state=active]:after:h-[2px] data-[state=active]:after:bg-[var(--brand-primary)]',
  'focus-visible:outline-none focus-visible:shadow-token-focus rounded-token-sm',
);

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
  const commentCount = commentsData?.items.length ?? 0;

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

      {/* Tabs */}
      <Tabs.Root defaultValue="overview" className="space-y-5">
        <Tabs.List
          className={cn(
            'flex items-end gap-1 border-b border-[var(--border-default)]',
            'overflow-x-auto -mb-px',
          )}
          aria-label="Governance action sections"
        >
          <Tabs.Trigger value="overview" className={TAB_TRIGGER_CLASSES}>
            Overview
          </Tabs.Trigger>
          <Tabs.Trigger value="comments" className={TAB_TRIGGER_CLASSES}>
            Public Comments
            {commentCount > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-token-full bg-[var(--bg-muted)] text-[11px] font-semibold text-[var(--text-tertiary)] tabular-nums">
                {commentCount}
              </span>
            )}
          </Tabs.Trigger>
          <Tabs.Trigger value="rationale" className={TAB_TRIGGER_CLASSES}>
            Rationale
          </Tabs.Trigger>
          <Tabs.Trigger value="clubhouse" className={TAB_TRIGGER_CLASSES}>
            Delegator Clubhouse
          </Tabs.Trigger>
        </Tabs.List>

        {/* OVERVIEW */}
        <Tabs.Content value="overview" className="space-y-6 focus-visible:outline-none">
          {/* On-Chain Votes block */}
          <Card>
            {action.votes ? (
              <SentimentBlock
                title="On-Chain Votes"
                caption="DRep / SPO / Constitutional Committee"
                tally={action.votes}
              />
            ) : (
              <div className="py-8 text-center text-sm text-[var(--text-tertiary)]">
                <div className="font-semibold text-[var(--text-primary)] mb-1">
                  Vote tallies will appear after the next sync
                </div>
                <div>
                  This action has not been re-enriched with on-chain vote data yet.
                </div>
              </div>
            )}
          </Card>

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
        </Tabs.Content>

        {/* PUBLIC COMMENTS */}
        <Tabs.Content value="comments" className="space-y-4 focus-visible:outline-none">
          <CommentForm actionId={actionId ?? ''} />
          <CommentList
            comments={commentsData?.items ?? []}
            actionId={actionId ?? ''}
            isLoading={commentsLoading}
          />
        </Tabs.Content>

        {/* RATIONALE */}
        <Tabs.Content value="rationale" className="space-y-4 focus-visible:outline-none">
          {action.rationale ? (
            <Card>
              <ProseBlock text={action.rationale} />
            </Card>
          ) : (
            <Card>
              <div className="py-6 text-center text-sm text-[var(--text-tertiary)]">
                No rationale published for this action.
              </div>
            </Card>
          )}
        </Tabs.Content>

        {/* DELEGATOR CLUBHOUSE */}
        <Tabs.Content value="clubhouse" className="focus-visible:outline-none">
          <Card>
            <div className="py-10 text-center">
              <Lock
                size={28}
                strokeWidth={1.75}
                aria-hidden="true"
                className="mx-auto mb-3 text-[var(--text-muted)]"
              />
              <div className="font-semibold text-[var(--text-primary)] mb-1">
                Delegator clubhouse — coming soon
              </div>
              <p className="text-sm text-[var(--text-tertiary)] max-w-md mx-auto">
                Per-DRep clubhouse threads tied to this governance action will land in a
                future release. For now, public discussion happens in the Public Comments
                tab.
              </p>
            </div>
          </Card>
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}
