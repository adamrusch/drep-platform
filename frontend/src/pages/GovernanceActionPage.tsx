import React from 'react';
import { useParams, Link } from 'react-router-dom';
import { ChevronLeft, ExternalLink, Lock, Share2, Vote } from 'lucide-react';
import * as Tabs from '@radix-ui/react-tabs';
import { useGovernanceAction } from '@/hooks/useGovernanceActions';
import { useComments } from '@/hooks/useComments';
import { CommentList } from '@/components/CommentList';
import { CommentForm } from '@/components/CommentForm';
import { SentimentBlock } from '@/components/SentimentBlock';
import { Card } from '@/components/ui/Card';
import { Markdown } from '@/components/ui/Markdown';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import { CastVoteModal } from '@/components/governance/CastVoteModal';
import { ShareModal } from '@/components/governance/ShareModal';
import { ProposalRail } from '@/components/rails/ProposalRail';
import { PageWithRail } from '@/components/Layout';
import { useAuthStore } from '@/stores/authStore';
import { useUiStore } from '@/stores/uiStore';
import { cn, epochsToDate, formatRelativeTime } from '@/lib/utils';
import type { GovernanceAction } from '@/types';

/** Header title slot. The page also renders a fallback (synthesized
 *  summary or italic placeholder) when this returns null.
 *
 *  Until the backend re-enriches (gated on Blockfrost daily quota), some
 *  rows still carry a legacy synthetic `title` matching the on-chain
 *  summary or the bare actionId. Treat those as "no anchor" so the UI
 *  reflects the intended Title / Type / Hash / Metadata separation in
 *  both the new and old data shapes. */
function displayTitle(action: GovernanceAction): string | null {
  if (typeof action.title !== 'string' || action.title.length === 0) return null;
  // Pillar-sourced titles are real off-chain titles — never treat them as
  // legacy synthetic placeholders even though `anchorUrl` is absent.
  if (action.metadataSource === 'proposal-pillar') return action.title;
  if (!action.anchorUrl) {
    if (action.title === action.actionId) return null;
    if (action.summary && action.title === action.summary) return null;
  }
  return action.title;
}

/** Build adastat / cardanoscan URLs. Percent-encode the `#` separator. */
function explorerUrls(actionId: string): { adastat: string; cardanoscan: string } {
  const encoded = actionId.replace('#', '%23');
  return {
    adastat: `https://adastat.net/governances/${encoded}`,
    cardanoscan: `https://cardanoscan.io/governanceAction/${encoded}`,
  };
}

function isSafeReferenceUri(uri: string): boolean {
  // Allow http(s) and ipfs only — anchor metadata is untrusted user input.
  return /^(https?:|ipfs:)/i.test(uri);
}

/** Render synthesized plain text — used only for the on-chain Description
 *  fallback, which is a string we generate ourselves (not user content).
 *  CIP anchor body fields (Abstract / Motivation / Rationale) flow through
 *  the `Markdown` component instead, which sanitizes HTML and parses real
 *  Markdown (headings, lists, links, code blocks). */
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
  const roles = useAuthStore((s) => s.roles);
  const canVote = roles.includes('lead_drep') || roles.includes('committee_member');
  // ⚠ All hooks must be called above the conditional returns below.
  // React's rules-of-hooks: every render must call the same number of
  // hooks in the same order. Calling useUiStore after early returns
  // produces React error #310 (Rendered more hooks than during the
  // previous render) the moment isLoading flips from true to false.
  const addToast = useUiStore((s) => s.addToast);

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
  // Share / breadcrumb fallback. If there's no anchor title, prefer the
  // synthesized summary; if even that's missing, fall back to a generic
  // label so we never blast the raw 64-char hash into a share dialog.
  const shareTitle =
    title ??
    (action.summary && action.summary.length > 0 ? action.summary : 'Governance action');
  const hasAnchorIndicator = typeof action.anchorVerified === 'boolean';
  const commentCount = commentsData?.items.length ?? 0;
  const proposalUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/governance/${encodeURIComponent(action.actionId)}`
      : `https://drep.tools/governance/${encodeURIComponent(action.actionId)}`;
  const explorers = explorerUrls(action.actionId);
  const handleCopyHash = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(action.actionId);
      addToast({ title: 'Hash copied', variant: 'success' });
    } catch {
      addToast({ title: 'Copy failed', variant: 'error' });
    }
  };

  const center = (
    <>
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
        <span className="text-[var(--text-primary)] truncate">{shareTitle}</span>
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
          {action.metadataSource === 'proposal-pillar' && (
            <StatusPill
              status="discussion"
              label="Discussion forum"
              title="Title and abstract sourced from gov.tools proposal-discussion forum (no on-chain anchor)"
            />
          )}
          <span className="ml-auto flex items-center gap-1.5">
            {action.anchorUrl && (
              <a
                href={action.anchorUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[12px] text-[var(--text-tertiary)] hover:text-[var(--brand-primary)] hover:underline"
                title={action.anchorUrl}
              >
                Metadata
                <ExternalLink size={12} strokeWidth={2} aria-hidden="true" />
              </a>
            )}
            {canVote && action.status === 'active' && (
              <CastVoteModal
                actionTitle={shareTitle}
                trigger={
                  <Button variant="primary" size="sm">
                    <Vote size={14} strokeWidth={2} />
                    Cast Vote
                  </Button>
                }
              />
            )}
            <ShareModal
              url={proposalUrl}
              title={shareTitle}
              trigger={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Share proposal"
                  title="Share proposal"
                >
                  <Share2 size={16} strokeWidth={1.75} />
                </Button>
              }
            />
          </span>
        </div>
        {/* Title slot: anchor title in bold; italic muted placeholder when
            absent. The synthesized on-chain summary lives below as a
            subtitle in either case. */}
        {title ? (
          <h1 className="text-[26px] font-bold leading-tight tracking-tight text-[var(--text-primary)]">
            {title}
          </h1>
        ) : (
          <h1 className="text-[20px] italic font-medium leading-tight text-[var(--text-tertiary)]">
            (No off-chain metadata)
          </h1>
        )}
        {action.summary && action.summary.length > 0 && (
          <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
            {action.summary}
          </p>
        )}
        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={() => void handleCopyHash()}
            title={`Click to copy: ${action.actionId}`}
            className={cn(
              'text-[11px] font-mono text-[var(--text-muted)] break-all',
              'hover:text-[var(--brand-primary)] text-left',
              'rounded-token-sm focus-visible:outline-none focus-visible:shadow-token-focus',
            )}
          >
            {action.actionId}
          </button>
          <a
            href={explorers.adastat}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11.5px] text-[var(--text-tertiary)] hover:text-[var(--brand-primary)] hover:underline"
          >
            adastat
            <ExternalLink size={11} strokeWidth={2} aria-hidden="true" />
          </a>
          <a
            href={explorers.cardanoscan}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11.5px] text-[var(--text-tertiary)] hover:text-[var(--brand-primary)] hover:underline"
          >
            cardanoscan
            <ExternalLink size={11} strokeWidth={2} aria-hidden="true" />
          </a>
          {action.proposalPillarUrl && (
            <a
              href={action.proposalPillarUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[11.5px] text-[var(--text-tertiary)] hover:text-[var(--brand-primary)] hover:underline"
              title="View discussion thread on gov.tools"
            >
              View discussion thread
              <ExternalLink size={11} strokeWidth={2} aria-hidden="true" />
            </a>
          )}
        </div>
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
                votingRoles={action.votingRoles}
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

          {/* Abstract — anchor body content; render as Markdown. */}
          {action.abstract && (
            <Card>
              <h2 className="font-semibold text-[15px] mb-2 text-[var(--text-primary)]">
                Abstract
              </h2>
              <Markdown>{action.abstract}</Markdown>
            </Card>
          )}

          {/* Motivation — anchor body content; render as Markdown. */}
          {action.motivation && (
            <Card>
              <h2 className="font-semibold text-[15px] mb-2 text-[var(--text-primary)]">
                Motivation
              </h2>
              <Markdown>{action.motivation}</Markdown>
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

        {/* RATIONALE — anchor body content; render as Markdown. */}
        <Tabs.Content value="rationale" className="space-y-4 focus-visible:outline-none">
          {action.rationale ? (
            <Card>
              <Markdown>{action.rationale}</Markdown>
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
    </>
  );

  return <PageWithRail rail={<ProposalRail action={action} />}>{center}</PageWithRail>;
}
