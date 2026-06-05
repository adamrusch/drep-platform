import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { UserRole, SessionType, UserProfile } from '@/types';

/**
 * Plain-data auth store. Computed values (isAuthenticated, isLeadDRep, etc.)
 * are NOT defined as getter properties on the store — Zustand's persist
 * middleware and React's referential-equality selectors don't play well with
 * getters (calling `useStore()` would re-read getters every render and could
 * crash during hydration before `get()` returns a fully-formed state).
 *
 * Use the selector hooks at the bottom of this file (or compute inline from
 * `walletAddress` / `expiresAt` / `roles`) instead.
 */
interface AuthStore {
  walletAddress: string | null;
  /**
   * Name of the CIP-30 connector last used (e.g. "nami", "eternl").
   * We need this to re-enable the wallet later for mutation-nonce signing —
   * the SPA does NOT keep the API instance around (it's per-page) so any
   * subsequent signature requires another `cardano[walletName].enable()`.
   */
  walletName: string | null;
  roles: UserRole[];
  drepId: string | null;
  /**
   * The user's joined committee (lead or member), or null. Mirrors
   * `UserProfile.committeeMembership` and is the source of truth for
   * granting committee-space access to a non-lead MEMBER (who has no
   * `drepId`). Synced from `/auth/me` in `setProfile`.
   */
  committeeMembership: { drepId: string; role: 'lead' | 'member'; committeeName: string } | null;
  sessionType: SessionType | null;
  expiresAt: string | null;
  profile: UserProfile | null;

  setAuth: (params: {
    walletAddress: string;
    walletName?: string;
    roles: UserRole[];
    sessionType: SessionType;
    expiresAt: string;
    drepId?: string;
  }) => void;
  setProfile: (profile: UserProfile) => void;
  clearAuth: () => void;
  refreshExpiry: (expiresAt: string) => void;
}

export const useAuthStore = create<AuthStore>()(
  persist(
    (set) => ({
      walletAddress: null,
      walletName: null,
      roles: [],
      drepId: null,
      committeeMembership: null,
      sessionType: null,
      expiresAt: null,
      profile: null,

      setAuth: ({ walletAddress, walletName, roles, sessionType, expiresAt, drepId }) => {
        set((state) => ({
          walletAddress,
          // Preserve walletName if a fresh setAuth doesn't pass one (e.g. session
          // refresh that doesn't re-prompt the wallet). Otherwise update.
          walletName: walletName ?? state.walletName,
          roles,
          sessionType,
          expiresAt,
          drepId: drepId ?? null,
        }));
      },

      setProfile: (profile: UserProfile) => {
        // `/auth/me` is the source of truth for DRep linkage and roles — it
        // reads the LIVE user row (and on-chain directory), whereas `setAuth`
        // only has the login/verify response (which carries no drepId and
        // whose JWT roles can be stale). Sync those live fields into the
        // top-level store slots that selectors read, otherwise `s.drepId`
        // stays null forever and the DRep dashboard + committee landing treat
        // a real DRep as "not registered". (This sync used to be done by the
        // now-removed useAutoLinkDrep hook.)
        set((state) => ({
          profile,
          drepId: profile.drepId ?? state.drepId ?? null,
          roles: profile.roles ?? state.roles,
          // `committeeMembership` is explicitly authoritative from /auth/me:
          // when the user belongs to no committee the field is null, and we
          // MUST clear any stale value (e.g. after leaving a committee), so
          // this does NOT fall back to the previous value the way drepId does.
          committeeMembership: profile.committeeMembership ?? null,
        }));
      },

      clearAuth: () => {
        set({
          walletAddress: null,
          walletName: null,
          roles: [],
          drepId: null,
          committeeMembership: null,
          sessionType: null,
          expiresAt: null,
          profile: null,
        });
      },

      refreshExpiry: (expiresAt: string) => {
        set({ expiresAt });
      },
    }),
    {
      name: 'drep-auth',
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({
        walletAddress: state.walletAddress,
        walletName: state.walletName,
        roles: state.roles,
        drepId: state.drepId,
        committeeMembership: state.committeeMembership,
        sessionType: state.sessionType,
        expiresAt: state.expiresAt,
      }),
    },
  ),
);

// ---- Selector hooks (computed values) ----

function isSessionLive(walletAddress: string | null, expiresAt: string | null): boolean {
  if (!walletAddress || !expiresAt) return false;
  return new Date(expiresAt).getTime() > Date.now();
}

export function useIsAuthenticated(): boolean {
  return useAuthStore((s) => isSessionLive(s.walletAddress, s.expiresAt));
}

export function useHasRole(role: UserRole): boolean {
  return useAuthStore((s) => s.roles.includes(role));
}

export function useIsLeadDRep(): boolean {
  return useAuthStore((s) => s.roles.includes('lead_drep'));
}

export function useIsCommitteeMember(): boolean {
  return useAuthStore((s) =>
    s.roles.includes('committee_member') ||
    s.roles.includes('lead_drep') ||
    // A member who accepted an invite has live membership but (until their
    // next login) no committee role in the JWT — trust the membership row.
    s.committeeMembership != null,
  );
}

/**
 * The committee the user has joined (lead or member), or null. Source of
 * truth for committee-space access — especially for a non-lead member, who
 * has no `drepId` of their own.
 */
export function useMyCommittee():
  | { drepId: string; role: 'lead' | 'member'; committeeName: string }
  | null {
  return useAuthStore((s) => s.committeeMembership);
}

/**
 * True when the user is an accepted member/lead of the committee identified
 * by `drepId`. Drives per-committee UI gates (cast/resolve panels). The
 * backend independently enforces real membership on every mutation; this is
 * the client-side render gate that no longer depends on a stale JWT role.
 */
export function useIsMemberOfCommittee(drepId: string): boolean {
  return useAuthStore(
    (s) =>
      (s.committeeMembership?.drepId === drepId && drepId.length > 0) ||
      // The lead of THIS committee (their own drepId) always counts.
      (s.drepId === drepId && drepId.length > 0),
  );
}

export function useIsDelegator(): boolean {
  return useAuthStore(
    (s) =>
      s.roles.includes('delegator') ||
      s.roles.includes('trusted_delegator') ||
      s.roles.includes('committee_member') ||
      s.roles.includes('lead_drep'),
  );
}
