import { useQuery, useMutation } from '@tanstack/react-query';
import { get, post } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { queryClient } from '@/lib/api';
import type { UserProfile } from '@/types';

export function useMe() {
  const { isAuthenticated } = useAuthStore();

  return useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => get<UserProfile>('/auth/me'),
    enabled: isAuthenticated,
    staleTime: 5 * 60 * 1_000,
  });
}

export function useRefreshSession() {
  const { refreshExpiry } = useAuthStore();

  return useMutation({
    mutationFn: () =>
      post<{ walletAddress: string; expiresAt: string; sessionType: string }>('/auth/refresh'),
    onSuccess: (data) => {
      refreshExpiry(data.expiresAt);
    },
  });
}

export function useLogout() {
  const { clearAuth } = useAuthStore();

  return useMutation({
    mutationFn: async () => {
      await fetch('/api/auth/session', { method: 'DELETE', credentials: 'include' });
    },
    onSettled: () => {
      clearAuth();
      queryClient.clear();
    },
  });
}

export function useMutationNonce() {
  return useMutation({
    mutationFn: () =>
      post<{ nonce: string; message: string; expiresAt: string }>('/auth/mutation-nonce'),
  });
}
