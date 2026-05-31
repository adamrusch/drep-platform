import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { get, post, put, del } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { useMutationSign } from '@/hooks/useMutationSign';
import { committeeMessages } from '@/lib/committeeMessages';
import { getStage } from '@/lib/stage';
import type { RationaleMode } from '@/types/committee';

const enc = encodeURIComponent;

/** Register a new DRep committee (POST /drep). JWT-auth, no re-sign. Elevates
 *  the caller to lead_drep server-side — the new role surfaces after a wallet
 *  re-login. Returns the created committee (incl. its generated drepId). */
export function useRegisterCommittee() {
  return useMutation({
    mutationFn: (vars: { committeeName: string; description: string }) =>
      post<{ drepId: string; committeeName: string }>('/drep', vars),
  });
}

export function useAddCommitteeMember(drepId: string) {
  const sign = useMutationSign();
  const wallet = useAuthStore((s) => s.walletAddress);
  const qc = useQueryClient();
  const stage = getStage();
  return useMutation({
    mutationFn: async (vars: { walletAddress: string; displayName?: string; role?: 'committee_member' | 'trusted_delegator' }) => {
      const signed = await sign((nonce) =>
        committeeMessages.member(stage, drepId, 'add', vars.walletAddress, nonce, wallet ?? ''),
      );
      return post(`/committee/${enc(drepId)}/members`, { ...vars, ...signed });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['drep', drepId] }),
  });
}

export function useRemoveCommitteeMember(drepId: string) {
  const sign = useMutationSign();
  const wallet = useAuthStore((s) => s.walletAddress);
  const qc = useQueryClient();
  const stage = getStage();
  return useMutation({
    mutationFn: async (vars: { walletAddress: string }) => {
      const signed = await sign((nonce) =>
        committeeMessages.member(stage, drepId, 'remove', vars.walletAddress, nonce, wallet ?? ''),
      );
      return del(`/committee/${enc(drepId)}/members/${enc(vars.walletAddress)}`, signed);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['drep', drepId] }),
  });
}

export function useUpdateVotingConfig(drepId: string) {
  const sign = useMutationSign();
  const wallet = useAuthStore((s) => s.walletAddress);
  const qc = useQueryClient();
  const stage = getStage();
  return useMutation({
    mutationFn: async (vars: { thresholdPct: number; rationaleMode: RationaleMode; assignedEditor?: string }) => {
      const signed = await sign((nonce) =>
        committeeMessages.votingConfig(stage, drepId, vars.thresholdPct, vars.rationaleMode, nonce, wallet ?? ''),
      );
      return put(`/committee/${enc(drepId)}/voting-config`, { ...vars, ...signed });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['drep', drepId] });
      void qc.invalidateQueries({ queryKey: ['committee', drepId] });
    },
  });
}

export function useIpfsKeyStatus(drepId: string) {
  return useQuery({
    queryKey: ['committee', drepId, 'ipfs-key'],
    queryFn: () => get<{ stored: boolean }>(`/committee/${enc(drepId)}/ipfs-key`),
    enabled: Boolean(drepId),
    staleTime: 60_000,
  });
}

export function useStoreIpfsKey(drepId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { ipfsProjectId: string }) => put(`/committee/${enc(drepId)}/ipfs-key`, vars),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['committee', drepId, 'ipfs-key'] }),
  });
}
