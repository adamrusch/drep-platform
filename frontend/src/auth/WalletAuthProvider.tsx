import React, { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useAuthStore } from '@/stores/authStore';
import { useMe } from '@/hooks/useAuth';

/**
 * Lightweight auth-state provider.
 *
 * Two responsibilities:
 *   1. Expose the boolean `isAuthenticated` / `walletAddress` via a
 *      context (preferred over reading the store directly when the
 *      consumer wants compile-time guarantees about the shape).
 *   2. On mount, re-validate the session against `/auth/me` and hydrate
 *      the profile. If the cookie's gone (expired or revoked), clear
 *      local state so the UI logs out cleanly.
 *
 * What we deliberately do NOT do here:
 *   - Import `@meshsdk/react`. Mesh's chunk (~1.3 MB gz including the
 *     Cardano serialization-lib WASM) is needed only for the wallet-
 *     connection dropdown. Static-importing `MeshProvider` here used to
 *     anchor the mesh chunk into the entry graph, which made Vite emit
 *     a `<link rel="modulepreload">` on every page — including
 *     `/governance` and `/dreps` where the user isn't connecting a
 *     wallet. WalletButton now mounts its own MeshProvider internally,
 *     so the chunk is lazy-loaded with the button.
 *
 * Backwards compat: `useWalletAuthContext` is kept as a public read
 * surface so existing callers don't need to switch to the Zustand
 * store directly.
 */
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

  // The single source of truth for the live profile is the `['auth','me']`
  // query (enabled only when authenticated). We mirror its data into the
  // Zustand store on every change — so ANY invalidation of `/auth/me`
  // (linking a DRep, accepting a committee invite, declining invites, …)
  // refreshes the store's derived fields (drepId, roles, committeeMembership)
  // WITHOUT a reload. Previously this provider did a one-shot fetch on mount,
  // which is why those fields went stale until the next full page load.
  const { data: meProfile, isError: meError } = useMe();

  useEffect(() => {
    if (meProfile) setProfile(meProfile);
  }, [meProfile, setProfile]);

  useEffect(() => {
    // A hard error from `/auth/me` (after React-Query's retries) means the
    // session cookie is gone or invalid — log out cleanly.
    if (meError) clearAuth();
  }, [meError, clearAuth]);

  return (
    <WalletAuthContext.Provider value={{ isAuthenticated, walletAddress }}>
      {children}
    </WalletAuthContext.Provider>
  );
}

/**
 * Network identifier read from `VITE_CARDANO_NETWORK` (mainnet | preprod |
 * preview). Used by components that need the network for Blockfrost/Koios
 * lookups or to validate that the connected wallet matches.
 */
export const CARDANO_NETWORK: 'mainnet' | 'preprod' | 'preview' =
  (import.meta.env.VITE_CARDANO_NETWORK as 'mainnet' | 'preprod' | 'preview' | undefined) ??
  'mainnet';
