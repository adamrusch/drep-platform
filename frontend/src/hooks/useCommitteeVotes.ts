import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { get, post, del } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { useMutationSign } from '@/hooks/useMutationSign';
import { committeeMessages } from '@/lib/committeeMessages';
import { getStage } from '@/lib/stage';
import type {
  CommitteePosition,
  CommitteeCastVote,
  CommitteeVoteRoomView,
  CommitteeVoteListView,
} from '@/types/committee';

const KEYS = {
  list: (drepId: string) => ['committee', drepId, 'votes'] as const,
  vote: (drepId: string, actionId: string) => ['committee', drepId, 'votes', actionId] as const,
};

const enc = encodeURIComponent;

export function useCommitteeVoteList(drepId: string) {
  return useQuery({
    queryKey: KEYS.list(drepId),
    queryFn: () => get<CommitteeVoteListView>(`/committee/${enc(drepId)}/votes`),
    enabled: Boolean(drepId),
    staleTime: 30_000,
  });
}

export function useCommitteeVote(drepId: string, actionId: string) {
  return useQuery({
    queryKey: KEYS.vote(drepId, actionId),
    queryFn: () => get<CommitteeVoteRoomView>(`/committee/${enc(drepId)}/votes/${enc(actionId)}`),
    enabled: Boolean(drepId && actionId),
    staleTime: 10_000,
  });
}

/** Shared invalidation after any vote-room mutation. */
function useInvalidateVote(drepId: string, actionId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: KEYS.vote(drepId, actionId) });
    void qc.invalidateQueries({ queryKey: KEYS.list(drepId) });
  };
}

export function useOpenProposal(drepId: string) {
  const sign = useMutationSign();
  const wallet = useAuthStore((s) => s.walletAddress);
  const qc = useQueryClient();
  const stage = getStage();
  return useMutation({
    mutationFn: async (vars: { actionId: string; proposedPosition: CommitteePosition }) => {
      const signed = await sign((nonce) =>
        committeeMessages.proposal(stage, drepId, vars.actionId, vars.proposedPosition, nonce, wallet ?? ''),
      );
      return post(`/committee/${enc(drepId)}/votes`, { ...vars, ...signed });
    },
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: KEYS.list(drepId) });
      void qc.invalidateQueries({ queryKey: KEYS.vote(drepId, vars.actionId) });
    },
  });
}

export function useCastCommitteeVote(drepId: string, actionId: string) {
  const sign = useMutationSign();
  const wallet = useAuthStore((s) => s.walletAddress);
  const invalidate = useInvalidateVote(drepId, actionId);
  const stage = getStage();
  return useMutation({
    mutationFn: async (vars: { vote: CommitteeCastVote }) => {
      const signed = await sign((nonce) =>
        committeeMessages.cast(stage, drepId, actionId, vars.vote, nonce, wallet ?? ''),
      );
      return post(`/committee/${enc(drepId)}/votes/${enc(actionId)}/cast`, { ...vars, ...signed });
    },
    onSuccess: invalidate,
  });
}

export function useCloseCommitteeVote(drepId: string, actionId: string) {
  const sign = useMutationSign();
  const wallet = useAuthStore((s) => s.walletAddress);
  const invalidate = useInvalidateVote(drepId, actionId);
  const stage = getStage();
  return useMutation({
    mutationFn: async () => {
      const signed = await sign((nonce) =>
        committeeMessages.close(stage, drepId, actionId, 'pass', nonce, wallet ?? ''),
      );
      return post(`/committee/${enc(drepId)}/votes/${enc(actionId)}/close`, signed);
    },
    onSuccess: invalidate,
  });
}

export function useFailCommitteeVote(drepId: string, actionId: string) {
  const sign = useMutationSign();
  const wallet = useAuthStore((s) => s.walletAddress);
  const invalidate = useInvalidateVote(drepId, actionId);
  const stage = getStage();
  return useMutation({
    mutationFn: async () => {
      const signed = await sign((nonce) =>
        committeeMessages.close(stage, drepId, actionId, 'fail', nonce, wallet ?? ''),
      );
      return post(`/committee/${enc(drepId)}/votes/${enc(actionId)}/fail`, signed);
    },
    onSuccess: invalidate,
  });
}

export function useWithdrawProposal(drepId: string, actionId: string) {
  const sign = useMutationSign();
  const wallet = useAuthStore((s) => s.walletAddress);
  const invalidate = useInvalidateVote(drepId, actionId);
  const stage = getStage();
  return useMutation({
    mutationFn: async () => {
      const signed = await sign((nonce) =>
        committeeMessages.close(stage, drepId, actionId, 'withdraw', nonce, wallet ?? ''),
      );
      return del(`/committee/${enc(drepId)}/votes/${enc(actionId)}`, signed);
    },
    onSuccess: invalidate,
  });
}
