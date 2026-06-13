import type React from 'react';
import { useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import {
  Copy,
  ExternalLink,
  TrendingUp,
  Users as UsersIcon,
  AtSign,
  ChevronLeft,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import { get } from '@/lib/api';
import { useMe } from '@/hooks/useAuth';
import { useEpoch } from '@/hooks/useEpoch';
import { Card } from '@/components/ui/Card';
import { StatusPill } from '@/components/ui/StatusPill';
import { Sparkline, seededRandomWalk } from '@/components/ui/Sparkline';
import { useUiStore } from '@/stores/uiStore';
import { useFormatters } from '@/hooks/useFormatters';
import { resolveDrepAvatarUrl } from '@/lib/drepAvatar';
import { cn } from '@/lib/utils';
import type { DRepDetail, DRepReference } from '@/types';

/** Reject anything but http(s) / ipfs — anchor metadata is untrusted user
 *  input. The directory sync already filters at write time, but we belt-
 *  and-suspenders here in case stored data predates that filter. */
function isSafeReferenceUri(uri: string): boolean {
  return /^(https?:|ipfs:)/i.test(uri);
}

/** Build adastat / cardanoscan deep links for a DRep ID. */
function explorerUrls(drepId: string): { adastat: string; cardanoscan: string } {
  return {
    adastat: `https://adastat.net/dreps/${drepId}`,
    cardanoscan: `https://cardanoscan.io/drep/${drepId}`,
  };
}

/** Render multi-paragraph CIP-119 prose safely (no HTML). */
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

/** Avatar with initial-letter fallback. Mirrors the directory card's
 *  approach so the same DRep looks identical across surfaces. */
function avatarColor(drepId: string): string {
  let h = 0;
  for (let i = 0; i < drepId.length; i++) h = (h * 31 + drepId.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(h) % 360}, 55%, 75%)`;
}

interface AvatarProps {
  drepId: string;
  name?: string;
  /** Sprint 5 — sha256-hex of the self-hosted avatar bytes living at
   *  `/api/avatar/<hash>`. Absent → cardenticon identicon fallback. */
  imageContentHash?: string | null;
  size?: number;
}

function DRepAvatar({
  drepId,
  name,
  imageContentHash,
  size = 72,
}: AvatarProps): React.ReactElement {
  const [errored, setErrored] = useState(false);
  const src = useMemo(
    () => resolveDrepAvatarUrl({ drepId, imageContentHash, size }),
    [drepId, imageContentHash, size],
  );
  const finalSrc = useMemo(
    () => (errored ? resolveDrepAvatarUrl({ drepId, size }) : src),
    [errored, drepId, size, src],
  );
  void name;
  return (
    <div
      className="flex-shrink-0 inline-flex items-center justify-center rounded-token-full overflow-hidden"
      style={{
        width: size,
        height: size,
        background: avatarColor(drepId),
      }}
      aria-hidden="true"
    >
      <img
        src={finalSrc}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        onError={() => setErrored(true)}
        className="w-full h-full object-cover"
      />
    </div>
  );
}

/** Group references into "Identity" (social handles, rendered as a row of
 *  pills) vs everything else (rendered as a bullet list). */
function partitionReferences(refs: DRepReference[] | undefined): {
  identity: DRepReference[];
  general: DRepReference[];
} {
  if (!refs) return { identity: [], general: [] };
  const identity: DRepReference[] = [];
  const general: DRepReference[] = [];
  for (const r of refs) {
    if (r.kind === 'Identity') identity.push(r);
    else general.push(r);
  }
  return { identity, general };
}

const VOTE_PILL_CLASS: Record<string, string> = {
  yes: 'bg-[var(--success-soft)] text-[var(--success)]',
  no: 'bg-[var(--danger-soft)] text-[var(--danger)]',
  abstain: 'bg-[var(--bg-muted)] text-[var(--text-secondary)]',
};

/** Known CIP-1694 governance-action types. Display labels are resolved at
 *  render via `t('drepProfile.actionTypes.<type>')`; unknown types fall back
 *  to the raw on-chain type string. */
const KNOWN_ACTION_TYPES = new Set([
  'ParameterChange',
  'HardForkInitiation',
  'TreasuryWithdrawals',
  'NoConfidence',
  'UpdateCommittee',
  'NewConstitution',
  'InfoAction',
]);

function shortHash(hash: string): string {
  if (hash.length <= 12) return hash;
  return `${hash.slice(0, 8)}…${hash.slice(-4)}`;
}

export function DRepPublicProfile(): React.ReactElement {
  const { t } = useTranslation();
  const { formatLovelace, formatRelativeTime, formatEpochDate } = useFormatters();
  const { drepId } = useParams<{ drepId: string }>();
  const addToast = useUiStore((s) => s.addToast);
  const { data: viewerProfile } = useMe();
  const { data: epochInfo } = useEpoch();

  const { data: drep, isLoading, error } = useQuery({
    queryKey: ['drep-detail', drepId],
    queryFn: () => get<DRepDetail>(`/dreps/${encodeURIComponent(drepId ?? '')}`),
    enabled: Boolean(drepId),
  });

  if (isLoading) {
    return (
      <div className="max-w-3xl mx-auto space-y-4 animate-pulse">
        <div className="h-8 bg-[var(--bg-muted)] rounded w-1/3" />
        <div className="h-32 bg-[var(--bg-muted)] rounded" />
        <div className="h-24 bg-[var(--bg-muted)] rounded" />
      </div>
    );
  }

  if (error || !drep) {
    return (
      <div className="text-center py-16">
        <h2 className="text-xl font-semibold mb-2">{t('drepProfile.notFound')}</h2>
        <Link to="/dreps" className="text-[var(--brand-primary)] hover:underline text-sm">
          {t('drepProfile.backToDirectory')}
        </Link>
      </div>
    );
  }

  const explorers = explorerUrls(drep.drepId);
  const { identity, general } = partitionReferences(drep.references);
  const power = (() => {
    try {
      return formatLovelace(drep.votingPower);
    } catch {
      return '—';
    }
  })();
  const delegatorCount = drep.delegatorCountLive ?? drep.delegatorCount;

  // Viewer-specific delegation indicator: when the current viewer's
  // wallet is delegated to THIS DRep, surface how long they've been
  // delegated. The live source (delegatedToDrepId on /auth/me) tells us
  // the wallet IS currently delegated; the history array gives the
  // epoch the delegation started. If the live ID and the latest history
  // entry agree, the duration is from that history entry's epochStart
  // to "now" (current epoch). When history hasn't caught up (live ID
  // confirmed but no matching history row), we still surface "Delegated
  // to this DRep" without the epoch math.
  const viewerDelegation = (() => {
    if (!viewerProfile || viewerProfile.delegatedToDrepId !== drep.drepId) return null;
    const matchingHistory = viewerProfile.delegationHistory?.find(
      (h) => h.drepId === drep.drepId && (h.epochEnd === null || h.epochEnd === undefined),
    );
    const epochStart = matchingHistory?.epochStart;
    const currentEpoch = epochInfo?.epoch;
    const epochsDelegated =
      typeof epochStart === 'number' && typeof currentEpoch === 'number'
        ? Math.max(0, currentEpoch - epochStart)
        : null;
    return { epochStart, epochsDelegated };
  })();

  const handleCopyId = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(drep.drepId);
      addToast({ title: t('drepProfile.copyIdToast'), variant: 'success' });
    } catch {
      addToast({ title: t('drepProfile.copyFailedToast'), variant: 'error' });
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Breadcrumb */}
      <nav className="crumbs">
        <Link
          to="/dreps"
          className="flex items-center gap-1 hover:text-[var(--brand-primary)]"
        >
          <ChevronLeft size={14} strokeWidth={1.75} />
          <span>{t('drepProfile.breadcrumbRoot')}</span>
        </Link>
        <span className="crumbs__sep">/</span>
        <span className="text-[var(--text-primary)] truncate">
          {drep.givenName ?? drep.drepId}
        </span>
      </nav>

      {/* Header */}
      <Card padLg>
        <div className="flex items-start gap-5">
          <DRepAvatar
            drepId={drep.drepId}
            name={drep.givenName}
            imageContentHash={drep.imageContentHash}
            size={72}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              {drep.givenName ? (
                <h1
                  className={cn(
                    'text-[24px] font-bold tracking-tight text-[var(--text-primary)] truncate',
                    // Predefined DRep names are hard-coded by the sync
                    // (not from a CIP-119 anchor) — italicize to signal.
                    drep.isPredefined && 'italic',
                  )}
                >
                  {drep.givenName}
                </h1>
              ) : (
                <h1 className="text-[20px] italic text-[var(--text-tertiary)]">
                  {t('drepProfile.unnamed')}
                </h1>
              )}
              {drep.isPredefined ? (
                <StatusPill
                  status="voting"
                  label={t('drepProfile.status.predefined')}
                  title={t('drepProfile.status.predefinedTitle')}
                />
              ) : drep.isActive ? (
                <StatusPill status="active" label={t('drepProfile.status.active')} />
              ) : (
                <StatusPill
                  status="expired"
                  label={
                    drep.expiresEpoch !== null
                      ? t('drepProfile.status.inactiveExpires', { epoch: drep.expiresEpoch })
                      : t('drepProfile.status.inactive')
                  }
                />
              )}
              {drep.hasScript && (
                <StatusPill
                  status="neutral"
                  label={t('drepProfile.status.script')}
                  title={t('drepProfile.status.scriptTitle')}
                />
              )}
              {drep.anchorVerified === true && (
                <StatusPill status="passed" label={t('drepProfile.status.anchorVerified')} />
              )}
              {drep.anchorVerified === false && (
                <StatusPill status="warning" label={t('drepProfile.status.anchorMismatch')} />
              )}
              {viewerDelegation && (
                <StatusPill
                  status="passed"
                  label={
                    viewerDelegation.epochsDelegated !== null &&
                    typeof viewerDelegation.epochStart === 'number'
                      ? t('drepProfile.status.delegatedSince', {
                          count: viewerDelegation.epochsDelegated,
                          epoch: viewerDelegation.epochStart,
                        })
                      : t('drepProfile.status.delegated')
                  }
                  title={
                    viewerDelegation.epochsDelegated !== null
                      ? t('drepProfile.status.delegatedTitleDays', {
                          days: viewerDelegation.epochsDelegated * 5,
                        })
                      : t('drepProfile.status.delegatedTitle')
                  }
                />
              )}
            </div>

            {/* Click-to-copy DRep ID */}
            <button
              type="button"
              onClick={() => void handleCopyId()}
              title={t('drepProfile.copyIdTitle', { id: drep.drepId })}
              className={cn(
                'inline-flex items-center gap-1.5 text-[11.5px] font-mono break-all',
                'text-[var(--text-muted)] hover:text-[var(--brand-primary)]',
                'rounded-token-sm focus-visible:outline-none focus-visible:shadow-token-focus',
              )}
            >
              {drep.drepId}
              <Copy size={11} strokeWidth={2} aria-hidden="true" />
            </button>

            {/* Identity references — social handles row */}
            {identity.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {identity.map((ref, i) =>
                  isSafeReferenceUri(ref.uri) ? (
                    <a
                      key={`${ref.uri}-${i}`}
                      href={ref.uri}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={cn(
                        'inline-flex items-center gap-1 px-2 py-0.5',
                        'rounded-token-full bg-[var(--bg-muted)] text-[11.5px] font-medium',
                        'text-[var(--text-secondary)] hover:text-[var(--brand-primary)]',
                      )}
                    >
                      <AtSign size={11} strokeWidth={2} aria-hidden="true" />
                      <span className="truncate max-w-[200px]">{ref.label}</span>
                    </a>
                  ) : null,
                )}
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* Stats strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 rounded-token-lg border border-[var(--border-default)] bg-[var(--bg-subtle)] p-4 text-sm">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-0.5">
            {t('drepProfile.stats.votingPower')}
          </div>
          <div className="font-medium text-[var(--text-primary)] tabular-nums">{power}</div>
        </div>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-0.5">
            {t('drepProfile.stats.delegators')}
          </div>
          <div className="font-medium text-[var(--text-primary)] tabular-nums">
            {typeof delegatorCount === 'number'
              ? // `delegatorCountIsApprox` is only set when the live count
                // hit the backend's `MAX_DELEGATORS_WALK` cap (default
                // 1000) or returned a partial result. Render "{count}+"
                // so the user knows the precise number is at least that
                // big. See backend/src/lib/koios.ts `fetchDRepDelegatorCount`
                // for the approximation contract.
                `${delegatorCount.toLocaleString()}${drep.delegatorCountIsApprox ? '+' : ''}`
              : '—'}
          </div>
        </div>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-0.5">
            {t('drepProfile.stats.status')}
          </div>
          <div className="font-medium text-[var(--text-primary)] capitalize">{drep.status}</div>
        </div>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-0.5">
            {t('drepProfile.stats.expires')}
          </div>
          <div className="font-medium text-[var(--text-primary)] tabular-nums">
            {drep.expiresEpoch !== null
              ? t('drepProfile.stats.epochWithDate', {
                  epoch: drep.expiresEpoch,
                  date: formatEpochDate(drep.expiresEpoch),
                })
              : '—'}
          </div>
        </div>
      </div>

      {/* Explorer links */}
      <div className="flex items-center gap-3 text-[11.5px] text-[var(--text-tertiary)]">
        <a
          href={explorers.adastat}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 hover:text-[var(--brand-primary)] hover:underline"
        >
          adastat
          <ExternalLink size={11} strokeWidth={2} aria-hidden="true" />
        </a>
        <a
          href={explorers.cardanoscan}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 hover:text-[var(--brand-primary)] hover:underline"
        >
          cardanoscan
          <ExternalLink size={11} strokeWidth={2} aria-hidden="true" />
        </a>
        {drep.anchorUrl && (
          <a
            href={drep.anchorUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 hover:text-[var(--brand-primary)] hover:underline"
            title={drep.anchorUrl}
          >
            {t('drepProfile.explorer.cip119Metadata')}
            <ExternalLink size={11} strokeWidth={2} aria-hidden="true" />
          </a>
        )}
      </div>

      {/* Predefined-DRep explainer — only renders for the two protocol
          pseudo-identities. They have no CIP-119 anchor, no Sparkline,
          no recent-votes table (their auto-vote is computed at
          ratification time, not recorded per-DRep). The user lands here
          when navigating from a directory card or a wallet that delegates
          to one of them; the static explainer is what stops the page
          from looking broken. */}
      {drep.isPredefined && (
        <div className="rounded-token-xl border border-[var(--info)]/30 bg-[var(--info-soft)] p-5 text-sm">
          <p className="text-[var(--text-primary)] font-medium mb-1">
            {t('drepProfile.predefinedExplainerTitle')}
          </p>
          <p className="text-[var(--text-secondary)] leading-relaxed">
            {drep.drepId === 'drep_always_abstain'
              ? t('drepProfile.predefinedAbstain')
              : t('drepProfile.predefinedNoConfidence')}
          </p>
        </div>
      )}

      {/* Voting power trend — placeholder series until per-DRep history sync lands.
          Hidden for predefined DReps: their voting power swings with chain-wide
          delegation patterns and the Sparkline is misleading for them. */}
      {!drep.isPredefined && (
        <div className="rounded-token-xl border border-[var(--border-default)] bg-[var(--bg-canvas)] p-5 shadow-token-sm">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-[15px] text-[var(--text-primary)] flex items-center gap-2">
              <TrendingUp size={14} strokeWidth={2} className="text-[var(--brand-primary)]" />
              {t('drepProfile.trend.title')}
              <span className="text-[11px] text-[var(--text-tertiary)] font-normal ml-1">
                {t('drepProfile.trend.lastEpochs')}
              </span>
            </h2>
            <span className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-token-full bg-[var(--bg-muted)] text-[var(--text-tertiary)]">
              {t('drepProfile.trend.sampleData')}
            </span>
          </div>
          <Sparkline
            points={seededRandomWalk(drep.drepId, 14, 100)}
            smooth
            gradientId={`drep-trend-${drep.drepId}`}
            height={120}
          />
        </div>
      )}

      {/* Bio sections */}
      {drep.objectives && (
        <Card>
          <h2 className="font-semibold text-[15px] mb-2 text-[var(--text-primary)]">{t('drepProfile.sections.objectives')}</h2>
          <ProseBlock text={drep.objectives} />
        </Card>
      )}
      {drep.motivations && (
        <Card>
          <h2 className="font-semibold text-[15px] mb-2 text-[var(--text-primary)]">{t('drepProfile.sections.motivations')}</h2>
          <ProseBlock text={drep.motivations} />
        </Card>
      )}
      {drep.qualifications && (
        <Card>
          <h2 className="font-semibold text-[15px] mb-2 text-[var(--text-primary)]">
            {t('drepProfile.sections.qualifications')}
          </h2>
          <ProseBlock text={drep.qualifications} />
        </Card>
      )}

      {/* General references */}
      {general.length > 0 && (
        <Card>
          <h2 className="font-semibold text-[15px] mb-2 text-[var(--text-primary)]">
            {t('drepProfile.sections.references')}
          </h2>
          <ul className="space-y-1.5">
            {general.map((ref, i) =>
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
                  <span className="text-xs">{t('drepProfile.unsupportedScheme')}</span>
                </li>
              ),
            )}
          </ul>
        </Card>
      )}

      {/* Recent votes. Predefined DReps don't have per-vote rows in the
          governance log — their auto-vote is applied at ratification and
          isn't recorded as an individual vote certificate. Show a static
          explainer rather than the empty-state "has not voted" copy that
          would imply they're inactive. */}
      <Card>
        <h2 className="font-semibold text-[15px] mb-3 text-[var(--text-primary)] flex items-center gap-2">
          {t('drepProfile.recentVotes.title')}
          <span className="text-[11px] text-[var(--text-tertiary)] font-normal ml-1">
            {t('drepProfile.recentVotes.lastTen')}
          </span>
        </h2>
        {drep.isPredefined ? (
          <p className="text-sm text-[var(--text-tertiary)]">
            {t('drepProfile.recentVotes.predefinedNote')}
          </p>
        ) : drep.recentVotes && drep.recentVotes.length > 0 ? (
          <ul className="space-y-1.5">
            {drep.recentVotes.map((v, i) => {
              const actionId = `${v.proposalTxHash}#${v.proposalIndex}`;
              const voteKey = v.vote.toLowerCase();
              const pillClass = VOTE_PILL_CLASS[voteKey] ?? VOTE_PILL_CLASS['abstain'];
              const typeLabel = KNOWN_ACTION_TYPES.has(v.proposalType)
                ? t(`drepProfile.actionTypes.${v.proposalType}`)
                : v.proposalType;
              return (
                <li key={`${actionId}-${i}`}>
                  <Link
                    to={`/governance/${encodeURIComponent(actionId)}`}
                    className={cn(
                      'flex items-center justify-between gap-3 px-3 py-2 -mx-3',
                      'rounded-token-md hover:bg-[var(--bg-muted)] transition-colors',
                    )}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={cn(
                          'inline-flex items-center text-[11px] font-semibold tracking-tight',
                          'px-2 py-0.5 rounded-token-full uppercase',
                          pillClass,
                        )}
                      >
                        {v.vote}
                      </span>
                      <span className="text-[11.5px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
                        {typeLabel}
                      </span>
                      <span className="text-[12px] font-mono text-[var(--text-muted)] truncate">
                        {shortHash(v.proposalTxHash)}#{v.proposalIndex}
                      </span>
                    </div>
                    <span className="flex-shrink-0 text-[11.5px] text-[var(--text-tertiary)] tabular-nums">
                      {formatRelativeTime(v.votedAt)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : drep.recentVotes ? (
          <p className="text-sm text-[var(--text-tertiary)]">
            {t('drepProfile.recentVotes.noVotes')}
          </p>
        ) : (
          <p className="text-sm text-[var(--text-tertiary)]">
            {t('drepProfile.recentVotes.unavailable')}
          </p>
        )}
      </Card>

      {/* Anchor footer */}
      {drep.anchorUrl && (
        <Card className="text-xs text-[var(--text-tertiary)] space-y-1">
          <div className="flex items-center gap-1.5 mb-1 text-[var(--text-secondary)] font-medium">
            {drep.anchorVerified === true ? (
              <CheckCircle2 size={13} strokeWidth={2} className="text-[var(--success)]" />
            ) : drep.anchorVerified === false ? (
              <AlertTriangle size={13} strokeWidth={2} className="text-[var(--warning)]" />
            ) : null}
            <span>{t('drepProfile.anchor.title')}</span>
          </div>
          <div>
            <span className="font-medium text-[var(--text-secondary)]">{t('drepProfile.anchor.url')}</span>
            <span className="break-all">{drep.anchorUrl}</span>
          </div>
          {drep.anchorHash && (
            <div>
              <span className="font-medium text-[var(--text-secondary)]">{t('drepProfile.anchor.hash')}</span>
              <span className="break-all font-mono">{drep.anchorHash}</span>
            </div>
          )}
          {drep.paymentAddress && (
            <div>
              <span className="font-medium text-[var(--text-secondary)]">{t('drepProfile.anchor.paymentAddress')}</span>
              <span className="break-all font-mono">{drep.paymentAddress}</span>
            </div>
          )}
          <div>
            <span className="font-medium text-[var(--text-secondary)]">{t('drepProfile.anchor.lastSynced')}</span>
            <span>{formatRelativeTime(drep.lastSyncedAt)}</span>
          </div>
        </Card>
      )}

      {/* Delegators link — relies on existing /drep/:drepId/delegators clubhouse route */}
      <div className="text-center pt-2">
        <Link
          to={`/drep/${encodeURIComponent(drep.drepId)}/delegators`}
          className={cn(
            'inline-flex items-center gap-1.5 text-[12.5px] font-medium',
            'text-[var(--brand-primary)] hover:underline',
          )}
        >
          <UsersIcon size={13} strokeWidth={2} aria-hidden="true" />
          {t('drepProfile.viewDelegators')}
        </Link>
      </div>
    </div>
  );
}
