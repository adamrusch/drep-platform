import React, { Suspense, lazy } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';

// Lazy-load WalletButton so the Mesh chunk is fetched only when this page
// actually renders. Keeps `/guest` (and any other page that lands a
// wallet button) off the modulepreload list for non-wallet pages.
// See `components/WalletButton.tsx` for the chunk-anchor rationale.
const WalletButton = lazy(() => import('@/components/WalletButton'));

export function GuestLanding(): React.ReactElement {
  return (
    <div className="flex flex-col items-center justify-center min-h-[70vh] text-center px-4">
      <div className="max-w-2xl space-y-6">
        <div className="space-y-2">
          <span className="text-xs font-semibold tracking-widest text-[var(--brand-primary)] uppercase">
            Cardano Governance
          </span>
          <h1 className="text-4xl font-bold tracking-tight text-[var(--text-primary)]">
            DRep Coordination Platform
          </h1>
          <p className="text-lg text-[var(--text-secondary)]">
            Transparent, community-driven governance coordination for Cardano delegators and
            DReps. Follow governance actions, participate in discussions, and hold your
            representatives accountable.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Suspense
            fallback={
              <Button variant="primary" disabled>
                Connect Wallet
              </Button>
            }
          >
            <WalletButton />
          </Suspense>
          <Button asChild variant="secondary">
            <Link to="/governance">Browse Governance Actions</Link>
          </Button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-8 text-left">
          {[
            {
              title: 'Track Governance',
              desc: 'Follow active proposals from parameter changes to treasury withdrawals, all synced from the chain.',
            },
            {
              title: 'Engage Your DRep',
              desc: 'Comment on proposals, see how your DRep plans to vote, and participate in the delegator clubhouse.',
            },
            {
              title: 'Stay Informed',
              desc: 'Get your delegation history, see epoch deadlines, and never miss an important vote.',
            },
          ].map(({ title, desc }) => (
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
