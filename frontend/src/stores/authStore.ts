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
  roles: UserRole[];
  drepId: string | null;
  sessionType: SessionType | null;
  expiresAt: string | null;
  profile: UserProfile | null;

  setAuth: (params: {
    walletAddress: string;
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
      roles: [],
      drepId: null,
      sessionType: null,
      expiresAt: null,
      profile: null,

      setAuth: ({ walletAddress, roles, sessionType, expiresAt, drepId }) => {
        set({
          walletAddress,
          roles,
          sessionType,
          expiresAt,
          drepId: drepId ?? null,
        });
      },

      setProfile: (profile: UserProfile) => {
        set({ profile });
      },

      clearAuth: () => {
        set({
          walletAddress: null,
          roles: [],
          drepId: null,
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
        roles: state.roles,
        drepId: state.drepId,
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
    s.roles.includes('committee_member') || s.roles.includes('lead_drep'),
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
