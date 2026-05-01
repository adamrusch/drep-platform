import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { get, post, del } from '@/lib/api';
import type { ClubhousePost, ClubhouseComment, PaginatedResponse } from '@/types';

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
}

export function useCreateClubhousePost() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ drepId, body }: CreatePostParams) =>
      post<ClubhousePost>(`/clubhouse/${encodeURIComponent(drepId)}/post`, { body }),
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
