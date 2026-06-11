/**
 * Canary test for the Clubhouse comment depth cap.
 *
 * The Clubhouse surface allows 2 levels of comment nesting (top → reply
 * → sub-reply), one deeper than the Public Comments surface. Defense
 * in depth lives on both the backend (rejects 3-deep submissions with
 * 400) and the frontend (hides the Reply affordance on depth-2 rows so
 * the UI can't accidentally surface a path that would 400 on submit).
 *
 * This test pins the frontend half of that contract:
 *   - depth=0 and depth=1 → Reply button rendered when the wallet is
 *     authenticated.
 *   - depth=2 (sub-reply) → Reply button NOT rendered, regardless of
 *     auth state.
 *
 * # Why we mock the useCreateClubhouseComment hook
 *
 * The row instantiates `useCreateClubhouseComment` even when the user
 * has no intent to submit. We mock to a no-op hook so the test doesn't
 * try to spin up a real QueryClient or hit the network.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ClubhouseCommentRow } from './DelegatorClubhouse';
import type { ClubhouseComment } from '@/types';

vi.mock('@/hooks/useClubhouse', () => ({
  // The component only USES these hooks to handle submission; the
  // actual mutation surfaces aren't exercised by depth-rendering tests.
  // Returning minimal shapes keeps the depth checks isolated.
  useCreateClubhouseComment: (): {
    mutateAsync: ReturnType<typeof vi.fn>;
    isPending: boolean;
  } => ({
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
  }),
  useFlagClubhouseComment: (): {
    mutateAsync: ReturnType<typeof vi.fn>;
    isPending: boolean;
  } => ({
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
  }),
}));

// `useOnChainRoles` lives on the auth store; `useUiStore.addToast` is
// only used in the flag-error path. Stub both so the depth-rendering
// tests don't have to spin up real stores. Tests that exercise the
// flag affordance below override `useOnChainRoles` per-test.
const authStubState: { onChainRoles: string[] } = { onChainRoles: [] };
vi.mock('@/stores/authStore', () => ({
  useOnChainRoles: (): string[] => authStubState.onChainRoles,
}));
vi.mock('@/stores/uiStore', () => ({
  useUiStore: (): { addToast: ReturnType<typeof vi.fn> } => ({
    addToast: vi.fn(),
  }),
}));

function makeComment(overrides: Partial<ClubhouseComment> = {}): ClubhouseComment {
  return {
    commentId: 'cmt-1',
    authorWallet: 'addr1q9testwalletaddressxxxxxxxxxxxxxxxx',
    authorDisplayName: 'Test Delegator',
    body: 'Hello clubhouse.',
    createdAt: '2026-05-25T12:00:00.000Z',
    ...overrides,
  };
}

describe('ClubhouseCommentRow — depth cap', () => {
  const repliesByParent = new Map<string, ClubhouseComment[]>();
  const currentWallet = 'addr1q9currentwallet';
  const drepId = 'drep1ygqgayvx8yzsaj9hprja3l6jy3v4px9z3u8uvecuvm3f92ce7mckx';
  const postId = 'auto-ga#abc123';

  it('renders the Reply button at depth 0 (top-level comment)', () => {
    const { queryByText } = render(
      <MemoryRouter>
        <ClubhouseCommentRow
          comment={makeComment()}
          depth={0}
          drepId={drepId}
          postId={postId}
          currentWallet={currentWallet}
          repliesByParent={repliesByParent}
        />
      </MemoryRouter>,
    );
    expect(queryByText('Reply')).toBeInTheDocument();
  });

  it('renders the Reply button at depth 1 (one level of reply allowed)', () => {
    const { queryByText } = render(
      <MemoryRouter>
        <ClubhouseCommentRow
          comment={makeComment({ commentId: 'cmt-reply', parentCommentId: 'cmt-1' })}
          depth={1}
          drepId={drepId}
          postId={postId}
          currentWallet={currentWallet}
          repliesByParent={repliesByParent}
        />
      </MemoryRouter>,
    );
    expect(queryByText('Reply')).toBeInTheDocument();
  });

  it('does NOT render the Reply button at depth 2 (the sub-reply cap)', () => {
    const { queryByText } = render(
      <MemoryRouter>
        <ClubhouseCommentRow
          comment={makeComment({ commentId: 'cmt-sub', parentCommentId: 'cmt-reply' })}
          depth={2}
          drepId={drepId}
          postId={postId}
          currentWallet={currentWallet}
          repliesByParent={repliesByParent}
        />
      </MemoryRouter>,
    );
    // The button is conditionally rendered on `canReply = depth < 2`.
    // At depth 2 the button must not appear in the DOM.
    expect(queryByText('Reply')).toBeNull();
  });

  it('does NOT render the Reply button when the user is unauthenticated, even at depth 0', () => {
    const { queryByText } = render(
      <MemoryRouter>
        <ClubhouseCommentRow
          comment={makeComment()}
          depth={0}
          drepId={drepId}
          postId={postId}
          currentWallet={null}
          repliesByParent={repliesByParent}
        />
      </MemoryRouter>,
    );
    expect(queryByText('Reply')).toBeNull();
  });
});

/**
 * Batch CLUBHOUSE-DELEGATION-GATE (2026-05-30) — comment badge tests.
 *
 * The 3-hour clubhouse-delegation sweep sets
 * `authorDelegationActive: false` on `clubhouse_comments` rows whose
 * author has un-delegated from the clubhouse's DRep. The frontend
 * renders a subtle "No longer delegated" badge in the comment header
 * — the comment body stays fully visible (flag, NOT hide; per the
 * owner's locked decision). The badge is rendered strictly on the
 * exact `=== false` value so existing rows (absent / `true` /
 * `undefined`) render unchanged.
 */
describe('ClubhouseCommentRow — delegation-active badge', () => {
  const repliesByParent = new Map<string, ClubhouseComment[]>();
  const currentWallet = 'addr1q9currentwallet';
  const drepId = 'drep1ygqgayvx8yzsaj9hprja3l6jy3v4px9z3u8uvecuvm3f92ce7mckx';
  const postId = 'auto-ga#abc123';

  it('renders the "No longer delegated" badge when authorDelegationActive === false', () => {
    const { queryByTestId, queryByText } = render(
      <MemoryRouter>
        <ClubhouseCommentRow
          comment={makeComment({ authorDelegationActive: false })}
          depth={0}
          drepId={drepId}
          postId={postId}
          currentWallet={currentWallet}
          repliesByParent={repliesByParent}
        />
      </MemoryRouter>,
    );
    expect(queryByTestId('clubhouse-comment-undelegated-badge')).toBeInTheDocument();
    expect(queryByText(/no longer delegated/i)).toBeInTheDocument();
    // CRITICAL: the comment body MUST still render — flag, NOT hide.
    expect(queryByText('Hello clubhouse.')).toBeInTheDocument();
  });

  it('does NOT render the badge when authorDelegationActive is absent (default = active)', () => {
    const { queryByTestId } = render(
      <MemoryRouter>
        <ClubhouseCommentRow
          comment={makeComment()}
          depth={0}
          drepId={drepId}
          postId={postId}
          currentWallet={currentWallet}
          repliesByParent={repliesByParent}
        />
      </MemoryRouter>,
    );
    expect(queryByTestId('clubhouse-comment-undelegated-badge')).toBeNull();
  });

  it('does NOT render the badge when authorDelegationActive === true (re-activated)', () => {
    // After the sweep finds a re-aligned wallet, the row gets
    // `authorDelegationActive: true` back. The frontend must NOT
    // render the badge in that case.
    const { queryByTestId } = render(
      <MemoryRouter>
        <ClubhouseCommentRow
          comment={makeComment({ authorDelegationActive: true })}
          depth={0}
          drepId={drepId}
          postId={postId}
          currentWallet={currentWallet}
          repliesByParent={repliesByParent}
        />
      </MemoryRouter>,
    );
    expect(queryByTestId('clubhouse-comment-undelegated-badge')).toBeNull();
  });
});

/**
 * Sprint 4 follow-up — clubhouse comment community flagging.
 *
 * Closes the last leg of the Sprint 4 flagging trio (the
 * governance-action comment + clubhouse-post flag affordances already
 * exist). The contract on the FE matches both siblings:
 *
 *   - Flag button visible ONLY when the caller is on-chain-verified
 *     AND NOT the comment author. The backend enforces both gates
 *     independently — this is a usability gate to avoid surfacing a
 *     button that would always 403/400.
 *   - `hidden === true` rows render the moderation banner BEFORE the
 *     body (and the body stays visible — admins decide whether to
 *     reverse the community decision).
 */
describe('ClubhouseCommentRow — Sprint 4 follow-up flag affordance', () => {
  const repliesByParent = new Map<string, ClubhouseComment[]>();
  const currentWallet = 'addr1q9flaggerwallet';
  const drepId = 'drep1ygqgayvx8yzsaj9hprja3l6jy3v4px9z3u8uvecuvm3f92ce7mckx';
  const postId = 'auto-ga#abc123';

  it('renders the flag button when the caller is on-chain-verified and not the author', () => {
    authStubState.onChainRoles = ['drep'];
    try {
      const { queryByTestId } = render(
        <MemoryRouter>
          <ClubhouseCommentRow
            comment={makeComment({
              commentId: 'cmt-target',
              authorWallet: 'addr1q9someoneelse',
            })}
            depth={0}
            drepId={drepId}
            postId={postId}
            currentWallet={currentWallet}
            repliesByParent={repliesByParent}
          />
        </MemoryRouter>,
      );
      expect(queryByTestId('clubhouse-comment-flag-button')).toBeInTheDocument();
    } finally {
      authStubState.onChainRoles = [];
    }
  });

  it('does NOT render the flag button when the caller has no on-chain role', () => {
    authStubState.onChainRoles = [];
    const { queryByTestId } = render(
      <MemoryRouter>
        <ClubhouseCommentRow
          comment={makeComment({
            commentId: 'cmt-target',
            authorWallet: 'addr1q9someoneelse',
          })}
          depth={0}
          drepId={drepId}
          postId={postId}
          currentWallet={currentWallet}
          repliesByParent={repliesByParent}
        />
      </MemoryRouter>,
    );
    expect(queryByTestId('clubhouse-comment-flag-button')).toBeNull();
  });

  it('does NOT render the flag button on the caller\'s own comment (self-flag gate)', () => {
    authStubState.onChainRoles = ['drep'];
    try {
      const { queryByTestId } = render(
        <MemoryRouter>
          <ClubhouseCommentRow
            comment={makeComment({
              commentId: 'cmt-self',
              authorWallet: currentWallet,
            })}
            depth={0}
            drepId={drepId}
            postId={postId}
            currentWallet={currentWallet}
            repliesByParent={repliesByParent}
          />
        </MemoryRouter>,
      );
      expect(queryByTestId('clubhouse-comment-flag-button')).toBeNull();
    } finally {
      authStubState.onChainRoles = [];
    }
  });

  it('renders the hidden-by-community banner for rows the backend marks hidden', () => {
    // `platform_admin`s receive `hidden: true` rows on the wire; the
    // FE renders a moderation banner BEFORE the body and keeps the
    // body visible so the moderator can reverse the decision.
    const { queryByTestId, queryByText } = render(
      <MemoryRouter>
        <ClubhouseCommentRow
          comment={makeComment({
            commentId: 'cmt-hidden',
            authorWallet: 'addr1q9someoneelse',
            hidden: true,
            flagCount: 3,
          })}
          depth={0}
          drepId={drepId}
          postId={postId}
          currentWallet={currentWallet}
          repliesByParent={repliesByParent}
        />
      </MemoryRouter>,
    );
    expect(queryByTestId('clubhouse-comment-hidden-banner')).toBeInTheDocument();
    // Body still rendered — flag, not hide.
    expect(queryByText('Hello clubhouse.')).toBeInTheDocument();
  });

  it('does NOT render the hidden banner on non-hidden rows', () => {
    const { queryByTestId } = render(
      <MemoryRouter>
        <ClubhouseCommentRow
          comment={makeComment({ commentId: 'cmt-visible' })}
          depth={0}
          drepId={drepId}
          postId={postId}
          currentWallet={currentWallet}
          repliesByParent={repliesByParent}
        />
      </MemoryRouter>,
    );
    expect(queryByTestId('clubhouse-comment-hidden-banner')).toBeNull();
  });
});
