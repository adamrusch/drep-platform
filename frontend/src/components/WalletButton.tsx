import React, { useState } from 'react';
import { useWallet, useWalletList } from '@meshsdk/react';
import { useAuthStore, useIsAuthenticated } from '@/stores/authStore';
import { useWalletAuth } from '@/auth/useWalletAuth';
import { CARDANO_NETWORK } from '@/auth/WalletAuthProvider';
import { useUiStore } from '@/stores/uiStore';
import { Button } from '@/components/ui/Button';

interface WalletButtonProps {
  className?: string;
}

export function WalletButton({ className }: WalletButtonProps): React.ReactElement {
  const { wallet: _wallet, connected: _connected } = useWallet();
  void _wallet;
  void _connected;
  const walletList = useWalletList();
  const isAuthenticated = useIsAuthenticated();
  const walletAddress = useAuthStore((s) => s.walletAddress);
  const { authenticate, logout, isLoading, error } = useWalletAuth();
  const { addToast } = useUiStore();
  const [showWalletList, setShowWalletList] = useState(false);

  const handleConnectWallet = async (walletName: string): Promise<void> => {
    try {
      const cardano = window.cardano;
      if (!cardano) throw new Error('No Cardano wallet found');
      const connector = cardano[walletName];
      if (!connector) throw new Error(`Wallet "${walletName}" is not installed`);

      // Pre-flight: many CIP-30 wallets (notably Eternl) silently return
      // null from `enable()` if the extension is locked, instead of throwing.
      // `isEnabled()` lets us surface a clear error before the user faces a
      // mystery silent failure. We don't gate connect on it (some wallets
      // don't implement isEnabled), it's a best-effort hint.
      let alreadyEnabled: boolean | null = null;
      if (typeof connector.isEnabled === 'function') {
        try {
          alreadyEnabled = await connector.isEnabled();
        } catch {
          alreadyEnabled = null;
        }
      }

      const api = await connector.enable();
      if (!api) {
        // Silent null is the wallet's way of saying "I rejected the request"
        // without firing a proper error. Three common root causes — surface
        // them so the user knows what to check.
        const niceName = walletName.charAt(0).toUpperCase() + walletName.slice(1);
        const hint = alreadyEnabled === false
          ? `${niceName} returned no API — the wallet is likely locked. Open the ${niceName} extension, unlock it, and try again.`
          : `${niceName} did not return an API. Check that ${niceName} is unlocked, on the correct network (${CARDANO_NETWORK}), and that drep.tools is authorized in the extension's Connected dApps list.`;
        throw new Error(hint);
      }

      // CIP-30 returns 1 for mainnet, 0 for testnets (preprod/preview).
      // Enforce mainnet to prevent users from accidentally connecting on the
      // wrong network — the platform reads on-chain governance state from
      // mainnet only and stake addresses are network-prefixed.
      const networkId = await api.getNetworkId();
      const expectedNetworkId = CARDANO_NETWORK === 'mainnet' ? 1 : 0;
      if (networkId !== expectedNetworkId) {
        const got = networkId === 1 ? 'mainnet' : 'a testnet (preprod/preview)';
        throw new Error(
          `Wallet is connected to ${got}. Please switch your wallet to ${CARDANO_NETWORK} and try again.`,
        );
      }

      await authenticate(api, false, walletName);
      setShowWalletList(false);
      addToast({ title: 'Wallet connected', variant: 'success' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to connect wallet';
      addToast({ title: 'Connection failed', description: msg, variant: 'error' });
    }
  };

  const handleDisconnect = async (): Promise<void> => {
    await logout();
    addToast({ title: 'Wallet disconnected', variant: 'default' });
  };

  if (isAuthenticated && walletAddress) {
    return (
      <Button
        variant="secondary"
        onClick={() => void handleDisconnect()}
        disabled={isLoading}
        className={className}
      >
        {isLoading ? 'Disconnecting…' : `${walletAddress.slice(0, 8)}…`}
      </Button>
    );
  }

  return (
    <div className="relative">
      <Button
        variant="primary"
        onClick={() => setShowWalletList(!showWalletList)}
        disabled={isLoading}
        className={className}
      >
        {isLoading ? 'Connecting…' : 'Connect Wallet'}
      </Button>

      {showWalletList && (
        <div
          className="absolute right-0 top-full mt-2 w-56 rounded-token-lg border border-[var(--border-default)] bg-[var(--bg-canvas)] shadow-token-lg z-50 py-1"
        >
          {walletList.length === 0 ? (
            <div className="p-3 text-sm text-[var(--text-secondary)]">
              No Cardano wallets detected.
              <br />
              Install Nami, Eternl, or Flint.
            </div>
          ) : (
            walletList.map((w) => (
              <button
                key={w.name}
                onClick={() => void handleConnectWallet(w.name)}
                className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-[var(--bg-muted)] transition-colors text-[var(--text-primary)]"
              >
                {w.icon && (
                  <img src={w.icon} alt={w.name} className="h-5 w-5 rounded" />
                )}
                {w.name}
              </button>
            ))
          )}
        </div>
      )}

      {error && (
        <p className="absolute top-full mt-1 right-0 text-xs text-[var(--danger)] w-56 text-right">
          {error}
        </p>
      )}
    </div>
  );
}
