/**
 * Shared helpers + types for the Clubhouse right-rail handlers.
 *
 * Two consumer files in this directory:
 *   - `activeThreads.ts` — ranks posts by "replies in the last 24h"
 *   - `topContributors.ts` — ranks wallets by clubhouse participation
 *
 * Both read the same underlying `clubhouse_posts` partition (Query by
 * `drepId`, paginate defensively in case row count ever exceeds the
 * 1MB DDB page cap). The pure-function rankers (`rankActiveThreads`,
 * `rankTopContributors`) are exported so the unit tests can drive
 * them directly without going through the Lambda handler shape.
 *
 * # In-Lambda cache (60s TTL)
 *
 * Both handlers cache the assembled result per `drepId` for 60
 * seconds at module scope. Pattern mirrors `lib/recognition.ts` —
 * a hot reload burst on the same clubhouse shares one Query.
 *
 * # Top-contributors metric: documented judgment call
 *
 * The locked spec text suggests aggregating "supportLovelace from
 * comment votes." That data lives on the Public Comments surface
 * (`comments` table, scoped to an `actionId`) — NOT on Clubhouse
 * comments (which live inline on `clubhouse_posts.comments[]` and
 * have no voting affordance today). Public Comments are not scoped
 * to a DRep, so "top contributors to THIS clubhouse" against the
 * comment_votes data is not implementable.
 *
 * Choice: use the in-clubhouse participation count as the ranking
 * metric. Score per wallet:
 *
 *     score = postsAuthored + commentsAuthored
 *
 * Ties broken by latest-contribution-timestamp descending. Auto-
 * post system wallets (`_system:governance_feed`) are excluded
 * because they're platform-owned, not user contributions.
 *
 * Stake-weighting is a future extension — the current
 * `clubhouse_posts.stakeAda` field is a pre-formatted display string
 * ("5.2M ₳") rather than a numeric lovelace value, so we can't
 * trivially weight today without a schema change.
 */

import { queryItems, tableNames } from '../../lib/dynamodb';
import type { ClubhousePostItem } from '../../lib/types';
import { AUTO_POST_AUTHOR_WALLET } from '../../sync/clubhouseAutoPosts';

export const DEFAULT_RAIL_LIMIT = 5;
export const MAX_RAIL_LIMIT = 25;
export const RAIL_CACHE_TTL_MS = 60_000;
export const RAIL_CACHE_MAX_ENTRIES = 200;

export interface ActiveThreadEntry {
  postId: string;
  /** Short title for the rail. Picked from `post.title` if present;
   *  falls back to a truncation of `post.body`. Capped at 80 chars. */
  title: string;
  /** Reply count over the last 24 hours. The primary ranking metric. */
  replyCount24h: number;
  /** ISO-8601 timestamp of the most recent reply on this post.
   *  Undefined when the post has no replies at all. */
  lastReplyAt?: string;
}

export interface TopContributorEntry {
  walletAddress: string;
  /** Resolved display name from the `users` table; undefined when the
   *  wallet has no profile. FE renders truncated bech32 in that case. */
  displayName?: string;
  /** Number of posts AND replies by this wallet in this clubhouse. */
  contributionCount: number;
}

/**
 * Read every post in this clubhouse via a single Query (paginated
 * defensively in case the per-clubhouse row count ever exceeds the
 * 1MB DDB page cap). Returns the raw items so both handlers can
 * derive their respective rankings without re-Querying.
 */
export async function fetchClubhousePosts(drepId: string): Promise<ClubhousePostItem[]> {
  const out: ClubhousePostItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  // Hard upper bound on pages — at ~50 posts/clubhouse and 1MB/page,
  // we should be done in one round-trip. The cap protects against a
  // pathological partition that somehow grew beyond a few thousand
  // rows (the cost would be the entire active-threads computation,
  // not the safety of the call).
  let pageGuard = 0;
  while (pageGuard++ < 10) {
    const result = await queryItems<ClubhousePostItem>(tableNames.clubhousePosts, {
      keyConditionExpression: '#drepId = :drepId',
      expressionAttributeNames: { '#drepId': 'drepId' },
      expressionAttributeValues: { ':drepId': drepId },
      ...(lastKey ? { exclusiveStartKey: lastKey } : {}),
    });
    for (const it of result.items) out.push(it);
    if (!result.lastEvaluatedKey) break;
    lastKey = result.lastEvaluatedKey;
  }
  return out;
}

export function parseRailLimit(raw: string | undefined): number {
  if (!raw) return DEFAULT_RAIL_LIMIT;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RAIL_LIMIT;
  return Math.min(n, MAX_RAIL_LIMIT);
}

/**
 * Compute the active-threads ranking from raw posts. Exported for
 * direct unit-testing without going through the Lambda handler shape.
 *
 * Ranking key: replies in the last 24 hours, descending. Posts with
 * zero recent replies are EXCLUDED. Ties broken by `lastReplyAt`
 * descending, then by `createdAt` descending so the rail surfaces
 * freshness. Auto-posts are excluded from the rail since they would
 * dominate every clubhouse on day one as platform-owned content; the
 * rail is about ORGANIC activity.
 *
 * `now` is injected so tests can pin time. `windowMs` defaults to 24h.
 */
export function rankActiveThreads(
  posts: readonly ClubhousePostItem[],
  options: { now: Date; windowMs?: number; limit: number },
): ActiveThreadEntry[] {
  const cutoff = options.now.getTime() - (options.windowMs ?? 24 * 60 * 60 * 1000);
  const entries: Array<ActiveThreadEntry & { _createdAt: string }> = [];
  for (const post of posts) {
    if (post.type === 'auto_ga') continue;

    const comments = Array.isArray(post.comments) ? post.comments : [];
    let recentCount = 0;
    let lastReplyAt: string | undefined;
    for (const c of comments) {
      if (typeof c.createdAt !== 'string') continue;
      const t = Date.parse(c.createdAt);
      if (!Number.isFinite(t)) continue;
      if (t >= cutoff) recentCount++;
      if (!lastReplyAt || c.createdAt.localeCompare(lastReplyAt) > 0) {
        lastReplyAt = c.createdAt;
      }
    }
    if (recentCount === 0) continue;

    // Title fallback — prefer `title`, then a truncation of the body.
    // Keep it tight so the rail doesn't wrap to multiple lines.
    let title =
      typeof post.title === 'string' && post.title.trim().length > 0
        ? post.title.trim()
        : typeof post.body === 'string'
          ? post.body.trim()
          : '';
    if (title.length > 80) title = `${title.slice(0, 77)}...`;
    if (!title) title = '(untitled post)';

    entries.push({
      postId: post.postId,
      title,
      replyCount24h: recentCount,
      ...(lastReplyAt ? { lastReplyAt } : {}),
      _createdAt: post.createdAt,
    });
  }

  entries.sort((a, b) => {
    if (b.replyCount24h !== a.replyCount24h) return b.replyCount24h - a.replyCount24h;
    if ((b.lastReplyAt ?? '') !== (a.lastReplyAt ?? '')) {
      return (b.lastReplyAt ?? '').localeCompare(a.lastReplyAt ?? '');
    }
    return b._createdAt.localeCompare(a._createdAt);
  });

  return entries.slice(0, options.limit).map(({ _createdAt: _unused, ...rest }) => rest);
}

/**
 * Compute the top-contributors ranking from raw posts. Exported for
 * direct unit-testing.
 *
 * Score per wallet:
 *   postsAuthored + commentsAuthored
 *
 * Wallets with score 0 are excluded by construction (they wouldn't
 * appear in any post or comment). Auto-post system wallets are
 * excluded. The returned tuples carry a `latestAt` field used for
 * tie-breaking; the calling handler resolves `displayName` from the
 * `users` table separately.
 */
export function rankTopContributors(
  posts: readonly ClubhousePostItem[],
  options: { limit: number },
): Array<{ walletAddress: string; contributionCount: number; latestAt: string }> {
  const scoreByWallet = new Map<string, { count: number; latestAt: string }>();
  const bump = (wallet: string, at: string): void => {
    if (!wallet || wallet === AUTO_POST_AUTHOR_WALLET) return;
    const existing = scoreByWallet.get(wallet);
    if (!existing) {
      scoreByWallet.set(wallet, { count: 1, latestAt: at });
      return;
    }
    existing.count += 1;
    if (at.localeCompare(existing.latestAt) > 0) existing.latestAt = at;
  };

  for (const post of posts) {
    if (post.type !== 'auto_ga' && typeof post.authorWallet === 'string') {
      // Skip the post itself if it's a system auto_ga; still walk its
      // organic replies below — delegators commenting on a governance-
      // feed thread are real contributors.
      bump(post.authorWallet, post.createdAt);
    }
    const comments = Array.isArray(post.comments) ? post.comments : [];
    for (const c of comments) {
      if (typeof c.authorWallet === 'string' && typeof c.createdAt === 'string') {
        bump(c.authorWallet, c.createdAt);
      }
    }
  }

  const entries = Array.from(scoreByWallet.entries()).map(([walletAddress, v]) => ({
    walletAddress,
    contributionCount: v.count,
    latestAt: v.latestAt,
  }));
  entries.sort((a, b) => {
    if (b.contributionCount !== a.contributionCount) {
      return b.contributionCount - a.contributionCount;
    }
    return b.latestAt.localeCompare(a.latestAt);
  });
  return entries.slice(0, options.limit);
}
