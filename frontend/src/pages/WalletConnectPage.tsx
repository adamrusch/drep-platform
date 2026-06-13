import type React from 'react';
import { Suspense, lazy } from 'react';
import { Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useIsAuthenticated } from '@/stores/authStore';
import { Button } from '@/components/ui/Button';

// Lazy-load WalletButton so the Mesh chunk only fetches on routes that
// actually render it. Same anchor-management strategy as Layout.tsx —
// see `components/WalletButton.tsx` for the rationale.
const WalletButton = lazy(() => import('@/components/WalletButton'));

export function WalletConnectPage(): React.ReactElement {
  const { t } = useTranslation();
  const isAuthenticated = useIsAuthenticated();

  if (isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-[70vh] text-center px-4">
      <div className="max-w-md space-y-6">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold">{t('walletConnect.title')}</h1>
          <p className="text-muted-foreground">{t('walletConnect.intro')}</p>
        </div>

        <Suspense
          fallback={
            <Button variant="primary" disabled className="w-full justify-center py-3">
              {t('walletConnect.connectWallet')}
            </Button>
          }
        >
          <WalletButton className="w-full justify-center py-3" />
        </Suspense>

        <div className="text-xs text-muted-foreground space-y-1">
          <p>{t('walletConnect.gasless')}</p>
          <p>{t('walletConnect.signatureUse')}</p>
        </div>
      </div>
    </div>
  );
}
