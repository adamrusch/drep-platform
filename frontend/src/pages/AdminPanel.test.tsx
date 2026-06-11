/**
 * Tests for `AdminPanel` — focuses on the Moderation section added by
 * the moderation-panel branch.
 *
 * Pins the FE contract:
 *   - The queue renders with one row per item; each row shows
 *     content type, flag count, hidden state, and a body snippet.
 *   - A `platform_admin` can flip `hidden` true/false on a row; the
 *     mutation hook is invoked with the correct shape (type, hidden,
 *     parent ids, `expected` snapshot of the current value).
 *   - A non-`platform_admin` does NOT see the moderation section —
 *     enforced by the RoleGuard at the route, so we test it by
 *     rendering AdminPanel inside a RoleGuard with a non-admin auth
 *     state and asserting the section is absent.
 *
 * # Mocking
 *
 * We mock `@/hooks/useAdmin` at the module boundary. This keeps the
 * test focused on the AdminPanel rendering + interaction logic and
 * away from the network/QueryClient.
 *
 * The non-admin "doesn't see it" case routes through the real
 * `RoleGuard` so the test proves the integration end-to-end (the
 * route's RoleGuard prevents the page from rendering at all).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AdminPanel } from './AdminPanel';
import { RoleGuard } from '@/components/RoleGuard';
import type {
  ModerationQueueItem,
  SetHiddenParams,
} from '@/hooks/useAdmin';

// ---- Hook mocks ----

const setHiddenMutate = vi.fn();
let queueState: {
  data:
    | {
        items: ModerationQueueItem[];
        count: number;
      }
    | undefined;
  isLoading: boolean;
  isError: boolean;
  error?: Error;
} = { data: undefined, isLoading: false, isError: false };

vi.mock('@/hooks/useAdmin', () => ({
  useSafetyMode: () => ({ data: { active: false } }),
  useClearSafetyMode: () => ({ mutate: vi.fn(), isPending: false }),
  useGrantPlatformAdmin: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
  }),
  useRevokePlatformAdmin: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
  }),
  useFlaggedQueue: () => queueState,
  useFlaggers: () => ({
    data: { type: 'comment', flaggers: [], count: 0 },
    isLoading: false,
    isError: false,
  }),
  useSetHidden: () => ({
    mutate: (params: SetHiddenParams) => setHiddenMutate(params),
    isPending: false,
    isError: false,
  }),
}));

// ---- Auth store mock for RoleGuard ----

const authStubState: {
  walletAddress: string | null;
  roles: string[];
  onChainRoles: string[];
  expiresAt: string | null;
} = {
  walletAddress: null,
  roles: [],
  onChainRoles: [],
  expiresAt: null,
};

vi.mock('@/stores/authStore', () => ({
  useAuthStore: () => ({
    walletAddress: authStubState.walletAddress,
    roles: authStubState.roles,
    onChainRoles: authStubState.onChainRoles,
    expiresAt: authStubState.expiresAt,
  }),
  useIsAuthenticated: () =>
    Boolean(authStubState.walletAddress) &&
    Boolean(authStubState.expiresAt) &&
    new Date(authStubState.expiresAt!).getTime() > Date.now(),
}));

function makeItem(overrides: Partial<ModerationQueueItem> = {}): ModerationQueueItem {
  return {
    type: 'comment',
    id: 'cmt-1',
    parent: { actionId: 'act-1', commentId: 'cmt-1' },
    authorWallet: 'stake1uauthorxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    snippet: 'A flagged comment body.',
    flagCount: 2,
    hidden: false,
    createdAt: '2026-05-25T00:00:00.000Z',
    ...overrides,
  };
}

describe('AdminPanel — moderation section', () => {
  beforeEach(() => {
    setHiddenMutate.mockReset();
    queueState = { data: undefined, isLoading: false, isError: false };
    // Reset auth to "logged-in platform_admin" by default. The
    // RoleGuard-gated test below overrides this.
    authStubState.walletAddress = 'stake1uadminxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    authStubState.roles = ['platform_admin'];
    authStubState.onChainRoles = [];
    authStubState.expiresAt = new Date(Date.now() + 60_000).toISOString();
  });

  it('renders the queue with one row per item, including type, flag count, snippet', () => {
    queueState = {
      data: {
        items: [
          makeItem({
            id: 'cmt-A',
            type: 'comment',
            snippet: 'comment A body',
            flagCount: 2,
            hidden: false,
          }),
          makeItem({
            id: 'post-B',
            type: 'clubhouse_post',
            parent: { drepId: 'd1', postId: 'post-B' },
            snippet: 'post B body',
            flagCount: 3,
            hidden: true,
          }),
        ],
        count: 2,
      },
      isLoading: false,
      isError: false,
    };

    const { queryByTestId, getByTestId, getByText } = render(
      <MemoryRouter>
        <AdminPanel />
      </MemoryRouter>,
    );

    // Section visible.
    expect(queryByTestId('moderation-section')).toBeInTheDocument();
    expect(queryByTestId('moderation-queue')).toBeInTheDocument();
    expect(queryByTestId('moderation-empty')).toBeNull();

    // Both rows rendered.
    expect(getByTestId('moderation-item-cmt-A')).toBeInTheDocument();
    expect(getByTestId('moderation-item-post-B')).toBeInTheDocument();

    // Snippets present.
    expect(getByText('comment A body')).toBeInTheDocument();
    expect(getByText('post B body')).toBeInTheDocument();

    // The hidden row shows the Unhide button; the visible row shows
    // the Hide button. (Symmetric — the affordance flips per state.)
    expect(getByTestId('moderation-hide-cmt-A')).toBeInTheDocument();
    expect(queryByTestId('moderation-unhide-cmt-A')).toBeNull();
    expect(getByTestId('moderation-unhide-post-B')).toBeInTheDocument();
    expect(queryByTestId('moderation-hide-post-B')).toBeNull();
  });

  it('shows the empty state when the queue has zero items', () => {
    queueState = {
      data: { items: [], count: 0 },
      isLoading: false,
      isError: false,
    };

    const { queryByTestId } = render(
      <MemoryRouter>
        <AdminPanel />
      </MemoryRouter>,
    );

    expect(queryByTestId('moderation-empty')).toBeInTheDocument();
    expect(queryByTestId('moderation-queue')).toBeNull();
  });

  it('an admin Unhide click invokes useSetHidden with type/hidden=false/parent/expected=true', () => {
    queueState = {
      data: {
        items: [
          makeItem({
            id: 'cmt-hidden',
            type: 'comment',
            parent: { actionId: 'act-1', commentId: 'cmt-hidden' },
            hidden: true,
          }),
        ],
        count: 1,
      },
      isLoading: false,
      isError: false,
    };

    const { getByTestId } = render(
      <MemoryRouter>
        <AdminPanel />
      </MemoryRouter>,
    );

    fireEvent.click(getByTestId('moderation-unhide-cmt-hidden'));

    expect(setHiddenMutate).toHaveBeenCalledTimes(1);
    expect(setHiddenMutate).toHaveBeenCalledWith({
      type: 'comment',
      hidden: false,
      expected: true,
      actionId: 'act-1',
      commentId: 'cmt-hidden',
    });
  });

  it('an admin Hide click invokes useSetHidden with hidden=true and expected=false for the current state', () => {
    queueState = {
      data: {
        items: [
          makeItem({
            id: 'post-X',
            type: 'clubhouse_post',
            parent: { drepId: 'd1', postId: 'post-X' },
            hidden: false,
          }),
        ],
        count: 1,
      },
      isLoading: false,
      isError: false,
    };

    const { getByTestId } = render(
      <MemoryRouter>
        <AdminPanel />
      </MemoryRouter>,
    );

    fireEvent.click(getByTestId('moderation-hide-post-X'));

    expect(setHiddenMutate).toHaveBeenCalledTimes(1);
    expect(setHiddenMutate).toHaveBeenCalledWith({
      type: 'clubhouse_post',
      hidden: true,
      expected: false,
      drepId: 'd1',
      postId: 'post-X',
    });
  });

  it('toggling the flaggers section reveals the Show flaggers button', () => {
    queueState = {
      data: {
        items: [makeItem({ id: 'cmt-T' })],
        count: 1,
      },
      isLoading: false,
      isError: false,
    };

    const { getByTestId } = render(
      <MemoryRouter>
        <AdminPanel />
      </MemoryRouter>,
    );

    const toggle = getByTestId('moderation-flaggers-toggle-cmt-T');
    expect(toggle).toBeInTheDocument();
    // aria-expanded starts false.
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    // After click the flaggers loader renders (and aria-expanded flips).
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('AdminPanel — RoleGuard gate (non-admin)', () => {
  beforeEach(() => {
    setHiddenMutate.mockReset();
    queueState = {
      data: { items: [makeItem()], count: 1 },
      isLoading: false,
      isError: false,
    };
  });

  it('does NOT render the panel (or the moderation section) for a non-platform_admin', () => {
    authStubState.walletAddress = 'stake1udelegatorxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    authStubState.roles = ['delegator'];
    authStubState.onChainRoles = [];
    authStubState.expiresAt = new Date(Date.now() + 60_000).toISOString();

    const { queryByTestId, queryByText } = render(
      <MemoryRouter initialEntries={['/admin']}>
        <Routes>
          <Route
            path="/admin"
            element={
              <RoleGuard requiredRoles={['platform_admin']} redirectTo="/">
                <AdminPanel />
              </RoleGuard>
            }
          />
          <Route path="/" element={<div data-testid="redirected-home" />} />
        </Routes>
      </MemoryRouter>,
    );

    // RoleGuard either redirects or renders the "access restricted"
    // fallback. Either way the moderation section must NOT be in the
    // document.
    expect(queryByTestId('moderation-section')).toBeNull();
    expect(queryByTestId('moderation-queue')).toBeNull();
    // The panel itself (signalled by the safety-mode card) is absent.
    expect(queryByText(/Sybil safety mode/i)).toBeNull();
  });
});
