import { useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';
import type { ClubhouseActiveThread, ClubhouseTopContributor } from '@/types';

/**
 * TanStack Query hooks for the Clubhouse right-rail cards.
 *
 * Two GET endpoints with matching shapes:
 *   - `GET /clubhouse/{drepId}/rail/active-threads?limit=5`
 *   - `GET /clubhouse/{drepId}/rail/top-contributors?limit=5`
 *
 * Both are cached on the server for 60s. The frontend keeps a 30s
 * staleTime — page loads share the server cache, refresh-on-mount
 * picks up new data within ~30s of the user returning. Both queries
 * are `enabled: Boolean(drepId)` so they short-circuit when the URL
 * param hasn't resolved yet.
 *
 * Failure UX: TanStack's `error` is surfaced as `undefined` data plus
 * `isError === true`. The rail component below treats both "loading"
 * and "errored" as "nothing to show" — the cards render their empty-
 * state copy in either case. The handlers return 500 only when DDB
 * itself errors, which is extremely rare and not worth a separate
 * "couldn't load" pill.
 */

const QUERY_KEYS = {
  activeThreads: (drepId: string, limit: number) =>
    ['clubhouse', 'rail', 'active-threads', drepId, limit] as const,
  topContributors: (drepId: string, limit: number) =>
    ['clubhouse', 'rail', 'top-contributors', drepId, limit] as const,
};

interface RailResponse<T> {
  items: T[];
}

export function useActiveThreads(drepId: string, limit = 5) {
  return useQuery({
    queryKey: QUERY_KEYS.activeThreads(drepId, limit),
    queryFn: () =>
      get<RailResponse<ClubhouseActiveThread>>(
        `/clubhouse/${encodeURIComponent(drepId)}/rail/active-threads`,
        { limit },
      ),
    enabled: Boolean(drepId),
    staleTime: 30_000,
  });
}

export function useTopContributors(drepId: string, limit = 5) {
  return useQuery({
    queryKey: QUERY_KEYS.topContributors(drepId, limit),
    queryFn: () =>
      get<RailResponse<ClubhouseTopContributor>>(
        `/clubhouse/${encodeURIComponent(drepId)}/rail/top-contributors`,
        { limit },
      ),
    enabled: Boolean(drepId),
    staleTime: 30_000,
  });
}
