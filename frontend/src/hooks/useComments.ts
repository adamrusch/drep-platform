import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { get, post, del } from '@/lib/api';
import type { Comment, PaginatedResponse } from '@/types';

const QUERY_KEYS = {
  list: (actionId: string) => ['comments', actionId] as const,
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

interface CreateCommentParams {
  actionId: string;
  body: string;
  isPublic: boolean;
  mutationNonce: string;
  mutationSignature: string;
  mutationKey: string;
}

export function useCreateComment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ actionId, ...rest }: CreateCommentParams) =>
      post<Comment>(`/comments/${encodeURIComponent(actionId)}`, rest),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.list(variables.actionId) });
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
    },
  });
}
