import React from 'react';
import { Link } from 'react-router-dom';
import { WalletButton } from '@/components/WalletButton';

export function GuestLanding(): React.ReactElement {
  return (
    <div className="flex flex-col items-center justify-center min-h-[70vh] text-center px-4">
      <div className="max-w-2xl space-y-6">
        <div className="space-y-2">
          <span className="text-xs font-medium tracking-widest text-cardano-blue uppercase">
            Cardano Governance
          </span>
          <h1 className="text-4xl font-bold tracking-tight">
            DRep Coordination Platform
          </h1>
          <p className="text-lg text-muted-foreground">
            Transparent, community-driven governance coordination for Cardano delegators and
            DReps. Follow governance actions, participate in discussions, and hold your
            representatives accountable.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <WalletButton />
          <Link
            to="/governance"
            className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent transition-colors"
          >
            Browse Governance Actions
          </Link>
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
            <div key={title} className="rounded-lg border border-border bg-card p-4">
              <h3 className="font-semibold mb-1">{title}</h3>
              <p className="text-sm text-muted-foreground">{desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
