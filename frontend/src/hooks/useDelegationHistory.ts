import { useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';
import type { DelegationRecord } from '@/types';

/**
 * Response of `GET /profile/{walletAddress}/delegation-history`.
 *
 * `currentDrepId` is the LIVE on-chain delegation (Koios primary, Blockfrost
 * fallback) — distinct from the stored `delegationHistory` rows. The backend
 * caches it per stake address for 60s. `undefined` when both upstreams fail
 * or the wallet is not a stake address.
 */
export interface DelegationHistoryResponse {
  walletAddress: string;
  delegationHistory: DelegationRecord[];
  currentDrepId?: string;
}

/**
 * Lazy-loaded fetch of a wallet's delegation history + live current DRep.
 * Pass `enabled=false` to defer the request until the consumer opts in
 * (e.g. a disclosure expands) — default behavior fires as soon as a
 * `walletAddress` is provided.
 */
export function useDelegationHistory(
  walletAddress: string | undefined,
  options: { enabled?: boolean } = {},
) {
  const { enabled = true } = options;
  return useQuery({
    queryKey: ['profile', walletAddress, 'delegation-history'],
    queryFn: () =>
      get<DelegationHistoryResponse>(
        `/profile/${encodeURIComponent(walletAddress ?? '')}/delegation-history`,
      ),
    enabled: enabled && Boolean(walletAddress),
    staleTime: 60_000,
  });
}
