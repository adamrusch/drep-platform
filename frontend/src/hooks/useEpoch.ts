import { useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';
import type { EpochInfo } from '@/types';

const QUERY_KEY = ['epoch', 'latest'] as const;

/**
 * Fetches the current Cardano epoch from `/epoch` (which proxies Blockfrost
 * `epochsLatest`). Cached for 60 s — the epoch number itself only mutates
 * once per ~5 days, so longer staleness is fine; we still refresh to keep
 * the countdown reasonably current.
 */
export function useEpoch() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => get<EpochInfo>('/epoch'),
    staleTime: 60_000,
  });
}
