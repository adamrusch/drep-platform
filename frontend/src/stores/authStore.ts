import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { UserRole, SessionType, UserProfile } from '@/types';

interface AuthStore {
  walletAddress: string | null;
  roles: UserRole[];
  drepId: string | null;
  sessionType: SessionType | null;
  expiresAt: string | null;
  profile: UserProfile | null;

  // Computed
  isAuthenticated: boolean;
  hasRole: (role: UserRole) => boolean;
  isLeadDRep: boolean;
  isCommitteeMember: boolean;
  isDelegator: boolean;

  // Actions
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
    (set, get) => ({
      walletAddress: null,
      roles: [],
      drepId: null,
      sessionType: null,
      expiresAt: null,
      profile: null,

      get isAuthenticated() {
        const { walletAddress, expiresAt } = get();
        if (!walletAddress || !expiresAt) return false;
        return new Date(expiresAt).getTime() > Date.now();
      },

      hasRole: (role: UserRole) => get().roles.includes(role),

      get isLeadDRep() {
        return get().roles.includes('lead_drep');
      },

      get isCommitteeMember() {
        return get().roles.includes('committee_member') || get().roles.includes('lead_drep');
      },

      get isDelegator() {
        return (
          get().roles.includes('delegator') ||
          get().roles.includes('trusted_delegator') ||
          get().roles.includes('committee_member') ||
          get().roles.includes('lead_drep')
        );
      },

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
