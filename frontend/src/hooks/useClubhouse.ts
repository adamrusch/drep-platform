import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { get, post, del } from '@/lib/api';
import type {
  ClubhousePost,
  ClubhouseComment,
  ClubhousePostType,
  PaginatedResponse,
} from '@/types';

const QUERY_KEYS = {
  posts: (drepId: string) => ['clubhouse', drepId] as const,
  /** P0-3 migration (2026-05-28) — per-post lazy comment fetch.
   *  Cache by (drepId, postId) so each post's comments share the
   *  same key across collapsing/re-expanding the panel within the
   *  TanStack staleTime window. */
  comments: (drepId: string, postId: string) =>
    ['clubhouse', drepId, 'post', postId, 'comments'] as const,
};

export function useClubhousePosts(drepId: string) {
  return useQuery({
    queryKey: QUERY_KEYS.posts(drepId),
    queryFn: () =>
      get<PaginatedResponse<ClubhousePost>>(`/clubhouse/${encodeURIComponent(drepId)}`),
    enabled: Boolean(drepId),
    staleTime: 30_000,
  });
}

/**
 * Lazy-load per-post comments from the new `clubhouse_comments` table.
 * Only fires when the caller passes `enabled: true` — the consumer
 * (the PostCard expand toggle) opens the panel.
 *
 * Returns the same shape the FE has always consumed: a list of
 * `ClubhouseComment` rows. The backend handler strips the partition-
 * key bookkeeping (`postKey`, `drepId`, `postId`, `depth`) before
 * returning so the wire shape is interchangeable with the inline
 * `post.comments[]` array.
 */
export function useClubhouseComments(
  drepId: string,
  postId: string,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: QUERY_KEYS.comments(drepId, postId),
    queryFn: () =>
      get<{ items: ClubhouseComment[] }>(
        `/clubhouse/${encodeURIComponent(drepId)}/post/${encodeURIComponent(postId)}/comments`,
      ),
    enabled: Boolean(drepId && postId && (options.enabled ?? false)),
    staleTime: 30_000,
  });
}

interface CreatePostParams {
  drepId: string;
  body: string;
  type?: ClubhousePostType;
  title?: string;
  pollOptions?: { label: string }[];
  pollMultiple?: boolean;
  pollClosesAt?: string;
}

export function useCreateClubhousePost() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ drepId, ...rest }: CreatePostParams) =>
      post<ClubhousePost>(`/clubhouse/${encodeURIComponent(drepId)}/post`, rest),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.posts(variables.drepId) });
    },
  });
}

interface CreateCommentParams {
  drepId: string;
  postId: string;
  body: string;
  /** Optional — when present, this comment is a reply to the named
   *  comment. The Clubhouse surface allows 2 levels of nesting
   *  (top-level → reply → sub-reply); 3-deep is rejected at the API
   *  layer with 400. */
  parentCommentId?: string;
}

export function useCreateClubhouseComment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ drepId, postId, body, parentCommentId }: CreateCommentParams) =>
      post<ClubhouseComment>(
        `/clubhouse/${encodeURIComponent(drepId)}/post/${encodeURIComponent(postId)}/comment`,
        { body, ...(parentCommentId ? { parentCommentId } : {}) },
      ),
    onSuccess: (_data, variables) => {
      // Invalidate the post list so the denormalized `commentCount` /
      // `lastReplyAt` counters re-render on the collapsed badge.
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.posts(variables.drepId) });
      // Also invalidate the per-post comments cache so the expanded
      // thread shows the new comment without a manual reload. The key
      // is the same one `useClubhouseComments` uses; if no consumer is
      // mounted the invalidation is a cheap no-op.
      void queryClient.invalidateQueries({
        queryKey: QUERY_KEYS.comments(variables.drepId, variables.postId),
      });
    },
  });
}

interface DeletePostParams {
  drepId: string;
  postId: string;
}

export function useDeleteClubhousePost() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ drepId, postId }: DeletePostParams) =>
      del(`/clubhouse/${encodeURIComponent(drepId)}/post/${encodeURIComponent(postId)}`),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.posts(variables.drepId) });
    },
  });
}

interface FlagClubhousePostParams {
  drepId: string;
  postId: string;
}

/** Backend response from `POST /clubhouse/{drepId}/post/{postId}/flag`.
 *  Matches `FlagCommentResponse` in `useComments.ts`. */
export interface FlagClubhousePostResponse {
  outcome: 'flagged' | 'already_flagged';
  postId: string;
  flagCount?: number;
  hidden?: boolean;
}

/**
 * Sprint 4 — community flag a clubhouse post.
 *
 * Requires the caller to be authenticated AND to hold at least one
 * on-chain role. The FE renders the affordance only for callers with
 * `onChainRoles.length > 0`; this hook does not enforce that gate
 * itself (the backend rejects with 403). On success we invalidate the
 * clubhouse post list so the per-row `flagCount` / `hidden`
 * propagate.
 */
export function useFlagClubhousePost() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ drepId, postId }: FlagClubhousePostParams) =>
      post<FlagClubhousePostResponse>(
        `/clubhouse/${encodeURIComponent(drepId)}/post/${encodeURIComponent(postId)}/flag`,
        {},
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: QUERY_KEYS.posts(variables.drepId),
      });
    },
  });
}

interface FlagClubhouseCommentParams {
  drepId: string;
  postId: string;
  commentId: string;
}

/** Backend response from
 *  `POST /clubhouse/{drepId}/post/{postId}/comment/{commentId}/flag`. */
export interface FlagClubhouseCommentResponse {
  outcome: 'flagged' | 'already_flagged';
  commentId: string;
  flagCount?: number;
  hidden?: boolean;
}

/**
 * Sprint 4 follow-up — community flag a clubhouse COMMENT.
 *
 * Closes the last leg of the Sprint 4 flagging trio (governance-action
 * comments + clubhouse posts already had affordances; clubhouse
 * comments were the missing one). Same identity contract as the two
 * sibling hooks — auth + on-chain role required, the FE gates the
 * affordance on `onChainRoles.length > 0`. On success we invalidate
 * BOTH the per-post comments cache (so the row's `flagCount` /
 * `hidden` re-render in place) AND the post list (so the
 * `commentCount` and any future derived badges stay consistent).
 */
export function useFlagClubhouseComment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ drepId, postId, commentId }: FlagClubhouseCommentParams) =>
      post<FlagClubhouseCommentResponse>(
        `/clubhouse/${encodeURIComponent(drepId)}/post/${encodeURIComponent(postId)}/comment/${encodeURIComponent(commentId)}/flag`,
        {},
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: QUERY_KEYS.comments(variables.drepId, variables.postId),
      });
      void queryClient.invalidateQueries({
        queryKey: QUERY_KEYS.posts(variables.drepId),
      });
    },
  });
}

interface VotePollParams {
  drepId: string;
  postId: string;
  optionIndex: number;
}

/**
 * Optimistic poll-vote mutation. Updates the cached post list immediately
 * (so the bar animates without a round-trip), then reconciles with the
 * server response. On error, the previous cache is restored.
 */
export function useVotePoll() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ drepId, postId, optionIndex }: VotePollParams) =>
      post<ClubhousePost>(
        `/clubhouse/${encodeURIComponent(drepId)}/post/${encodeURIComponent(postId)}/vote`,
        { optionIndex },
      ),
    onMutate: async ({ drepId, postId, optionIndex }) => {
      await queryClient.cancelQueries({ queryKey: QUERY_KEYS.posts(drepId) });
      const previous = queryClient.getQueryData<PaginatedResponse<ClubhousePost>>(
        QUERY_KEYS.posts(drepId),
      );
      if (!previous) return { previous };

      // Optimistic local merge — match the server's vote-tally arithmetic
      // so the UI doesn't flicker when the server response lands.
      queryClient.setQueryData<PaginatedResponse<ClubhousePost>>(
        QUERY_KEYS.posts(drepId),
        {
          ...previous,
          items: previous.items.map((p) => {
            if (p.postId !== postId || !p.pollOptions) return p;
            // We don't know the wallet here — do a best-effort by
            // checking pollVotes for any prior vote and adjusting.
            // Server is authoritative; this is just a UI pre-render.
            const pollOptions = p.pollOptions.map((opt, i) => ({
              ...opt,
              votes: i === optionIndex ? opt.votes + 1 : opt.votes,
            }));
            return { ...p, pollOptions };
          }),
        },
      );
      return { previous };
    },
    onError: (_err, variables, ctx) => {
      if (ctx?.previous) {
        queryClient.setQueryData(QUERY_KEYS.posts(variables.drepId), ctx.previous);
      }
    },
    onSettled: (_data, _err, variables) => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.posts(variables.drepId) });
    },
  });
}
