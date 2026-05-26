import React from 'react';
import { Link } from 'react-router-dom';
import { Check, X, Minus, ExternalLink } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { _formatLovelaceAda } from '@/components/SentimentBlock';
import { cn, formatRelativeTime } from '@/lib/utils';
import type { ActionVoteRecord, VoteVoterRole } from '@/types';

/**
 * Per-action Votes tab. Renders every individual vote cast on the parent
 * governance action, grouped by voter role (DRep / SPO / Constitutional
 * Committee). Within each group, votes are newest-first.
 *
 * A voter can recast their vote on the same action; the backend marks the
 * older row(s) with `superseded: true`. This component renders those rows
 * with `line-through` so the full audit trail is visible without misleading
 * the reader about which vote is "live."
 *
 * Color treatment matches the rest of the page (`SentimentBlock` palette):
 *   - Yes  -> `var(--success)`
 *   - No   -> `var(--danger)`
 *   - Abstain -> `var(--text-muted)` (matches the abstain footnote
 *     iconClass on `SentimentBlock`)
 *
 * "Voting power at time of vote": today we surface the voter's CURRENT
 * voting power from the directory cache (DReps only). True point-in-time
 * power would require a per-vote Koios lookup against the historical epoch
 * snapshot — out of scope. See `TODO(historical-power)` in
 * `backend/src/lib/votes.ts`.
 */
interface VotesTabProps {
  /** May be undefined while the parent's React Query is loading, or
   *  empty when the action has zero votes. */
  votes: readonly ActionVoteRecord[] | undefined;
}

function Pill({
  label,
  iconClass,
  Icon,
}: {
  label: string;
  iconClass: string;
  Icon: typeof Check;
}): React.ReactElement {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-[12px] font-semibold tabular-nums',
        iconClass,
      )}
    >
      <Icon size={14} strokeWidth={2.25} aria-hidden="true" />
      {label}
    </span>
  );
}

function VotePill({ vote }: { vote: ActionVoteRecord['vote'] }): React.ReactElement {
  switch (vote) {
    case 'Yes':
      return <Pill label="Yes" iconClass="text-[var(--success)]" Icon={Check} />;
    case 'No':
      return <Pill label="No" iconClass="text-[var(--danger)]" Icon={X} />;
    case 'Abstain':
      return <Pill label="Abstain" iconClass="text-[var(--text-muted)]" Icon={Minus} />;
  }
}

/** Resolve a display label for the voter. DReps get `givenName` (or a
 *  truncated drep ID); SPO / CC voters get a truncated raw ID. */
function voterLabel(v: ActionVoteRecord): string {
  if (v.voterDisplayName && v.voterDisplayName.length > 0) return v.voterDisplayName;
  if (v.voterId.length <= 20) return v.voterId;
  return `${v.voterId.slice(0, 12)}…${v.voterId.slice(-6)}`;
}

function VoteRow({ v }: { v: ActionVoteRecord }): React.ReactElement {
  // Strikethrough applies to the entire row body so it reads as
  // "everything about this vote is superseded by a later one."
  const strikethrough = v.superseded ? 'line-through opacity-70' : '';
  const absoluteTime = new Date(v.votedAt).toLocaleString();
  const voterLabelText = voterLabel(v);

  return (
    <Card className={cn('flex flex-col gap-2', strikethrough ? 'opacity-90' : '')}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          {v.voterRole === 'DRep' ? (
            <Link
              to={`/drep/${encodeURIComponent(v.voterId)}`}
              className={cn(
                'text-[14px] font-semibold text-[var(--text-primary)] truncate',
                'hover:text-[var(--brand-primary)] hover:underline',
                strikethrough,
              )}
              title={v.voterId}
            >
              {voterLabelText}
            </Link>
          ) : (
            <span
              className={cn(
                'text-[14px] font-semibold text-[var(--text-primary)] truncate',
                strikethrough,
              )}
              title={v.voterId}
            >
              {voterLabelText}
            </span>
          )}
          {v.superseded && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded-token-sm bg-[var(--bg-muted)] text-[10.5px] font-medium uppercase tracking-wider text-[var(--text-tertiary)] no-underline">
              Superseded
            </span>
          )}
        </div>
        <div className={cn('flex items-center gap-3 flex-shrink-0', strikethrough)}>
          <VotePill vote={v.vote} />
        </div>
      </div>
      <div
        className={cn(
          'flex items-center gap-x-4 gap-y-1 flex-wrap text-[12px] text-[var(--text-tertiary)] tabular-nums',
          strikethrough,
        )}
      >
        {v.votingPowerLovelace !== undefined ? (
          <span
            title="Current voting power (not power at time of vote — see release notes)"
          >
            {(() => {
              try {
                return _formatLovelaceAda(BigInt(v.votingPowerLovelace));
              } catch {
                return '—';
              }
            })()}
          </span>
        ) : null}
        <span title={absoluteTime}>{formatRelativeTime(v.votedAt)}</span>
        {v.rationaleUrl && (
          <a
            href={v.rationaleUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 hover:text-[var(--brand-primary)] hover:underline"
            title={v.rationaleUrl}
          >
            Rationale
            <ExternalLink size={11} strokeWidth={2} aria-hidden="true" />
          </a>
        )}
      </div>
    </Card>
  );
}

function VoterSection({
  title,
  votes,
}: {
  title: string;
  votes: readonly ActionVoteRecord[];
}): React.ReactElement | null {
  if (votes.length === 0) return null;
  return (
    <section className="space-y-3">
      <h3 className="text-[12px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
        {title} <span className="ml-1 text-[var(--text-muted)]">({votes.length})</span>
      </h3>
      <div className="space-y-2">
        {votes.map((v) => (
          <VoteRow key={`${v.voterRole}#${v.voterId}#${v.voteTxHash}`} v={v} />
        ))}
      </div>
    </section>
  );
}

const ROLE_TITLES: Record<VoteVoterRole, string> = {
  DRep: 'DReps',
  SPO: 'SPOs',
  ConstitutionalCommittee: 'Constitutional Committee',
};

export function VotesTab({ votes }: VotesTabProps): React.ReactElement {
  if (!votes || votes.length === 0) {
    return (
      <Card>
        <div className="py-6 text-center text-sm text-[var(--text-tertiary)]">
          No votes have been cast on this action yet.
        </div>
      </Card>
    );
  }

  // Already newest-first from the backend; group by role for the three
  // section headers.
  const dreps: ActionVoteRecord[] = [];
  const spos: ActionVoteRecord[] = [];
  const cc: ActionVoteRecord[] = [];
  for (const v of votes) {
    if (v.voterRole === 'DRep') dreps.push(v);
    else if (v.voterRole === 'SPO') spos.push(v);
    else cc.push(v);
  }

  return (
    <div className="space-y-6">
      <VoterSection title={ROLE_TITLES.DRep} votes={dreps} />
      <VoterSection title={ROLE_TITLES.SPO} votes={spos} />
      <VoterSection title={ROLE_TITLES.ConstitutionalCommittee} votes={cc} />
    </div>
  );
}
