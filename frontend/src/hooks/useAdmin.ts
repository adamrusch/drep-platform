import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { get, post, del } from '@/lib/api';

const enc = encodeURIComponent;

export interface SafetyModeStatus {
  active: boolean;
  triggeredAt: string | null;
  expiresAt: number | null;
  triggeredByCount: number | null;
}

export function useSafetyMode(enabled = true) {
  return useQuery({
    queryKey: ['admin', 'safety-mode'],
    queryFn: () => get<SafetyModeStatus>('/admin/safety-mode'),
    enabled,
    staleTime: 15_000,
  });
}

export function useClearSafetyMode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => post('/admin/safety-mode/clear'),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'safety-mode'] }),
  });
}

export function useGrantPlatformAdmin() {
  return useMutation({
    mutationFn: (walletAddress: string) =>
      post<{ walletAddress: string; roles: string[] }>(`/admin/roles/${enc(walletAddress)}`),
  });
}

export function useRevokePlatformAdmin() {
  return useMutation({
    mutationFn: (walletAddress: string) =>
      del<{ walletAddress: string; roles: string[] }>(`/admin/roles/${enc(walletAddress)}`),
  });
}
