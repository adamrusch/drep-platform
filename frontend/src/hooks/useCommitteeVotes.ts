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

/**
 * Open (propose) a committee vote. As of 2026-06 this is a plain
 * JWT-authenticated POST — NO wallet re-signature. Opening a proposal just
 * queues a governance action for the group to review and vote on; the binding
 * actions (cast / close / on-chain submit) still re-sign. The backend gates
 * this on committee membership.
 */
export function useOpenProposal(drepId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { actionId: string; proposedPosition: CommitteePosition }) =>
      post(`/committee/${enc(drepId)}/votes`, vars),
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

export interface SubmitReadiness {
  ready: boolean;
  broadcastAllowed: boolean;
  stage: string;
  rationaleOverridden: boolean;
  payload: {
    drepId: string;
    actionId: string;
    position: CommitteePosition;
    voteKind: number;
    anchorUrl: string | null;
    anchorHash: string | null;
  };
  message: string;
}

export function useSubmitVote(drepId: string, actionId: string) {
  return useMutation({
    mutationFn: (vars: { override?: boolean } = {}) =>
      post<SubmitReadiness>(`/committee/${enc(drepId)}/votes/${enc(actionId)}/submit`, vars),
  });
}

export function useSubmitReceipt(drepId: string, actionId: string) {
  const sign = useMutationSign();
  const wallet = useAuthStore((s) => s.walletAddress);
  const invalidate = useInvalidateVote(drepId, actionId);
  const stage = getStage();
  return useMutation({
    mutationFn: async (vars: {
      txHash: string;
      /** Required on the `test` stage — see backend submitReceipt.ts. The
       *  hook passes through whatever the panel supplies; backend rejects
       *  with 400 when missing/false on test. */
      confirmedRealMainnetVote?: boolean;
    }) => {
      const signed = await sign((nonce) =>
        committeeMessages.submitReceipt(stage, drepId, actionId, vars.txHash, nonce, wallet ?? ''),
      );
      return post(`/committee/${enc(drepId)}/votes/${enc(actionId)}/submit/receipt`, { ...vars, ...signed });
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
