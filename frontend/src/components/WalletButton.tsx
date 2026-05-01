import React, { useState } from 'react';
import { useWallet, useWalletList } from '@meshsdk/react';
import { useAuthStore } from '@/stores/authStore';
import { useWalletAuth } from '@/auth/useWalletAuth';
import { useUiStore } from '@/stores/uiStore';
import { cn } from '@/lib/utils';

interface WalletButtonProps {
  className?: string;
}

export function WalletButton({ className }: WalletButtonProps): React.ReactElement {
  const { wallet, connected } = useWallet();
  const walletList = useWalletList();
  const { isAuthenticated, walletAddress } = useAuthStore();
  const { authenticate, logout, isLoading, error } = useWalletAuth();
  const { addToast } = useUiStore();
  const [showWalletList, setShowWalletList] = useState(false);

  const handleConnectWallet = async (walletName: string): Promise<void> => {
    try {
      const cardano = window.cardano;
      if (!cardano) throw new Error('No Cardano wallet found');
      const connector = cardano[walletName];
      if (!connector) throw new Error(`Wallet "${walletName}" is not installed`);
      const api = await connector.enable();
      if (!api) throw new Error('Failed to connect wallet');
      await authenticate(api);
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
      <button
        onClick={handleDisconnect}
        disabled={isLoading}
        className={cn(
          'rounded-md border border-border px-3 py-1.5 text-sm font-medium',
          'hover:bg-accent hover:text-accent-foreground transition-colors',
          'disabled:opacity-50',
          className,
        )}
      >
        {isLoading ? 'Disconnecting…' : `${walletAddress.slice(0, 8)}…`}
      </button>
    );
  }

  return (
    <div className="relative">
      <button
        onClick={() => setShowWalletList(!showWalletList)}
        disabled={isLoading}
        className={cn(
          'rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm font-medium',
          'hover:bg-primary/90 transition-colors',
          'disabled:opacity-50',
          className,
        )}
      >
        {isLoading ? 'Connecting…' : 'Connect Wallet'}
      </button>

      {showWalletList && (
        <div className="absolute right-0 top-full mt-1 w-48 rounded-md border border-border bg-popover shadow-lg z-50">
          {walletList.length === 0 ? (
            <div className="p-3 text-sm text-muted-foreground">
              No Cardano wallets detected.
              <br />
              Install Nami, Eternl, or Flint.
            </div>
          ) : (
            walletList.map((w) => (
              <button
                key={w.name}
                onClick={() => void handleConnectWallet(w.name)}
                className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent transition-colors"
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
        <p className="absolute top-full mt-1 right-0 text-xs text-destructive w-48 text-right">
          {error}
        </p>
      )}
    </div>
  );
}
