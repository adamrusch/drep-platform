import React, { createContext, useContext, useEffect, type ReactNode } from 'react';
import { MeshProvider } from '@meshsdk/react';
import { useAuthStore } from '@/stores/authStore';
import { get as apiGet } from '@/lib/api';
import type { UserProfile } from '@/types';

interface WalletAuthContextValue {
  isAuthenticated: boolean;
  walletAddress: string | null;
}

const WalletAuthContext = createContext<WalletAuthContextValue>({
  isAuthenticated: false,
  walletAddress: null,
});

export function useWalletAuthContext(): WalletAuthContextValue {
  return useContext(WalletAuthContext);
}

interface WalletAuthProviderProps {
  children: ReactNode;
}

export function WalletAuthProvider({ children }: WalletAuthProviderProps): React.ReactElement {
  const { walletAddress, expiresAt, setProfile, clearAuth } = useAuthStore();

  const isAuthenticated = Boolean(
    walletAddress && expiresAt && new Date(expiresAt).getTime() > Date.now(),
  );

  // Re-validate session on mount and hydrate profile
  useEffect(() => {
    if (!isAuthenticated) return;

    apiGet<UserProfile>('/auth/me')
      .then((profile) => setProfile(profile))
      .catch(() => {
        // Session expired or invalid — clear auth state
        clearAuth();
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <MeshProvider>
      <WalletAuthContext.Provider value={{ isAuthenticated, walletAddress }}>
        {children}
      </WalletAuthContext.Provider>
    </MeshProvider>
  );
}
