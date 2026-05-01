import { useState, useCallback } from 'react';
import { post, get as apiGet, del as apiDelete } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import type { UserRole, SessionType, UserProfile } from '@/types';

interface ChallengeResponse {
  nonce: string;
  message: string;
  expiresAt: string;
}

interface VerifyResponse {
  walletAddress: string;
  roles: UserRole[];
  sessionType: SessionType;
  expiresAt: string;
  drepId?: string;
}

interface WalletApi {
  signData: (
    address: string,
    payload: string,
  ) => Promise<{ signature: string; key: string }>;
  getRewardAddresses: () => Promise<string[]>;
  getUsedAddresses: () => Promise<string[]>;
}

export interface UseWalletAuthReturn {
  isLoading: boolean;
  error: string | null;
  authenticate: (walletApi: WalletApi, rememberMe?: boolean) => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
}

export function useWalletAuth(): UseWalletAuthReturn {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { setAuth, setProfile, clearAuth } = useAuthStore();

  const authenticate = useCallback(
    async (walletApi: WalletApi, rememberMe = false): Promise<void> => {
      setIsLoading(true);
      setError(null);

      try {
        // 1. Get the wallet address (prefer stake address for signing)
        const rewardAddresses = await walletApi.getRewardAddresses();
        const usedAddresses = await walletApi.getUsedAddresses();
        const walletAddress =
          rewardAddresses[0] ?? usedAddresses[0];

        if (!walletAddress) {
          throw new Error('No wallet address found. Ensure your wallet is unlocked.');
        }

        // 2. Request challenge from backend
        const challenge = await post<ChallengeResponse>('/auth/challenge', {
          walletAddress,
        });

        // 3. Convert message to hex for CIP-30 signData
        const messageHex = Buffer.from(challenge.message, 'utf-8').toString('hex');

        // 4. Sign with wallet (CIP-30)
        const { signature, key } = await walletApi.signData(walletAddress, messageHex);

        // 5. Verify signature with backend
        const authResult = await post<VerifyResponse>('/auth/verify', {
          walletAddress,
          nonce: challenge.nonce,
          signature,
          key,
          rememberMe,
        });

        // 6. Store auth state
        setAuth({
          walletAddress: authResult.walletAddress,
          roles: authResult.roles,
          sessionType: authResult.sessionType,
          expiresAt: authResult.expiresAt,
          drepId: authResult.drepId,
        });

        // 7. Fetch full profile
        try {
          const profile = await apiGet<UserProfile>('/auth/me');
          setProfile(profile);
        } catch {
          // Non-fatal — auth succeeded even if profile fetch fails
        }
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : (err as { message?: string }).message ?? 'Authentication failed';
        setError(message);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [setAuth, setProfile],
  );

  const logout = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    try {
      // Backend exposes DELETE /auth/session for logout. The cookie is cleared
      // server-side via Set-Cookie: Max-Age=0 in the response.
      await apiDelete('/auth/session');
    } catch {
      // Ignore logout errors — clear local state regardless so the UI logs out
    } finally {
      clearAuth();
      setIsLoading(false);
    }
  }, [clearAuth]);

  const clearError = useCallback(() => setError(null), []);

  return { isLoading, error, authenticate, logout, clearError };
}
