/**
 * Tests for the Sprint 4 community-flag affordance on `CommentList`.
 *
 * Pins the FE contract from the brief:
 *
 *   - The flag button appears ONLY for callers who have proved at
 *     least one on-chain role (`drep` / `spo` / `cc` / `proposer`).
 *     A wallet-connected delegator with no on-chain proof must not
 *     see the affordance.
 *   - A `hidden: true` row (which only `platform_admin`s receive on
 *     the wire) renders the moderation banner BEFORE the body so
 *     the moderator can't miss the state. The body itself stays
 *     visible so the moderator can decide whether to reverse the
 *     community decision.
 *   - The author's own comment never shows the flag button (so the
 *     self-flag 400 from the backend never fires).
 *
 * # Mocking
 *
 * The component pulls a handful of hooks/stores that aren't load-
 * bearing for these gates. We stub them at the module boundary with
 * the same minimal shapes used in `CommentList.test.tsx`, parametrised
 * by `currentAuthMock` so each test can swap the on-chain-roles
 * surface.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { CommentList } from './CommentList';
import type { Comment } from '@/types';

// We re-stub `@/stores/authStore` per-test via the dynamic mock
// returned below. The mock factory reads from `authStubState` which
// the test mutates before render.
const authStubState: {
  walletAddress: string | null;
  roles: string[];
  isAuthenticated: boolean;
  onChainRoles: string[];
} = {
  walletAddress: null,
  roles: [],
  isAuthenticated: false,
  onChainRoles: [],
};

vi.mock('@/stores/authStore', () => ({
  useAuthStore: (): { walletAddress: string | null; roles: string[] } => ({
    walletAddress: authStubState.walletAddress,
    roles: authStubState.roles,
  }),
  useIsAuthenticated: (): boolean => authStubState.isAuthenticated,
  useOnChainRoles: (): string[] => authStubState.onChainRoles,
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
  useFlagComment: (): {
    mutateAsync: ReturnType<typeof vi.fn>;
    isPending: boolean;
  } => ({ mutateAsync: vi.fn().mockResolvedValue(undefined), isPending: false }),
}));

function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    actionId: 'aaaa#0',
    commentId: 'cmt-target',
    walletAddress:
      'stake1uyvjdz9rxsfsmv44rtk75k2rqyqskrga96dgdfrqjvjjpwsefcjnp',
    body: 'A regular comment body.',
    isPublic: true,
    isDRep: false,
    createdAt: '2026-05-25T00:00:00.000Z',
    updatedAt: '2026-05-25T00:00:00.000Z',
    supportLovelace: '5000000000000',
    upvoteCount: 5,
    downvoteCount: 0,
    ...overrides,
  };
}

describe('CommentList — Sprint 4 community-flag affordance', () => {
  beforeEach(() => {
    // Reset the auth stub between tests.
    authStubState.walletAddress = null;
    authStubState.roles = [];
    authStubState.isAuthenticated = false;
    authStubState.onChainRoles = [];
  });

  it('does NOT render the flag button for an UNAUTHENTICATED caller', () => {
    const { queryByTestId } = render(
      <CommentList comments={[makeComment()]} actionId="aaaa#0" />,
    );
    expect(queryByTestId('comment-flag-button')).toBeNull();
  });

  it('does NOT render the flag button for an authenticated caller WITHOUT on-chain roles', () => {
    authStubState.walletAddress = 'stake1uplaincallerxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    authStubState.roles = ['delegator'];
    authStubState.isAuthenticated = true;
    authStubState.onChainRoles = []; // ← KEY: empty array gates out

    const { queryByTestId } = render(
      <CommentList comments={[makeComment()]} actionId="aaaa#0" />,
    );
    expect(queryByTestId('comment-flag-button')).toBeNull();
  });

  it('DOES render the flag button for an authenticated caller WITH an on-chain role', () => {
    authStubState.walletAddress = 'stake1uonchaincaller2xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    authStubState.roles = ['delegator'];
    authStubState.isAuthenticated = true;
    authStubState.onChainRoles = ['drep'];

    const { queryByTestId } = render(
      <CommentList comments={[makeComment()]} actionId="aaaa#0" />,
    );
    const flagButton = queryByTestId('comment-flag-button');
    expect(flagButton).toBeInTheDocument();
    // Default label is "Flag" (not "Flagged" — the user hasn't clicked).
    expect(flagButton?.textContent).toMatch(/Flag/);
    expect(flagButton?.textContent).not.toMatch(/Flagged/);
  });

  it('does NOT render the flag button on the AUTHOR own comment (self-flag UX gate)', () => {
    const AUTHOR = 'stake1uauthorownxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    authStubState.walletAddress = AUTHOR;
    authStubState.roles = ['delegator'];
    authStubState.isAuthenticated = true;
    authStubState.onChainRoles = ['drep'];

    const { queryByTestId } = render(
      <CommentList
        comments={[makeComment({ walletAddress: AUTHOR })]}
        actionId="aaaa#0"
      />,
    );
    expect(queryByTestId('comment-flag-button')).toBeNull();
  });

  it('renders the "Hidden by community" banner on a hidden row (admin view) AND the body stays visible', () => {
    authStubState.walletAddress = 'stake1uadminxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    authStubState.roles = ['platform_admin'];
    authStubState.isAuthenticated = true;
    authStubState.onChainRoles = ['drep'];

    const { queryByTestId, queryByText } = render(
      <CommentList
        comments={[
          makeComment({
            commentId: 'hidden-1',
            body: 'A flagged comment.',
            hidden: true,
            flagCount: 3,
          }),
        ]}
        actionId="aaaa#0"
      />,
    );
    const banner = queryByTestId('comment-hidden-banner');
    expect(banner).toBeInTheDocument();
    // The flag count is encoded in the banner label so the moderator
    // can see "3 flags" at a glance.
    expect(banner?.textContent).toMatch(/3/);
    // The body itself REMAINS rendered — the moderator needs to read
    // it to decide whether to reverse the community decision. Flag,
    // NOT hide-from-admin.
    expect(queryByText('A flagged comment.')).toBeInTheDocument();
  });

  it('does NOT render the hidden banner on a row without the hidden marker (normal case)', () => {
    authStubState.walletAddress = 'stake1uadminxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    authStubState.roles = ['platform_admin'];
    authStubState.isAuthenticated = true;
    authStubState.onChainRoles = ['drep'];

    const { queryByTestId } = render(
      <CommentList comments={[makeComment()]} actionId="aaaa#0" />,
    );
    expect(queryByTestId('comment-hidden-banner')).toBeNull();
  });
});
