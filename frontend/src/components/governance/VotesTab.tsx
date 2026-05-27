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
 * Voting power at time of vote: the backend joins each DRep vote against
 * the per-epoch `POWER#{epoch}` snapshot written by the daily
 * `drep-voting-power-history` sync — true historical power. When that
 * snapshot is unavailable (vote pre-dates the sync, or sync gap) the
 * backend falls back to CURRENT power and sets
 * `votingPowerIsApprox: true` so this component can render an asterisk
 * with a tooltip explaining the caveat. SPO / CC voters do not surface
 * power on this tab — the directory cache only covers DReps.
 *
 * SPO and CC voter display names come from the `pool_metadata` and
 * `cc_members` DDB caches (populated by their respective sync Lambdas).
 * When a name is unavailable we fall back to truncated bech32, with a
 * "CC Member" prefix for CC voters so individuals stay distinguishable.
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

/** Truncated bech32 fallback for any voter ID that's too long to display
 *  in full. Uses the same format as the rest of the app — first 12,
 *  ellipsis, last 6 — so the user can still recognize a known ID by its
 *  prefix / suffix. */
function truncateBech32(id: string): string {
  if (id.length <= 20) return id;
  return `${id.slice(0, 12)}…${id.slice(-6)}`;
}

/** Resolve a display label for the voter, per role:
 *   - DRep: `givenName` from CIP-119 anchor; falls back to truncated ID.
 *   - SPO: `${ticker} — ${name}` when both are present, `ticker` alone,
 *     `name` alone, or truncated ID as final fallback.
 *   - ConstitutionalCommittee: `ccName` if present; otherwise
 *     `CC Member (${truncated hot cred})` so individuals stay
 *     visually distinct without a name.
 */
function voterLabel(v: ActionVoteRecord): string {
  if (v.voterRole === 'DRep') {
    if (v.voterDisplayName && v.voterDisplayName.length > 0) return v.voterDisplayName;
    return truncateBech32(v.voterId);
  }
  if (v.voterRole === 'SPO') {
    const ticker = v.poolTicker?.trim();
    const name = v.poolName?.trim();
    if (ticker && name) return `${ticker} — ${name}`;
    if (ticker) return ticker;
    if (name) return name;
    return truncateBech32(v.voterId);
  }
  // ConstitutionalCommittee
  if (v.ccName && v.ccName.length > 0) return v.ccName;
  return `CC Member (${truncateBech32(v.voterId)})`;
}

/** Voter-label link target by role. DReps deep-link to their in-app
 *  profile; SPOs go to a known external SPO view (cardanoscan) because
 *  we don't maintain in-app SPO profiles. CC voters render as plain
 *  text — there's no per-CC-member page to navigate to. */
function voterHref(v: ActionVoteRecord): string | null {
  if (v.voterRole === 'DRep') return `/drep/${encodeURIComponent(v.voterId)}`;
  if (v.voterRole === 'SPO') {
    return `https://cardanoscan.io/pool/${encodeURIComponent(v.voterId)}`;
  }
  return null;
}

function VoteRow({ v }: { v: ActionVoteRecord }): React.ReactElement {
  // Strikethrough applies to the entire row body so it reads as
  // "everything about this vote is superseded by a later one."
  const strikethrough = v.superseded ? 'line-through opacity-70' : '';
  const absoluteTime = new Date(v.votedAt).toLocaleString();
  const voterLabelText = voterLabel(v);
  const labelClasses = cn(
    'text-[14px] font-semibold text-[var(--text-primary)] truncate',
    'hover:text-[var(--brand-primary)] hover:underline',
    strikethrough,
  );

  // DRep voter -> in-app react-router link; SPO voter -> external
  // anchor (cardanoscan); CC voter -> plain text.
  let voterEl: React.ReactNode;
  if (v.voterRole === 'DRep') {
    voterEl = (
      <Link to={voterHref(v) ?? '#'} className={labelClasses} title={v.voterId}>
        {voterLabelText}
      </Link>
    );
  } else if (v.voterRole === 'SPO') {
    voterEl = (
      <a
        href={voterHref(v) ?? '#'}
        target="_blank"
        rel="noopener noreferrer"
        className={labelClasses}
        title={v.voterId}
      >
        {voterLabelText}
      </a>
    );
  } else {
    voterEl = (
      <span
        className={cn(
          'text-[14px] font-semibold text-[var(--text-primary)] truncate',
          strikethrough,
        )}
        title={v.voterId}
      >
        {voterLabelText}
      </span>
    );
  }

  return (
    <Card className={cn('flex flex-col gap-2', strikethrough ? 'opacity-90' : '')}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          {voterEl}
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
            title={
              v.votingPowerIsApprox
                ? 'Current power; historical snapshot unavailable for this vote’s epoch'
                : 'Voting power at the time of the vote'
            }
          >
            {(() => {
              try {
                return _formatLovelaceAda(BigInt(v.votingPowerLovelace));
              } catch {
                return '—';
              }
            })()}
            {v.votingPowerIsApprox ? <sup aria-hidden="true">*</sup> : null}
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
