import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Sparkles, Users } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { useActiveThreads, useTopContributors } from '@/hooks/useClubhouseRail';
import { useFormatters } from '@/hooks/useFormatters';
import { formatWalletAddress } from '@/lib/utils';

/**
 * Right-rail for the Delegator Clubhouse.
 *
 * Two real-data cards (no longer "Soon" placeholders):
 *   - Active threads — top 5 posts by replies in the last 24h. Each
 *     entry is a deep-link back to the clubhouse with the post id in
 *     the URL fragment, so the dedicated post handler can scroll to
 *     it when we land that view (for now the fragment is purely
 *     informational — the clubhouse renders a flat list).
 *   - Top contributors — top 5 wallets by participation in this
 *     clubhouse. See `backend/src/handlers/clubhouse/_rail.ts` for the
 *     scoring formula and why we don't stake-weight today.
 *
 * Empty states render distinct copy ("be first") rather than hiding
 * the card so the rail layout stays stable across clubhouses.
 *
 * Loading skeletons render at the same row height as the populated
 * row so the layout doesn't jump when the data lands.
 */
interface ClubhouseRailProps {
  /** The DRep whose clubhouse is currently being viewed. Both rail
   *  cards key their queries off this. When absent, both queries are
   *  short-circuited via `enabled: false` and we render the empty
   *  states. */
  drepId: string;
}

export function ClubhouseRail({ drepId }: ClubhouseRailProps): React.ReactElement {
  return (
    <>
      <ActiveThreadsCard drepId={drepId} />
      <TopContributorsCard drepId={drepId} />
    </>
  );
}

// ---- Active threads card ----

function ActiveThreadsCard({ drepId }: { drepId: string }): React.ReactElement {
  const { t } = useTranslation();
  const { formatRelativeTime } = useFormatters();
  const { data, isLoading } = useActiveThreads(drepId);
  const threads = data?.items ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <Sparkles size={14} strokeWidth={2} className="text-[var(--brand-primary)]" />
          {t('clubhouseRail.activeThreads')}
        </CardTitle>
      </CardHeader>
      {isLoading ? (
        <ul className="space-y-3 text-sm" aria-busy="true">
          {Array.from({ length: 3 }).map((_, i) => (
            <li
              key={i}
              className="h-4 rounded-token-md bg-[var(--bg-muted)] animate-pulse"
            />
          ))}
        </ul>
      ) : threads.length === 0 ? (
        <p className="text-[12.5px] text-[var(--text-tertiary)] italic">
          {t('clubhouseRail.noActiveThreads')}
        </p>
      ) : (
        <ul className="space-y-3 text-sm">
          {threads.map((thread) => (
            <li
              key={thread.postId}
              className="flex items-start justify-between gap-2 text-[var(--text-secondary)]"
              title={
                thread.lastReplyAt
                  ? t('clubhouseRail.lastReply', {
                      time: formatRelativeTime(thread.lastReplyAt),
                    })
                  : undefined
              }
            >
              {/* Deep-link to the clubhouse with the post id in the
                  fragment. The clubhouse page itself renders a flat
                  list today, so the fragment is informational — once
                  we add scroll-to-post behavior, the link will land
                  the reader on the thread. */}
              <Link
                to={`/drep/${encodeURIComponent(drepId)}/delegators#${encodeURIComponent(thread.postId)}`}
                className="truncate hover:text-[var(--text-primary)] hover:underline"
              >
                {thread.title}
              </Link>
              <span
                className="text-[11px] text-[var(--text-tertiary)] tabular-nums flex-shrink-0"
                aria-label={t('clubhouseRail.repliesIn24h', {
                  count: thread.replyCount24h,
                })}
              >
                {thread.replyCount24h}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---- Top contributors card ----

function TopContributorsCard({ drepId }: { drepId: string }): React.ReactElement {
  const { t } = useTranslation();
  const { data, isLoading } = useTopContributors(drepId);
  const contributors = data?.items ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <Users size={14} strokeWidth={2} className="text-[var(--brand-primary)]" />
          {t('clubhouseRail.topContributors')}
        </CardTitle>
      </CardHeader>
      {isLoading ? (
        <ol className="space-y-2.5 text-sm" aria-busy="true">
          {Array.from({ length: 3 }).map((_, i) => (
            <li
              key={i}
              className="h-7 rounded-token-md bg-[var(--bg-muted)] animate-pulse"
            />
          ))}
        </ol>
      ) : contributors.length === 0 ? (
        <p className="text-[12.5px] text-[var(--text-tertiary)] italic">
          {t('clubhouseRail.noContributors')}
        </p>
      ) : (
        <ol className="space-y-2.5 text-sm">
          {contributors.map((c, i) => {
            // Resolved displayName if available, else a truncated bech32.
            // Truncation length mirrors the rest of the app
            // (`formatWalletAddress` default = 8 chars per side).
            const label = c.displayName ?? formatWalletAddress(c.walletAddress);
            // Two-letter initial badge from whatever label we have.
            const initial = label.replace(/\W+/g, '').slice(0, 2).toUpperCase() || '??';
            return (
              <li key={c.walletAddress} className="flex items-center gap-3">
                <span className="text-[11px] font-semibold text-[var(--text-tertiary)] w-4 tabular-nums">
                  {i + 1}
                </span>
                <span
                  className="w-7 h-7 rounded-token-full bg-[var(--brand-primary-soft)] text-[var(--brand-primary)] flex items-center justify-center text-[11px] font-semibold flex-shrink-0"
                  aria-hidden="true"
                >
                  {initial}
                </span>
                <span
                  className="flex-1 truncate text-[var(--text-secondary)]"
                  title={c.walletAddress}
                >
                  {label}
                </span>
                <span
                  className="text-[11px] tabular-nums text-[var(--text-tertiary)]"
                  aria-label={t('clubhouseRail.contributions', {
                    count: c.contributionCount,
                  })}
                >
                  {c.contributionCount}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
