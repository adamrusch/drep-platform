import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import type { GovernanceAction, VoteTally, VotingRoles } from '@/types';
import { cn } from '@/lib/utils';
import { useFormatters } from '@/hooks/useFormatters';
import { StatusPill } from '@/components/ui/StatusPill';
import { SentimentBar } from '@/components/ui/SentimentBar';
import { useUiStore } from '@/stores/uiStore';

/** Sum the per-role power slices into top-level totals. Power is summed
 *  as BigInt (DRep totals exceed 2^53 lovelace) and returned as
 *  stringified integers for the SentimentBar's prop shape. Honors the
 *  CIP-1694 role-applicability map so the compact list bar mirrors the
 *  detail page (e.g. Treasury Withdrawals: SPO power isn't summed in). */
function tallyPowerTotals(
  votes: VoteTally,
  votingRoles?: VotingRoles,
): {
  yes: string;
  no: string;
  abstain: string;
  notVoted: string;
  totalActive: string;
} {
  const parse = (s: string): bigint => {
    try {
      return BigInt(s);
    } catch {
      return 0n;
    }
  };
  const includeDrep = votingRoles?.drep ?? true;
  const includeSpo = votingRoles?.spo ?? true;
  const includeCc = votingRoles?.cc ?? true;
  const sum = (key: 'yes' | 'no' | 'abstain' | 'notVoted' | 'totalActive'): bigint =>
    (includeDrep ? parse(votes.drep[key].power) : 0n) +
    (includeSpo ? parse(votes.spo[key].power) : 0n) +
    (includeCc ? parse(votes.cc[key].power) : 0n);
  return {
    yes: sum('yes').toString(),
    no: sum('no').toString(),
    abstain: sum('abstain').toString(),
    notVoted: sum('notVoted').toString(),
    totalActive: sum('totalActive').toString(),
  };
}

interface GovernanceActionCardProps {
  action: GovernanceAction;
  className?: string;
}

function shortActionId(actionId: string): string {
  const [hash, idx] = actionId.split('#');
  if (!hash) return actionId;
  return `${hash.slice(0, 8)}…${hash.slice(-4)}#${idx ?? '0'}`;
}

/** Build adastat / cardanoscan URLs. The `#` separator in `actionId` must
 *  be percent-encoded to survive the URL fragment treatment. */
function explorerUrls(actionId: string): { adastat: string; cardanoscan: string } {
  const encoded = actionId.replace('#', '%23');
  return {
    adastat: `https://adastat.net/governances/${encoded}`,
    cardanoscan: `https://cardanoscan.io/governanceAction/${encoded}`,
  };
}

export function GovernanceActionCard({
  action,
  className,
}: GovernanceActionCardProps): React.ReactElement {
  const { t } = useTranslation();
  const { formatRelativeTime, formatEpochDate } = useFormatters();
  const addToast = useUiStore((s) => s.addToast);
  const summary = action.summary && action.summary.length > 0 ? action.summary : undefined;
  // Until the backend re-enriches (Blockfrost daily quota gate), some rows
  // still carry a legacy synthetic `title` equal to the on-chain summary or
  // the bare actionId. Treat those as "no anchor" so the UI reflects the
  // intended Title / Type / Hash / Metadata separation either way. Pillar
  // titles are never legacy-synthetic.
  const isSyntheticTitle =
    !action.anchorUrl &&
    action.metadataSource !== 'proposal-pillar' &&
    typeof action.title === 'string' &&
    (action.title === action.actionId || action.title === summary);
  const hasTitle =
    typeof action.title === 'string' && action.title.length > 0 && !isSyntheticTitle;
  const explorers = explorerUrls(action.actionId);

  /** Stop the parent <Link> navigation when clicking action chrome
   *  (hash, metadata link, explorer links). */
  const stopRowNav = (e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleCopyHash = async (e: React.MouseEvent<HTMLButtonElement>): Promise<void> => {
    stopRowNav(e);
    try {
      await navigator.clipboard.writeText(action.actionId);
      addToast({ title: t('actionCard.hashCopied'), variant: 'success' });
    } catch {
      addToast({ title: t('actionCard.copyFailed'), variant: 'error' });
    }
  };

  const isPillarSourced = action.metadataSource === 'proposal-pillar';

  return (
    <Link
      to={`/governance/${encodeURIComponent(action.actionId)}`}
      className={cn(
        // Card chrome — design system spec, NOT the harsh hand-rolled border.
        'block bg-[var(--bg-canvas)] border border-[var(--border-default)]',
        'rounded-token-xl shadow-token-sm p-5',
        'transition-all duration-150',
        'hover:border-[var(--border-strong)] hover:shadow-token-md hover:-translate-y-px',
        className,
      )}
    >
      {/* Header row: type + status pills (left) · metadata link (right) */}
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <span className="text-[11.5px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
            {t(`actionType.${action.actionType}`, { defaultValue: action.actionType })}
          </span>
          <StatusPill status={action.status} label={action.adminOverrideLabel ?? undefined} />
          {isPillarSourced && (
            <StatusPill
              status="discussion"
              label={t('actionCard.discussionForum')}
              title={t('actionCard.discussionForumTitle')}
            />
          )}
          {/* Yellow "Hash mismatch" pill: the off-chain body was retrievable
              and is shown on the detail page, but its bytes don't hash-match
              the on-chain anchor. Always render on the list card so the user
              sees the integrity caveat without having to click through. See
              GovernanceActionPage.tsx for the longer tooltip on the detail page. */}
          {action.anchorHashMismatch && (
            <StatusPill
              status="warning"
              label={t('actionCard.hashMismatch')}
              title={t('actionCard.hashMismatchTitle')}
            />
          )}
        </div>
        {action.anchorUrl ? (
          <a
            href={action.anchorUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={stopRowNav}
            className="flex-shrink-0 inline-flex items-center gap-1 text-[11.5px] text-[var(--text-tertiary)] hover:text-[var(--brand-primary)] hover:underline"
            title={action.anchorUrl}
          >
            {t('actionCard.metadata')}
            <ExternalLink size={11} strokeWidth={2} aria-hidden="true" />
          </a>
        ) : action.proposalPillarUrl ? (
          <a
            href={action.proposalPillarUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={stopRowNav}
            className="flex-shrink-0 inline-flex items-center gap-1 text-[11.5px] text-[var(--text-tertiary)] hover:text-[var(--brand-primary)] hover:underline"
            title={t('actionCard.discussionLinkTitle')}
          >
            {t('actionCard.discussion')}
            <ExternalLink size={11} strokeWidth={2} aria-hidden="true" />
          </a>
        ) : (
          <span className="flex-shrink-0 text-[11.5px] text-[var(--text-muted)]">—</span>
        )}
      </div>

      {/* Title slot — bold when present, italic muted placeholder otherwise.
          When the anchor URL is set but its body couldn't be retrieved
          (Koios + IPFS multi-gateway fallback both failed) we surface a
          more honest "Metadata unavailable" label; the Metadata link in
          the header row already lets users try the raw anchor themselves. */}
      {hasTitle ? (
        <h3 className="font-semibold text-[15px] leading-snug line-clamp-2 text-[var(--text-primary)] tracking-tight">
          {action.title}
        </h3>
      ) : action.anchorUrl ? (
        <h3
          className="text-[14px] italic leading-snug text-[var(--text-tertiary)]"
          title={t('actionCard.metadataUnavailableTitle')}
        >
          {t('actionCard.metadataUnavailable')}
        </h3>
      ) : (
        <h3 className="text-[14px] italic leading-snug text-[var(--text-tertiary)]">
          {t('actionCard.noOffChainMetadata')}
        </h3>
      )}

      {/* Summary subtitle — synthesized one-liner. When there's no title,
          render in normal weight so the user sees informative content;
          when there's a title, render as a smaller secondary line. */}
      {summary && (
        <p
          className={cn(
            'mt-1.5 line-clamp-2 leading-relaxed',
            hasTitle
              ? 'text-[12.5px] text-[var(--text-tertiary)]'
              : 'text-[13px] text-[var(--text-secondary)]',
          )}
        >
          {summary}
        </p>
      )}

      {/* Hash row — click-to-copy. */}
      <button
        type="button"
        onClick={(e) => void handleCopyHash(e)}
        title={t('actionCard.copyHashTitle', { id: action.actionId })}
        className={cn(
          'mt-2.5 inline-flex items-center text-[11px] font-mono',
          'text-[var(--text-muted)] hover:text-[var(--brand-primary)]',
          'rounded-token-sm focus-visible:outline-none focus-visible:shadow-token-focus',
        )}
      >
        {shortActionId(action.actionId)}
      </button>

      {/* Footer: timestamp + sentiment bar + epoch + explorer links */}
      <div className="mt-3 pt-3 border-t border-[var(--border-subtle)] flex items-center justify-between gap-4 text-[11.5px] text-[var(--text-tertiary)] tabular-nums">
        <span className="flex-shrink-0">{t('actionCard.submitted', { time: formatRelativeTime(action.submittedAt) })}</span>
        {action.votes && tallyPowerTotals(action.votes, action.votingRoles).totalActive !== '0' ? (
          <div className="flex-1 max-w-[180px]">
            <SentimentBar
              yes={tallyPowerTotals(action.votes, action.votingRoles).yes}
              no={tallyPowerTotals(action.votes, action.votingRoles).no}
              notVoted={tallyPowerTotals(action.votes, action.votingRoles).notVoted}
              totalActive={tallyPowerTotals(action.votes, action.votingRoles).totalActive}
              abstain={tallyPowerTotals(action.votes, action.votingRoles).abstain}
              height={6}
            />
          </div>
        ) : null}
        <span className="flex-shrink-0">
          {t('actionCard.epoch', { n: action.epochDeadline, date: formatEpochDate(action.epochDeadline) })}
        </span>
      </div>

      <div className="mt-2 flex items-center gap-3 text-[11px] text-[var(--text-tertiary)]">
        <a
          href={explorers.adastat}
          target="_blank"
          rel="noopener noreferrer"
          onClick={stopRowNav}
          className="inline-flex items-center gap-1 hover:text-[var(--brand-primary)] hover:underline"
        >
          adastat
          <ExternalLink size={10} strokeWidth={2} aria-hidden="true" />
        </a>
        <a
          href={explorers.cardanoscan}
          target="_blank"
          rel="noopener noreferrer"
          onClick={stopRowNav}
          className="inline-flex items-center gap-1 hover:text-[var(--brand-primary)] hover:underline"
        >
          cardanoscan
          <ExternalLink size={10} strokeWidth={2} aria-hidden="true" />
        </a>
      </div>
    </Link>
  );
}
