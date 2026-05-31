import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { get, post, put } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { useMutationSign } from '@/hooks/useMutationSign';
import { committeeMessages } from '@/lib/committeeMessages';
import { getStage } from '@/lib/stage';
import type { RationaleView, RationaleDraft } from '@/types/committee';

const enc = encodeURIComponent;
const key = (drepId: string, actionId: string) =>
  ['committee', drepId, 'votes', actionId, 'rationale'] as const;

const base = (drepId: string, actionId: string) =>
  `/committee/${enc(drepId)}/votes/${enc(actionId)}/rationale`;

export function useRationale(drepId: string, actionId: string, enabled = true) {
  return useQuery({
    queryKey: key(drepId, actionId),
    queryFn: () => get<RationaleView>(base(drepId, actionId)),
    enabled: enabled && Boolean(drepId && actionId),
    staleTime: 5_000,
  });
}

function useInvalidateRationale(drepId: string, actionId: string) {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: key(drepId, actionId) });
}

export function useAcquireRationaleLock(drepId: string, actionId: string) {
  const invalidate = useInvalidateRationale(drepId, actionId);
  return useMutation({
    mutationFn: () => post(`${base(drepId, actionId)}/lock`),
    onSuccess: invalidate,
  });
}

export function useHeartbeatRationaleLock(drepId: string, actionId: string) {
  return useMutation({
    mutationFn: () => post<{ expiresAt: number }>(`${base(drepId, actionId)}/lock/heartbeat`),
  });
}

export function useReleaseRationaleLock(drepId: string, actionId: string) {
  const invalidate = useInvalidateRationale(drepId, actionId);
  return useMutation({
    mutationFn: () => post(`${base(drepId, actionId)}/lock/release`),
    onSuccess: invalidate,
  });
}

export function useEditRationale(drepId: string, actionId: string) {
  const invalidate = useInvalidateRationale(drepId, actionId);
  return useMutation({
    mutationFn: (draft: Partial<RationaleDraft> & { rationaleStatement: string; expectedUpdatedAt?: string }) =>
      put<RationaleDraft>(base(drepId, actionId), draft),
    onSuccess: invalidate,
  });
}

export function useFinalizeRationale(drepId: string, actionId: string) {
  const sign = useMutationSign();
  const wallet = useAuthStore((s) => s.walletAddress);
  const invalidate = useInvalidateRationale(drepId, actionId);
  const stage = getStage();
  return useMutation({
    mutationFn: async () => {
      const signed = await sign((nonce) =>
        committeeMessages.rationaleFinalize(stage, drepId, actionId, nonce, wallet ?? ''),
      );
      return post(`${base(drepId, actionId)}/finalize`, signed);
    },
    onSuccess: invalidate,
  });
}

export function usePinRationale(drepId: string, actionId: string) {
  const invalidate = useInvalidateRationale(drepId, actionId);
  return useMutation({
    mutationFn: (vars: { ipfsProjectId?: string } = {}) =>
      post<{ ipfsUri: string; ipfsCid: string }>(`${base(drepId, actionId)}/pin`, vars),
    onSuccess: invalidate,
  });
}
