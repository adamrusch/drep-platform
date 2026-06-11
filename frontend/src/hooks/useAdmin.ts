import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { get, post, put, del } from '@/lib/api';

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

// ---- Moderation queue ----

export type ModerationContentType =
  | 'comment'
  | 'clubhouse_post'
  | 'clubhouse_comment';

/** One queue card returned by `GET /admin/moderation/flagged`. */
export interface ModerationQueueItem {
  type: ModerationContentType;
  id: string;
  parent: {
    actionId?: string;
    drepId?: string;
    postId?: string;
    commentId?: string;
  };
  authorWallet: string;
  authorDisplayName?: string;
  snippet: string;
  flagCount: number;
  hidden: boolean;
  createdAt: string;
}

export interface ModerationFlagger {
  flaggerId: string;
  role: string;
  createdAt: string;
}

/** Fetches the moderation queue. `type` narrows to one content type;
 *  omit to get all three combined. Only enabled for `platform_admin`s
 *  — the gate is enforced via the `enabled` prop the caller supplies. */
export function useFlaggedQueue(opts: {
  type?: ModerationContentType;
  enabled?: boolean;
} = {}) {
  const { type, enabled = true } = opts;
  return useQuery({
    queryKey: ['admin', 'moderation', 'flagged', type ?? 'all'],
    queryFn: () =>
      get<{
        items: ModerationQueueItem[];
        count: number;
        type?: ModerationContentType;
      }>('/admin/moderation/flagged', type ? { type } : undefined),
    enabled,
    staleTime: 10_000,
  });
}

/** Fetches the flaggers of one item. Lazy-loaded — call with `enabled`
 *  bound to "the user expanded this row." */
export function useFlaggers(
  target: {
    type: ModerationContentType;
    actionId?: string;
    drepId?: string;
    postId?: string;
    commentId?: string;
  } | null,
  enabled = true,
) {
  return useQuery({
    queryKey: ['admin', 'moderation', 'flaggers', target],
    queryFn: () => {
      if (!target) throw new Error('target is required');
      const params: Record<string, string> = { type: target.type };
      if (target.actionId) params['actionId'] = target.actionId;
      if (target.commentId) params['commentId'] = target.commentId;
      if (target.drepId) params['drepId'] = target.drepId;
      if (target.postId) params['postId'] = target.postId;
      return get<{
        type: ModerationContentType;
        flaggers: ModerationFlagger[];
        count: number;
      }>('/admin/moderation/flaggers', params);
    },
    enabled: enabled && target !== null,
    staleTime: 10_000,
  });
}

export interface SetHiddenParams {
  type: ModerationContentType;
  hidden: boolean;
  expected?: boolean | null;
  reason?: string;
  actionId?: string;
  commentId?: string;
  drepId?: string;
  postId?: string;
}

/** Override the `hidden` boolean on a flagged item. On success we
 *  invalidate every queue + flaggers query so the UI re-reads fresh. */
export function useSetHidden() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: SetHiddenParams) =>
      put<{
        type: ModerationContentType;
        oldHidden: boolean;
        newHidden: boolean;
      }>('/admin/moderation/hidden', params),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'moderation'] });
    },
  });
}
