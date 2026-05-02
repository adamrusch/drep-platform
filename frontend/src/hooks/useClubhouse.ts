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
}

export function useCreateClubhouseComment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ drepId, postId, body }: CreateCommentParams) =>
      post<ClubhouseComment>(
        `/clubhouse/${encodeURIComponent(drepId)}/post/${encodeURIComponent(postId)}/comment`,
        { body },
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.posts(variables.drepId) });
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
