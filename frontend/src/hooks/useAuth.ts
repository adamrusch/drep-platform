import { useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';
import { useIsAuthenticated } from '@/stores/authStore';
import type { UserProfile } from '@/types';

export function useMe() {
  const isAuthenticated = useIsAuthenticated();

  return useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => get<UserProfile>('/auth/me'),
    enabled: isAuthenticated,
    staleTime: 5 * 60 * 1_000,
  });
}

// NOTE: session refresh, logout, and mutation-nonce live in the flows that
// actually own them — `useWalletAuth` (logout → DELETE /auth/session) and
// `useMutationSign` (POST /auth/mutation-nonce). Earlier duplicate hooks here
// were dead code (one even hit a wrong `/api/` prefix); removed 2026-05-31.
