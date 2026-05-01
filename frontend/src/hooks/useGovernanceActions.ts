import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { get, post } from '@/lib/api';
import type { GovernanceAction, GovernanceActionStatus, PaginatedResponse } from '@/types';

const QUERY_KEYS = {
  list: (status: GovernanceActionStatus) => ['governance', 'list', status] as const,
  detail: (actionId: string) => ['governance', 'detail', actionId] as const,
};

export function useGovernanceActions(status: GovernanceActionStatus = 'active') {
  return useInfiniteQuery({
    queryKey: QUERY_KEYS.list(status),
    queryFn: async ({ pageParam }) => {
      const params: Record<string, unknown> = { status, limit: 20 };
      if (pageParam) params['lastKey'] = pageParam;
      return get<PaginatedResponse<GovernanceAction>>('/governance', params);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.lastEvaluatedKey,
    staleTime: 60_000,
  });
}

export function useGovernanceAction(actionId: string) {
  return useQuery({
    queryKey: QUERY_KEYS.detail(actionId),
    queryFn: () => get<GovernanceAction>(`/governance/${encodeURIComponent(actionId)}`),
    enabled: Boolean(actionId),
  });
}

export function useGovernanceSync() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => post<{ synced: number; skipped: number; errors: number; syncedAt: string }>('/governance/sync'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['governance'] });
    },
  });
}
