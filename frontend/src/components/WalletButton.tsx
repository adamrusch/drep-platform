import type React from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MeshProvider, useWallet, useWalletList } from '@meshsdk/react';
import { useAuthStore, useIsAuthenticated } from '@/stores/authStore';
import { useWalletAuth } from '@/auth/useWalletAuth';
import { CARDANO_NETWORK } from '@/auth/WalletAuthProvider';
import { useUiStore } from '@/stores/uiStore';
import { Button } from '@/components/ui/Button';

/**
 * Wallet-connection button used in the topbar.
 *
 * # Lazy-load contract
 *
 * This module is the ONLY consumer of `@meshsdk/react` hooks (`useWallet`,
 * `useWalletList`, `MeshProvider`). It's also the entry point for the
 * ~1.3 MB-gzipped mesh chunk + 5.4 MB Cardano serialization-lib WASM.
 *
 * To keep first-paint on `/governance` and `/dreps` fast, the import is
 * dynamic from `Layout.tsx` (and any other host site that lands a wallet
 * button). The module mounts its own `<MeshProvider>` internally so it
 * can be plugged in via `React.lazy(() => import('./WalletButton'))`
 * without the host needing to also wrap a provider around the suspense
 * boundary.
 *
 * The export is a DEFAULT export specifically because `React.lazy` only
 * works with default exports — see `Layout.tsx` for the consumer.
 *
 * # CIP-30 + CARDANO_NETWORK contract
 *
 * The button enforces a network match before authenticating: CIP-30's
 * `getNetworkId()` returns 1 for mainnet, 0 for testnets. We compare
 * against `CARDANO_NETWORK` so a user connecting their preprod wallet
 * to a mainnet build sees a clear error instead of a confusing
 * stake1u… mismatch downstream.
 */
interface WalletButtonProps {
  className?: string;
}

function WalletButtonInner({ className }: WalletButtonProps): React.ReactElement {
  const { wallet: _wallet, connected: _connected } = useWallet();
  void _wallet;
  void _connected;
  const walletList = useWalletList();
  const isAuthenticated = useIsAuthenticated();
  const walletAddress = useAuthStore((s) => s.walletAddress);
  const { authenticate, logout, isLoading, error } = useWalletAuth();
  const { addToast } = useUiStore();
  const { t } = useTranslation();
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
        {isLoading ? t('common.disconnecting') : `${walletAddress.slice(0, 8)}…`}
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
        {isLoading ? t('common.connecting') : t('common.connectWallet')}
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
                type="button"
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

/**
 * Default export wraps the inner button in its own `<MeshProvider>`.
 *
 * Why the wrapper lives here rather than at the app root: anchoring
 * MeshProvider at the app root via the WalletAuthProvider used to pull
 * the mesh chunk into the entry graph (vite + the rollupOptions chunk
 * declaration in `vite.config.ts` couldn't break that link). Mounting
 * MeshProvider inside the lazy-loaded WalletButton module means the
 * provider AND its dependency tree are emitted as the mesh chunk and
 * only fetched when this module loads — i.e. when the host renders
 * the suspense fallback's replacement.
 *
 * Mounting MeshProvider per WalletButton instance is fine: it's a
 * lightweight React context provider underneath; Mesh's internal state
 * (wallet handle, connected flag) is per-context, and the topbar
 * mounts exactly one button. If a page ever renders multiple wallet
 * buttons they'd each get their own Mesh context — that would only
 * matter if a connection in one had to be observable from the other,
 * which is not a flow the platform supports.
 */
function WalletButton(props: WalletButtonProps): React.ReactElement {
  return (
    <MeshProvider>
      <WalletButtonInner {...props} />
    </MeshProvider>
  );
}

/**
 * Default + named export of the same component. `React.lazy` requires a
 * default export; existing consumers (`GuestLanding.tsx`,
 * `WalletConnectPage.tsx`) import the named binding and don't need to
 * switch to lazy. Both forms resolve to the MeshProvider-wrapped variant.
 */
export default WalletButton;
export { WalletButton };
