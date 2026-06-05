import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Link } from 'react-router-dom';
import { Check, X, Minus, ExternalLink } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { ExpandableText } from '@/components/ExpandableText';
import { _formatLovelaceAda } from '@/components/SentimentBlock';
import { useFormatters } from '@/hooks/useFormatters';
import { cn } from '@/lib/utils';
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

function VotePill({
  vote,
  t,
}: {
  vote: ActionVoteRecord['vote'];
  t: TFunction;
}): React.ReactElement {
  switch (vote) {
    case 'Yes':
      return <Pill label={t('votesTab.choiceYes')} iconClass="text-[var(--success)]" Icon={Check} />;
    case 'No':
      return <Pill label={t('votesTab.choiceNo')} iconClass="text-[var(--danger)]" Icon={X} />;
    case 'Abstain':
      return (
        <Pill label={t('votesTab.choiceAbstain')} iconClass="text-[var(--text-muted)]" Icon={Minus} />
      );
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
function voterLabel(v: ActionVoteRecord, t: TFunction): string {
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
  return t('votesTab.ccMemberLabel', { id: truncateBech32(v.voterId) });
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
  const { t } = useTranslation();
  const { formatRelativeTime } = useFormatters();
  // Strikethrough applies to the entire row body so it reads as
  // "everything about this vote is superseded by a later one."
  const strikethrough = v.superseded ? 'line-through opacity-70' : '';
  const absoluteTime = new Date(v.votedAt).toLocaleString();
  const voterLabelText = voterLabel(v, t);
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
              {t('votesTab.superseded')}
            </span>
          )}
        </div>
        <div className={cn('flex items-center gap-3 flex-shrink-0', strikethrough)}>
          <VotePill vote={v.vote} t={t} />
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
                ? t('votesTab.powerApproxTooltip')
                : t('votesTab.powerTooltip')
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
        {/* When we have NO cached rationale text, keep the raw external link
            (the rationale either hasn't been fetched yet or wasn't reachable).
            When we DO have cached text, the inline block below renders it with
            its own "Source" link, so we don't duplicate the link here. */}
        {v.rationaleUrl && !v.rationaleText && (
          <a
            href={v.rationaleUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 hover:text-[var(--brand-primary)] hover:underline"
            title={v.rationaleUrl}
          >
            {t('votesTab.rationale')}
            <ExternalLink size={11} strokeWidth={2} aria-hidden="true" />
          </a>
        )}
      </div>

      {/* Cached rationale, downloaded from IPFS/https and hash-verified
          server-side. Rendered inline (expandable) instead of sending the
          reader to an external gateway. */}
      {v.rationaleText && (
        <div className={cn('mt-2 space-y-1 border-t border-[var(--border-subtle)] pt-2', strikethrough)}>
          {v.rationaleTitle && (
            <p className="text-[12.5px] font-medium text-[var(--text-primary)]">{v.rationaleTitle}</p>
          )}
          <ExpandableText
            text={v.rationaleText}
            className="text-[12.5px] leading-relaxed text-[var(--text-secondary)] whitespace-pre-wrap"
          />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--text-tertiary)]">
            {v.rationaleHashMatch === false && (
              <span className="text-[var(--warning,#a16207)]">{t('votesTab.rationaleUnverified')}</span>
            )}
            {v.rationaleTruncated && <span>{t('votesTab.rationaleTruncated')}</span>}
            {v.rationaleUrl && (
              <a
                href={v.rationaleUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 hover:text-[var(--brand-primary)] hover:underline"
                title={v.rationaleUrl}
              >
                {t('votesTab.rationaleSource')}
                <ExternalLink size={10} strokeWidth={2} aria-hidden="true" />
              </a>
            )}
          </div>
        </div>
      )}
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
  const { t } = useTranslation();
  if (votes.length === 0) return null;
  return (
    <section className="space-y-3">
      <h3 className="text-[12px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
        {title}{' '}
        <span className="ml-1 text-[var(--text-muted)]">
          {t('votesTab.sectionCount', { count: votes.length })}
        </span>
      </h3>
      <div className="space-y-2">
        {votes.map((v) => (
          <VoteRow key={`${v.voterRole}#${v.voterId}#${v.voteTxHash}`} v={v} />
        ))}
      </div>
    </section>
  );
}

const ROLE_TITLE_KEYS: Record<VoteVoterRole, string> = {
  DRep: 'votesTab.roleDreps',
  SPO: 'votesTab.roleSpos',
  ConstitutionalCommittee: 'votesTab.roleCc',
};

export function VotesTab({ votes }: VotesTabProps): React.ReactElement {
  const { t } = useTranslation();
  if (!votes || votes.length === 0) {
    return (
      <Card>
        <div className="py-6 text-center text-sm text-[var(--text-tertiary)]">
          {t('votesTab.noVotes')}
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
      <VoterSection title={t(ROLE_TITLE_KEYS.DRep)} votes={dreps} />
      <VoterSection title={t(ROLE_TITLE_KEYS.SPO)} votes={spos} />
      <VoterSection title={t(ROLE_TITLE_KEYS.ConstitutionalCommittee)} votes={cc} />
    </div>
  );
}
