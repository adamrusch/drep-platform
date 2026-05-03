import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { get, post } from '@/lib/api';
import type {
  GovernanceAction,
  GovernanceActionStatus,
  GovernanceStats,
  PaginatedResponse,
} from '@/types';

const QUERY_KEYS = {
  list: (status: GovernanceActionStatus) => ['governance', 'list', status] as const,
  detail: (actionId: string) => ['governance', 'detail', actionId] as const,
  stats: () => ['governance', 'stats'] as const,
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

/** Aggregated stats across every governance action ever stored. Used by
 *  the history page summary panel and the dashboard "Governance History"
 *  widget. Cached server-side at 60s; we trust that and use a 60s
 *  client-side `staleTime` to match. */
export function useGovernanceStats() {
  return useQuery({
    queryKey: QUERY_KEYS.stats(),
    queryFn: () => get<GovernanceStats>('/governance/stats'),
    staleTime: 60_000,
  });
}

/** Aggregated fetch of every governance action across all four lifecycle
 *  statuses, returned as one flat list sorted by `submittedAt` descending.
 *
 *  The history page wants a single chronological feed; the existing
 *  `/governance` endpoint paginates per-status. Mainnet has ~109 actions
 *  total, so requesting a generous `limit` from each of the 4 statuses
 *  collects the whole set in 4 parallel calls — cheaper and simpler than
 *  a server-side merged endpoint. The tally hook above carries authoritative
 *  counts for the summary panel; this is purely the row stream.
 *
 *  If any status fetch fails, that bucket is silently skipped — better to
 *  show 95 rows than to nuke the page over a transient miss. */
export function useGovernanceHistory() {
  return useQuery({
    queryKey: ['governance', 'history'] as const,
    queryFn: async (): Promise<GovernanceAction[]> => {
      const statuses: GovernanceActionStatus[] = ['active', 'enacted', 'dropped', 'expired'];
      const results = await Promise.allSettled(
        statuses.map((s) =>
          get<PaginatedResponse<GovernanceAction>>('/governance', { status: s, limit: 100 }),
        ),
      );
      const rows: GovernanceAction[] = [];
      for (const r of results) {
        if (r.status === 'fulfilled') rows.push(...r.value.items);
      }
      // De-dup defensively (a row should not appear under more than one
      // status, but if it ever does we keep the first occurrence rather
      // than render duplicate cards).
      const seen = new Set<string>();
      const deduped: GovernanceAction[] = [];
      for (const row of rows) {
        if (seen.has(row.actionId)) continue;
        seen.add(row.actionId);
        deduped.push(row);
      }
      // Newest first — submittedAt is ISO-8601 with Z suffix, so
      // lexicographic > equals chronological >.
      deduped.sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1));
      return deduped;
    },
    staleTime: 60_000,
  });
}
