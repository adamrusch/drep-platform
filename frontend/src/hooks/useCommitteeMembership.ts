import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { get, post, put, del } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { useMutationSign } from '@/hooks/useMutationSign';
import { committeeMessages } from '@/lib/committeeMessages';
import { getStage } from '@/lib/stage';
import type {
  RationaleMode,
  CheckMembersResponse,
} from '@/types/committee';
import type { DRepCommittee } from '@/types';

const enc = encodeURIComponent;

/**
 * Register a new DRep committee (POST /drep). JWT-auth, no re-sign. The caller
 * must already be a registered DRep server-side (gated in
 * backend/src/handlers/drep/register.ts) — the committee binds to *their* DRep,
 * so there's no drep id in the body. Elevates the caller to lead_drep
 * server-side; the new role surfaces after a wallet re-login.
 *
 * `members` are the OTHER members' addresses (payment OR stake form, ≥2 of
 * them — the Chair is auto-added as member #1 by the handler). `approvalThreshold`
 * is X in "X of N", where N = `members.length + 1` (the Chair).
 */
export function useRegisterCommittee() {
  return useMutation({
    mutationFn: (vars: {
      committeeName: string;
      description: string;
      members: string[];
      approvalThreshold: number;
    }) => post<DRepCommittee>('/drep', vars),
  });
}

/** Link the connected wallet to its on-chain DRep (no committee required) so the
 *  user is recognized as a DRep across the platform. CIP-95 key (proves control)
 *  or pasted drep id (verified registered). */
export function useLinkDrep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { drepKey?: string; drepId?: string }) =>
      post<{ drepId: string; drepName?: string }>('/drep/link', vars),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['auth', 'me'] });
      void qc.invalidateQueries({ queryKey: ['profile'] });
    },
  });
}

/**
 * Check, for a list of Cardano addresses, whether each one parses and whether
 * its canonical stake identity has ever signed in to the platform. Powers the
 * live "Active / Not active" badge in the formation wizard and the add-member
 * row. Inactive addresses are still addable — they just need to be invited to
 * sign in. (POST /committee/check-members; JWT-auth.)
 */
export function useCheckMembers() {
  return useMutation({
    mutationFn: (vars: { addresses: string[] }) =>
      post<CheckMembersResponse>('/committee/check-members', vars),
  });
}

/**
 * Add a member to an existing committee. The signed message binds the RAW
 * address the Chair typed (the backend re-derives the stake identity from
 * the same string), so we pass the raw input verbatim into the message and
 * the body. `approvalThreshold` (X) is restated for the NEW committee size
 * (N = current + 1) — every membership change must rebind the X-of-N rule.
 */
export function useAddCommitteeMember(drepId: string) {
  const sign = useMutationSign();
  const wallet = useAuthStore((s) => s.walletAddress);
  const qc = useQueryClient();
  const stage = getStage();
  return useMutation({
    mutationFn: async (vars: {
      walletAddress: string;
      displayName?: string;
      role?: 'committee_member' | 'trusted_delegator';
      approvalThreshold: number;
    }) => {
      const signed = await sign((nonce) =>
        committeeMessages.member(stage, drepId, 'add', vars.walletAddress, nonce, wallet ?? ''),
      );
      return post(`/committee/${enc(drepId)}/members`, { ...vars, ...signed });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['drep', drepId] }),
  });
}

/**
 * Remove a member. `walletAddress` is the member's stored STAKE address (path
 * param). `approvalThreshold` (X) is restated for the NEW committee size
 * (N = current - 1) — the backend rejects removals that would drop below the
 * minimum, and demands the rule be restated in the same body.
 */
export function useRemoveCommitteeMember(drepId: string) {
  const sign = useMutationSign();
  const wallet = useAuthStore((s) => s.walletAddress);
  const qc = useQueryClient();
  const stage = getStage();
  return useMutation({
    mutationFn: async (vars: { walletAddress: string; approvalThreshold: number }) => {
      const signed = await sign((nonce) =>
        committeeMessages.member(stage, drepId, 'remove', vars.walletAddress, nonce, wallet ?? ''),
      );
      return del(`/committee/${enc(drepId)}/members/${enc(vars.walletAddress)}`, {
        approvalThreshold: vars.approvalThreshold,
        ...signed,
      });
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
  const sign = useMutationSign();
  const wallet = useAuthStore((s) => s.walletAddress);
  const stage = getStage();
  return useMutation({
    mutationFn: async (vars: { ipfsProjectId: string }) => {
      const signed = await sign((nonce) =>
        committeeMessages.ipfsKey(stage, drepId, nonce, wallet ?? ''),
      );
      return put(`/committee/${enc(drepId)}/ipfs-key`, { ...vars, ...signed });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['committee', drepId, 'ipfs-key'] }),
  });
}

/** Read the committee record (name, description, members, …) so the lead can
 *  pre-fill the "Edit committee details" form. Disabled until drepId is set. */
export function useCommitteeDetails(drepId: string) {
  return useQuery({
    queryKey: ['drep', drepId],
    queryFn: () => get<DRepCommittee>(`/drep/${enc(drepId)}`),
    enabled: Boolean(drepId),
    staleTime: 30_000,
  });
}

/** Edit committee name / description (PUT /drep/{drepId}). JWT-auth, lead-only
 *  server-side — no signature required. Invalidates the same keys the rest of
 *  the file invalidates after a committee mutation so the new name shows up
 *  everywhere the committee is read. */
export function useUpdateCommittee(drepId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { committeeName?: string; description?: string }) =>
      put<DRepCommittee>(`/drep/${enc(drepId)}`, vars),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['drep', drepId] });
      void qc.invalidateQueries({ queryKey: ['committee', drepId] });
    },
  });
}
