import React, { Suspense, lazy } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';

// Lazy-load WalletButton so the Mesh chunk is fetched only when this page
// actually renders. Keeps `/guest` (and any other page that lands a
// wallet button) off the modulepreload list for non-wallet pages.
// See `components/WalletButton.tsx` for the chunk-anchor rationale.
const WalletButton = lazy(() => import('@/components/WalletButton'));

export function GuestLanding(): React.ReactElement {
  const { t } = useTranslation();
  const cards = [
    { title: t('guest.card1Title'), desc: t('guest.card1Desc') },
    { title: t('guest.card2Title'), desc: t('guest.card2Desc') },
    { title: t('guest.card3Title'), desc: t('guest.card3Desc') },
  ];
  return (
    <div className="flex flex-col items-center justify-center min-h-[70vh] text-center px-4">
      <div className="max-w-2xl space-y-6">
        <div className="space-y-2">
          <span className="text-xs font-semibold tracking-widest text-[var(--brand-primary)] uppercase">
            {t('guest.eyebrow')}
          </span>
          <h1 className="text-4xl font-bold tracking-tight text-[var(--text-primary)]">
            {t('guest.title')}
          </h1>
          <p className="text-lg text-[var(--text-secondary)]">{t('guest.subtitle')}</p>
        </div>

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Suspense
            fallback={
              <Button variant="primary" disabled>
                {t('common.connectWallet')}
              </Button>
            }
          >
            <WalletButton />
          </Suspense>
          <Button asChild variant="secondary">
            <Link to="/governance">{t('guest.browse')}</Link>
          </Button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-8 text-left">
          {cards.map(({ title, desc }) => (
            <Card key={title} interactive className="p-4">
              <h3 className="font-semibold mb-1 text-[var(--text-primary)]">{title}</h3>
              <p className="text-sm text-[var(--text-secondary)] leading-relaxed">{desc}</p>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
