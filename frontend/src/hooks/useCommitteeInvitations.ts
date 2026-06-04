/**
 * Hooks for the committee-invitation surface (Feature 1).
 *
 *   - `usePendingInvitations()` — reads `pendingInvitations` off
 *     `/auth/me`. The bell badge in the topbar and the dashboard
 *     "Invitation(s)" card both consume it. Cheap — `useMe` is already
 *     in the React-Query cache; this is just a projection.
 *
 *   - `useRespondInvitation(drepId)` — invitee accepts or rejects a
 *     pending invitation. Re-signs the response via `useMutationSign`,
 *     binding Committee + Decision into the plaintext so an Accept
 *     signature cannot be replayed as a Reject. Invalidates `/auth/me`
 *     and the affected committee on success.
 *
 *   - `useRevokeInvitation(drepId)` — Chair revokes a pending
 *     invitation for `walletAddress`. Re-signs using the existing
 *     `member` signed-message verb with action='remove' — backend mirrors
 *     `removeMember.ts` on the verify side so the byte-identical message
 *     verifies. Invalidates the committee record.
 *
 *   - `useDeclineAllInvitations()` — JWT-auth only (no re-sign);
 *     mass-rejects every pending invitation for the caller. Distinct
 *     from the `autoDeclineInvites` profile toggle (which only blocks
 *     FUTURE invites).
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { post, del } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { useMe } from '@/hooks/useAuth';
import { useMutationSign } from '@/hooks/useMutationSign';
import { committeeMessages } from '@/lib/committeeMessages';
import { getStage } from '@/lib/stage';
import type { PendingInvitationSummary } from '@/types';

const enc = encodeURIComponent;

/** Read the caller's pending committee invitations off `/auth/me`. Returns
 *  an empty array while `/auth/me` is loading. */
export function usePendingInvitations(): PendingInvitationSummary[] {
  const { data: profile } = useMe();
  return profile?.pendingInvitations ?? [];
}

/** Invitee responds to a single pending invitation. Re-signs an
 *  `invitation-response` message bound to (committee, decision). */
export function useRespondInvitation(drepId: string) {
  const qc = useQueryClient();
  const sign = useMutationSign();
  const wallet = useAuthStore((s) => s.walletAddress);
  const stage = getStage();
  return useMutation({
    mutationFn: async (vars: { decision: 'accept' | 'reject' }) => {
      const signed = await sign((nonce) =>
        committeeMessages.invitationResponse(stage, drepId, vars.decision, nonce, wallet ?? ''),
      );
      return post(`/committee/${enc(drepId)}/invitations/respond`, {
        decision: vars.decision,
        ...signed,
      });
    },
    onSuccess: () => {
      // /auth/me carries `pendingInvitations`; the committee record
      // changes too (members[] grows on accept). Invalidate both so the
      // bell badge, dashboard card, and committee settings all refresh.
      void qc.invalidateQueries({ queryKey: ['auth', 'me'] });
      void qc.invalidateQueries({ queryKey: ['drep', drepId] });
    },
  });
}

/** Chair revokes a pending invitation belonging to `walletAddress`. */
export function useRevokeInvitation(drepId: string) {
  const qc = useQueryClient();
  const sign = useMutationSign();
  const wallet = useAuthStore((s) => s.walletAddress);
  const stage = getStage();
  return useMutation({
    mutationFn: async (vars: { walletAddress: string }) => {
      const signed = await sign((nonce) =>
        // Same signed-message verb as removeMember; the backend's revoke
        // handler verifies against the byte-identical plaintext.
        committeeMessages.member(stage, drepId, 'remove', vars.walletAddress, nonce, wallet ?? ''),
      );
      return del(`/committee/${enc(drepId)}/invitations/${enc(vars.walletAddress)}`, signed);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['drep', drepId] });
    },
  });
}

/** Mass-reject every pending invitation for the caller. JWT-auth only — no
 *  re-sign required (action is purely defensive: it only affects rows the
 *  caller already owns). */
export function useDeclineAllInvitations() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      post<{ rejected: number; skipped: number }>('/me/invitations/decline-all'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['auth', 'me'] });
    },
  });
}
