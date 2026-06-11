import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { get, post, del } from '@/lib/api';
import { useIsAuthenticated } from '@/stores/authStore';
import type { Comment, MyCommentVotes, PaginatedResponse } from '@/types';

const QUERY_KEYS = {
  list: (actionId: string) => ['comments', actionId] as const,
  myVotes: (actionId: string) => ['comments', actionId, 'my-votes'] as const,
};

export function useComments(actionId: string, onlyPublic = false) {
  return useQuery({
    queryKey: [...QUERY_KEYS.list(actionId), { onlyPublic }],
    queryFn: () =>
      get<PaginatedResponse<Comment>>(
        `/comments/${encodeURIComponent(actionId)}`,
        { public: onlyPublic ? 'true' : undefined },
      ),
    enabled: Boolean(actionId),
    staleTime: 30_000,
  });
}

/**
 * Fetch the caller's own vote map for one action's comments. Fires in
 * parallel with `useComments` — separate from the public list so the
 * list response stays cacheable across viewers.
 *
 * Auto-disabled when the user isn't authenticated; the hook returns
 * `{ data: undefined }` and the UI renders neutral up/down state.
 */
export function useMyCommentVotes(actionId: string) {
  const isAuthenticated = useIsAuthenticated();
  return useQuery({
    queryKey: QUERY_KEYS.myVotes(actionId),
    queryFn: () =>
      get<{ votes: MyCommentVotes }>(`/comments/${encodeURIComponent(actionId)}/my-votes`),
    enabled: isAuthenticated && Boolean(actionId),
    staleTime: 30_000,
  });
}

interface CreateCommentParams {
  actionId: string;
  body: string;
  isPublic: boolean;
  mutationNonce: string;
  mutationSignature: string;
  mutationKey: string;
  /** Optional — when present, the new comment is a reply to this
   *  top-level comment. Backend rejects if the named parent is itself
   *  a reply. */
  parentCommentId?: string;
}

export function useCreateComment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ actionId, ...rest }: CreateCommentParams) =>
      post<Comment>(`/comments/${encodeURIComponent(actionId)}`, rest),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.list(variables.actionId) });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.myVotes(variables.actionId) });
    },
  });
}

interface DeleteCommentParams {
  actionId: string;
  commentId: string;
}

export function useDeleteComment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ actionId, commentId }: DeleteCommentParams) =>
      del(`/comments/${encodeURIComponent(actionId)}/${encodeURIComponent(commentId)}`),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.list(variables.actionId) });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.myVotes(variables.actionId) });
    },
  });
}

interface VoteCommentParams {
  actionId: string;
  commentId: string;
  vote: 'up' | 'down' | 'none';
}

/**
 * Cast / change / remove a vote on one comment. Backend snapshots the
 * voter's current stake at vote time and persists it on the vote row —
 * the support level is `sum(±lovelace)` across all votes.
 *
 * On success we invalidate BOTH the public list (so the new
 * `supportLovelace` propagates) and the user's own vote map (so the
 * button highlight matches the new direction).
 */
export function useVoteComment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ actionId, commentId, vote }: VoteCommentParams) =>
      post<Comment>(
        `/comments/${encodeURIComponent(actionId)}/${encodeURIComponent(commentId)}/vote`,
        { vote },
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.list(variables.actionId) });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.myVotes(variables.actionId) });
    },
  });
}

interface FlagCommentParams {
  actionId: string;
  commentId: string;
}

/** Backend response from `POST /comments/{actionId}/{commentId}/flag`.
 *  `outcome === 'already_flagged'` means the same wallet flagged this
 *  comment before; the FE treats both outcomes identically (the affordance
 *  switches to a "Flagged" state on first click; subsequent clicks are
 *  no-ops). */
export interface FlagCommentResponse {
  outcome: 'flagged' | 'already_flagged';
  commentId: string;
  flagCount?: number;
  hidden?: boolean;
}

/**
 * Sprint 4 — community flag a comment.
 *
 * Requires the caller to be authenticated AND to hold at least one
 * on-chain role (`drep` / `spo` / `cc` / `proposer`). The FE renders
 * the affordance only for callers with `onChainRoles.length > 0`; this
 * hook does not enforce that gate itself (the backend rejects with 403
 * for callers without an on-chain role). On success we invalidate the
 * comment list so the per-row `flagCount` / `hidden` propagate.
 */
export function useFlagComment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ actionId, commentId }: FlagCommentParams) =>
      post<FlagCommentResponse>(
        `/comments/${encodeURIComponent(actionId)}/${encodeURIComponent(commentId)}/flag`,
        {},
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: QUERY_KEYS.list(variables.actionId),
      });
    },
  });
}
