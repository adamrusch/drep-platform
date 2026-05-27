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
  // The component only USES this hook to handle submission; the actual
  // mutation surface isn't exercised by depth-rendering tests. Returning
  // a minimal shape keeps the depth checks isolated.
  useCreateClubhouseComment: (): {
    mutateAsync: ReturnType<typeof vi.fn>;
    isPending: boolean;
  } => ({
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
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
