/**
 * Canary test for the "N wallets" badge promoted alongside the
 * support-stake display on `CommentList` rows (Batch REVAL, 2026-05-29).
 *
 * # Why this test exists
 *
 * The Sybil-defense PR's UX change is to promote `upvoteCount` from a
 * hover-tooltip detail to a co-equal visible badge: a reader sees both
 * the backing-wallet count AND the support stake at a glance,
 * exposing concentration ("5 wallets · 2M ₳" vs "200 wallets · 2M ₳").
 *
 * This test pins three things:
 *   1. The wallet count renders alongside the support stake on a
 *      comment with multiple upvotes.
 *   2. Singular vs plural: "1 wallet" vs "5 wallets".
 *   3. The tooltip retains the full up+down breakdown (the detail
 *      moved from the visible label, but didn't disappear).
 *
 * # Mocking strategy
 *
 * `CommentList` consumes a handful of stores + hooks that aren't
 * load-bearing for the wallet-count badge. We mock them at the module
 * boundary with minimal shapes so the render doesn't try to spin up a
 * real QueryClient / auth store.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { CommentList } from './CommentList';
import type { Comment } from '@/types';

vi.mock('@/stores/authStore', () => ({
  useAuthStore: (): { walletAddress: string | null; roles: string[] } => ({
    walletAddress: null,
    roles: [],
  }),
  useIsAuthenticated: (): boolean => false,
}));

vi.mock('@/stores/uiStore', () => ({
  useUiStore: (): { addToast: () => void } => ({ addToast: vi.fn() }),
}));

vi.mock('@/hooks/useComments', () => ({
  useDeleteComment: (): {
    mutate: ReturnType<typeof vi.fn>;
    isPending: boolean;
  } => ({ mutate: vi.fn(), isPending: false }),
  useMyCommentVotes: (): { data: { votes: Record<string, never> } } => ({
    data: { votes: {} },
  }),
  useVoteComment: (): {
    mutateAsync: ReturnType<typeof vi.fn>;
    isPending: boolean;
  } => ({ mutateAsync: vi.fn().mockResolvedValue(undefined), isPending: false }),
}));

function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    actionId: 'aaaa#0',
    commentId: 'cmt-1',
    walletAddress:
      'stake1uyvjdz9rxsfsmv44rtk75k2rqyqskrga96dgdfrqjvjjpwsefcjnp',
    body: 'A comment.',
    isPublic: true,
    isDRep: false,
    createdAt: '2026-05-25T00:00:00.000Z',
    updatedAt: '2026-05-25T00:00:00.000Z',
    supportLovelace: '5000000000000', // 5M ADA
    upvoteCount: 5,
    downvoteCount: 1,
    ...overrides,
  };
}

describe('CommentList — wallet-count badge (Batch REVAL)', () => {
  it("renders the plural 'N wallets' badge alongside the support-stake display", () => {
    const { getByTestId, getByText } = render(
      <CommentList
        comments={[makeComment({ upvoteCount: 5 })]}
        actionId="aaaa#0"
      />,
    );
    // Wallet count badge present and visible.
    const walletBadge = getByTestId('comment-wallet-count');
    expect(walletBadge).toBeInTheDocument();
    expect(walletBadge.textContent).toContain('5');
    expect(walletBadge.textContent).toContain('wallets');
    // The support stake is still rendered alongside it.
    expect(getByText(/5M ADA/)).toBeInTheDocument();
  });

  it("renders the SINGULAR 'wallet' label when upvoteCount is 1 (grammar)", () => {
    const { getByTestId } = render(
      <CommentList
        comments={[
          makeComment({
            upvoteCount: 1,
            downvoteCount: 0,
            supportLovelace: '1000000000',
          }),
        ]}
        actionId="aaaa#0"
      />,
    );
    const walletBadge = getByTestId('comment-wallet-count');
    expect(walletBadge.textContent).toContain('1');
    expect(walletBadge.textContent).toMatch(/wallet\b/);
    expect(walletBadge.textContent).not.toMatch(/wallets/);
  });

  it("tooltip retains the full up+down breakdown after promoting the wallet count to the visible badge", () => {
    const { getByTestId } = render(
      <CommentList
        comments={[makeComment({ upvoteCount: 5, downvoteCount: 2 })]}
        actionId="aaaa#0"
      />,
    );
    const walletBadge = getByTestId('comment-wallet-count');
    // The title attribute encodes the full audit detail: backing
    // wallets (upvotes) + downvote count. The visible label is
    // promoted but the detail isn't lost.
    const title = walletBadge.getAttribute('title') ?? '';
    expect(title).toContain('5 backing wallets');
    expect(title).toContain('2 downvotes');
  });
});
