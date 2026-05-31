import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { post } from '@/lib/api';
import { useAuthStore, useIsAuthenticated } from '@/stores/authStore';

const ATTEMPT_FLAG = 'drep_autolink_attempted_for';

/**
 * Auto-detect + link the connected wallet's DRep via CIP-95, with no user
 * action. A DRep credential isn't derivable from a wallet address, so the only
 * automatic path is asking the wallet for its DRep key (getPubDRepKey) and
 * deriving the drep id server-side.
 *
 * Runs once per session per wallet, only when authenticated and not already a
 * DRep. Entirely best-effort and silent: wallets without CIP-95 (or wallets
 * that don't control a registered DRep) simply no-op, and the "Are you a DRep?"
 * form on Profile Setup remains the manual fallback.
 */
export function useAutoLinkDrep(): void {
  const isAuthed = useIsAuthenticated();
  const walletName = useAuthStore((s) => s.walletName);
  const walletAddress = useAuthStore((s) => s.walletAddress);
  const drepId = useAuthStore((s) => s.drepId);
  const qc = useQueryClient();
  const started = useRef(false);

  useEffect(() => {
    if (!isAuthed || !walletName || !walletAddress || drepId) return;
    if (started.current) return;
    // Once per session per wallet — avoids re-prompting the wallet on every nav.
    if (sessionStorage.getItem(ATTEMPT_FLAG) === walletAddress) return;
    started.current = true;
    sessionStorage.setItem(ATTEMPT_FLAG, walletAddress);

    void (async () => {
      try {
        const cardano = (
          window as unknown as {
            cardano?: Record<string, { enable?: (o?: unknown) => Promise<{ cip95?: { getPubDRepKey?: () => Promise<string> } }> }>;
          }
        ).cardano;
        const connector = cardano?.[walletName];
        if (!connector?.enable) return;
        const api = await connector.enable({ extensions: [{ cip: 95 }] });
        const key = await api?.cip95?.getPubDRepKey?.();
        if (!key) return; // wallet has no DRep key / no CIP-95
        await post('/drep/link', { drepKey: key });
        // Refresh anything that reflects DRep status.
        void qc.invalidateQueries({ queryKey: ['auth', 'me'] });
        void qc.invalidateQueries({ queryKey: ['profile'] });
      } catch {
        // Best-effort: not a DRep, or wallet doesn't support CIP-95. The manual
        // "Are you a DRep?" form covers those cases.
      }
    })();
  }, [isAuthed, walletName, walletAddress, drepId, qc]);
}
