/**
 * Pure-function ranker tests for the Clubhouse right-rail.
 *
 * These exercise the in-memory ranking logic directly without going
 * through the Lambda handler shape. The handler tests below (in
 * `activeThreads.test.ts` and `topContributors.test.ts`) cover the
 * I/O wiring (DDB Query, cache, response envelope) but rely on these
 * tests for the correctness of the actual ranking semantics.
 *
 * Why split: the rankers have a lot of edge cases (24h window math,
 * tie-breaking, auto-post exclusion) and the cleanest way to cover
 * them is direct unit tests on the pure functions.
 */

import { describe, it, expect } from 'vitest';
import type { ClubhousePostItem } from '../../lib/types';
import { rankActiveThreads, rankTopContributors } from './_rail';
import { AUTO_POST_AUTHOR_WALLET } from '../../sync/clubhouseAutoPosts';

const DREP_ID = 'drep1ygqgayvx8yzsaj9hprja3l6jy3v4px9z3u8uvecuvm3f92ce7mckx';
const NOW = new Date('2026-05-27T12:00:00.000Z');

interface BuildPostOpts {
  postId: string;
  authorWallet?: string;
  title?: string;
  body?: string;
  type?: 'discussion' | 'question' | 'poll' | 'auto_ga';
  createdAt: string;
  comments?: Array<{ commentId: string; authorWallet: string; createdAt: string }>;
}

function buildPost(opts: BuildPostOpts): ClubhousePostItem {
  return {
    drepId: DREP_ID,
    postId: opts.postId,
    authorWallet: opts.authorWallet ?? 'stake1other',
    body: opts.body ?? 'a post body',
    comments: (opts.comments ?? []).map((c) => ({
      commentId: c.commentId,
      authorWallet: c.authorWallet,
      body: 'a reply',
      createdAt: c.createdAt,
    })),
    isDRepPost: false,
    createdAt: opts.createdAt,
    updatedAt: opts.createdAt,
    ...(opts.title ? { title: opts.title } : {}),
    ...(opts.type ? { type: opts.type } : {}),
  };
}

describe('rankActiveThreads', () => {
  it('returns top N posts by reply count in the last 24h', () => {
    const posts: ClubhousePostItem[] = [
      buildPost({
        postId: 'p1',
        title: 'Treasury withdrawal',
        createdAt: '2026-05-20T00:00:00.000Z',
        comments: [
          // Recent (within 24h): 3 replies
          { commentId: 'c1', authorWallet: 'w1', createdAt: '2026-05-27T08:00:00.000Z' },
          { commentId: 'c2', authorWallet: 'w2', createdAt: '2026-05-27T09:00:00.000Z' },
          { commentId: 'c3', authorWallet: 'w3', createdAt: '2026-05-27T10:00:00.000Z' },
        ],
      }),
      buildPost({
        postId: 'p2',
        title: 'Constitutional update',
        createdAt: '2026-05-15T00:00:00.000Z',
        comments: [
          // Recent (within 24h): 1 reply
          { commentId: 'c4', authorWallet: 'w1', createdAt: '2026-05-27T11:00:00.000Z' },
          // Old (outside 24h): does NOT count
          { commentId: 'c5', authorWallet: 'w2', createdAt: '2026-04-01T00:00:00.000Z' },
        ],
      }),
      buildPost({
        postId: 'p3',
        title: 'CC vote breakdown',
        createdAt: '2026-05-25T00:00:00.000Z',
        comments: [
          // Recent (within 24h): 2 replies
          { commentId: 'c6', authorWallet: 'w1', createdAt: '2026-05-27T07:00:00.000Z' },
          { commentId: 'c7', authorWallet: 'w2', createdAt: '2026-05-27T08:00:00.000Z' },
        ],
      }),
    ];

    const result = rankActiveThreads(posts, { now: NOW, limit: 5 });

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ postId: 'p1', replyCount24h: 3 });
    expect(result[1]).toMatchObject({ postId: 'p3', replyCount24h: 2 });
    expect(result[2]).toMatchObject({ postId: 'p2', replyCount24h: 1 });
  });

  it('excludes posts with zero recent replies entirely', () => {
    const posts: ClubhousePostItem[] = [
      buildPost({
        postId: 'p1',
        title: 'Has recent',
        createdAt: '2026-05-20T00:00:00.000Z',
        comments: [
          { commentId: 'c1', authorWallet: 'w1', createdAt: '2026-05-27T08:00:00.000Z' },
        ],
      }),
      buildPost({
        postId: 'p2',
        title: 'Only old',
        createdAt: '2026-04-01T00:00:00.000Z',
        comments: [
          { commentId: 'c2', authorWallet: 'w1', createdAt: '2026-04-02T00:00:00.000Z' },
        ],
      }),
      buildPost({ postId: 'p3', title: 'No replies', createdAt: '2026-05-26T00:00:00.000Z' }),
    ];

    const result = rankActiveThreads(posts, { now: NOW, limit: 5 });

    expect(result).toHaveLength(1);
    expect(result[0]!.postId).toBe('p1');
  });

  it('excludes auto_ga posts from the rail', () => {
    const posts: ClubhousePostItem[] = [
      buildPost({
        postId: 'auto-ga#abc',
        type: 'auto_ga',
        title: 'GA: Auto-generated',
        createdAt: '2026-05-26T00:00:00.000Z',
        comments: [
          { commentId: 'c1', authorWallet: 'w1', createdAt: '2026-05-27T08:00:00.000Z' },
        ],
      }),
      buildPost({
        postId: 'p1',
        title: 'Organic',
        createdAt: '2026-05-26T00:00:00.000Z',
        comments: [
          { commentId: 'c2', authorWallet: 'w1', createdAt: '2026-05-27T09:00:00.000Z' },
        ],
      }),
    ];

    const result = rankActiveThreads(posts, { now: NOW, limit: 5 });

    expect(result.map((r) => r.postId)).toEqual(['p1']);
  });

  it('truncates titles longer than 80 chars and falls back to body when title missing', () => {
    const longTitle = 'A'.repeat(150);
    const posts: ClubhousePostItem[] = [
      buildPost({
        postId: 'p1',
        title: longTitle,
        createdAt: '2026-05-26T00:00:00.000Z',
        comments: [
          { commentId: 'c1', authorWallet: 'w1', createdAt: '2026-05-27T08:00:00.000Z' },
        ],
      }),
      buildPost({
        postId: 'p2',
        body: 'a useful body but no title field',
        createdAt: '2026-05-26T00:00:00.000Z',
        comments: [
          { commentId: 'c2', authorWallet: 'w1', createdAt: '2026-05-27T08:00:00.000Z' },
        ],
      }),
    ];

    const result = rankActiveThreads(posts, { now: NOW, limit: 5 });

    const titles = result.map((r) => r.title);
    // First post: truncated to 80 chars ending in "..."
    expect(titles[0]!.length).toBe(80);
    expect(titles[0]!.endsWith('...')).toBe(true);
    // Second post: body used in place of title
    expect(titles[1]).toBe('a useful body but no title field');
  });

  it('ties broken by lastReplyAt desc then createdAt desc', () => {
    const posts: ClubhousePostItem[] = [
      buildPost({
        postId: 'p1',
        title: 'Older latest reply',
        createdAt: '2026-05-25T00:00:00.000Z',
        comments: [
          { commentId: 'c1', authorWallet: 'w1', createdAt: '2026-05-27T08:00:00.000Z' },
          { commentId: 'c2', authorWallet: 'w2', createdAt: '2026-05-27T09:00:00.000Z' },
        ],
      }),
      buildPost({
        postId: 'p2',
        title: 'Newer latest reply',
        createdAt: '2026-05-20T00:00:00.000Z',
        comments: [
          { commentId: 'c3', authorWallet: 'w1', createdAt: '2026-05-27T07:00:00.000Z' },
          { commentId: 'c4', authorWallet: 'w2', createdAt: '2026-05-27T11:00:00.000Z' },
        ],
      }),
    ];

    const result = rankActiveThreads(posts, { now: NOW, limit: 5 });

    expect(result.map((r) => r.postId)).toEqual(['p2', 'p1']);
  });

  it('respects the limit parameter', () => {
    const posts: ClubhousePostItem[] = Array.from({ length: 10 }, (_, i) =>
      buildPost({
        postId: `p${i}`,
        title: `Post ${i}`,
        createdAt: '2026-05-26T00:00:00.000Z',
        comments: [
          {
            commentId: `c${i}`,
            authorWallet: 'w1',
            // Stagger times so ordering is stable
            createdAt: `2026-05-27T${String(i).padStart(2, '0')}:00:00.000Z`,
          },
        ],
      }),
    );

    expect(rankActiveThreads(posts, { now: NOW, limit: 3 })).toHaveLength(3);
    expect(rankActiveThreads(posts, { now: NOW, limit: 100 }).length).toBeLessThanOrEqual(10);
  });

  it('returns empty array when there are no posts', () => {
    expect(rankActiveThreads([], { now: NOW, limit: 5 })).toEqual([]);
  });

  it('ignores malformed comment timestamps', () => {
    const posts: ClubhousePostItem[] = [
      buildPost({
        postId: 'p1',
        title: 'Has bad timestamps',
        createdAt: '2026-05-26T00:00:00.000Z',
        comments: [
          { commentId: 'c1', authorWallet: 'w1', createdAt: 'not-a-date' },
          { commentId: 'c2', authorWallet: 'w2', createdAt: '2026-05-27T10:00:00.000Z' },
        ],
      }),
    ];

    const result = rankActiveThreads(posts, { now: NOW, limit: 5 });

    expect(result).toHaveLength(1);
    expect(result[0]!.replyCount24h).toBe(1);
  });

  it('honors a custom window (e.g. 1 hour instead of 24h)', () => {
    const posts: ClubhousePostItem[] = [
      buildPost({
        postId: 'p1',
        title: 'p1',
        createdAt: '2026-05-26T00:00:00.000Z',
        comments: [
          // 5 hours ago — outside a 1h window
          { commentId: 'c1', authorWallet: 'w1', createdAt: '2026-05-27T07:00:00.000Z' },
          // 30 min ago — inside
          { commentId: 'c2', authorWallet: 'w2', createdAt: '2026-05-27T11:30:00.000Z' },
        ],
      }),
    ];

    const result = rankActiveThreads(posts, {
      now: NOW,
      windowMs: 60 * 60 * 1000,
      limit: 5,
    });

    expect(result[0]!.replyCount24h).toBe(1);
  });
});

describe('rankTopContributors', () => {
  it('ranks by post + comment count across all posts', () => {
    const posts: ClubhousePostItem[] = [
      buildPost({
        postId: 'p1',
        authorWallet: 'walletA',
        createdAt: '2026-05-20T00:00:00.000Z',
        comments: [
          { commentId: 'c1', authorWallet: 'walletA', createdAt: '2026-05-21T00:00:00.000Z' },
          { commentId: 'c2', authorWallet: 'walletB', createdAt: '2026-05-22T00:00:00.000Z' },
        ],
      }),
      buildPost({
        postId: 'p2',
        authorWallet: 'walletB',
        createdAt: '2026-05-23T00:00:00.000Z',
        comments: [
          { commentId: 'c3', authorWallet: 'walletC', createdAt: '2026-05-24T00:00:00.000Z' },
        ],
      }),
    ];

    const result = rankTopContributors(posts, { limit: 5 });

    // walletA: 1 post + 1 comment = 2
    // walletB: 1 post + 1 comment = 2
    // walletC: 1 comment = 1
    expect(result).toHaveLength(3);
    // walletA and walletB are tied at 2; walletB wins tiebreak (later latestAt)
    expect(result[0]!.walletAddress).toBe('walletB');
    expect(result[0]!.contributionCount).toBe(2);
    expect(result[1]!.walletAddress).toBe('walletA');
    expect(result[1]!.contributionCount).toBe(2);
    expect(result[2]!.walletAddress).toBe('walletC');
    expect(result[2]!.contributionCount).toBe(1);
  });

  it('excludes the auto-post system wallet from the contributor list', () => {
    const posts: ClubhousePostItem[] = [
      buildPost({
        postId: 'auto-ga#abc',
        authorWallet: AUTO_POST_AUTHOR_WALLET,
        type: 'auto_ga',
        createdAt: '2026-05-20T00:00:00.000Z',
        comments: [
          // Real delegators replying to a governance-feed post still count
          { commentId: 'c1', authorWallet: 'walletA', createdAt: '2026-05-21T00:00:00.000Z' },
        ],
      }),
      buildPost({
        postId: 'p1',
        authorWallet: 'walletB',
        createdAt: '2026-05-22T00:00:00.000Z',
      }),
    ];

    const result = rankTopContributors(posts, { limit: 5 });

    expect(result.map((r) => r.walletAddress)).not.toContain(AUTO_POST_AUTHOR_WALLET);
    expect(result.map((r) => r.walletAddress).sort()).toEqual(['walletA', 'walletB']);
  });

  it('returns empty array when there are no posts', () => {
    expect(rankTopContributors([], { limit: 5 })).toEqual([]);
  });

  it('respects the limit parameter', () => {
    const posts: ClubhousePostItem[] = Array.from({ length: 10 }, (_, i) =>
      buildPost({
        postId: `p${i}`,
        authorWallet: `w${i}`,
        createdAt: `2026-05-${String(20 + i).padStart(2, '0')}T00:00:00.000Z`,
      }),
    );

    expect(rankTopContributors(posts, { limit: 3 })).toHaveLength(3);
    expect(rankTopContributors(posts, { limit: 100 })).toHaveLength(10);
  });

  it('tracks the latest contribution timestamp for tie-breaking', () => {
    const posts: ClubhousePostItem[] = [
      buildPost({
        postId: 'p1',
        authorWallet: 'walletA',
        createdAt: '2026-05-20T00:00:00.000Z',
        comments: [
          // walletA latest contribution: 2026-05-26
          { commentId: 'c1', authorWallet: 'walletA', createdAt: '2026-05-26T00:00:00.000Z' },
        ],
      }),
      buildPost({
        postId: 'p2',
        authorWallet: 'walletB',
        // walletB latest contribution: 2026-05-21
        createdAt: '2026-05-21T00:00:00.000Z',
        comments: [
          { commentId: 'c2', authorWallet: 'walletB', createdAt: '2026-05-21T00:00:00.000Z' },
        ],
      }),
    ];

    const result = rankTopContributors(posts, { limit: 5 });

    // Both tied at 2; walletA wins because latestAt is newer.
    expect(result[0]!.walletAddress).toBe('walletA');
    expect(result[1]!.walletAddress).toBe('walletB');
  });
});
