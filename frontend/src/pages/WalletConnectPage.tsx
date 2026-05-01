import React from 'react';
import { Navigate } from 'react-router-dom';
import { useIsAuthenticated } from '@/stores/authStore';
import { WalletButton } from '@/components/WalletButton';

export function WalletConnectPage(): React.ReactElement {
  const isAuthenticated = useIsAuthenticated();

  if (isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-[70vh] text-center px-4">
      <div className="max-w-md space-y-6">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold">Connect Your Wallet</h1>
          <p className="text-muted-foreground">
            Connect a CIP-30 compatible Cardano wallet (Nami, Eternl, Flint, or Typhon) to
            authenticate with the DRep Coordination Platform.
          </p>
        </div>

        <WalletButton className="w-full justify-center py-3" />

        <div className="text-xs text-muted-foreground space-y-1">
          <p>Signing in is gasless and does not trigger any blockchain transaction.</p>
          <p>Your wallet signature is used only to verify wallet ownership.</p>
        </div>
      </div>
    </div>
  );
}
