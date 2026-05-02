import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useMe } from '@/hooks/useAuth';
import { useAuthStore, useIsAuthenticated } from '@/stores/authStore';

/**
 * Landing for `/clubhouse`. The clubhouse experience is per-DRep — this
 * route redirects authenticated delegators into their current DRep's
 * clubhouse. Guests / un-delegated wallets see a CTA card.
 *
 * Why not just route /clubhouse to the dedicated clubhouse view?
 * Because the clubhouse component requires a `drepId` URL param, and
 * we don't always have one to inject. This file picks the right param
 * (or punts gracefully if none is available).
 */
export function ClubhouseLanding(): React.ReactElement {
  const navigate = useNavigate();
  const isAuthenticated = useIsAuthenticated();
  const drepId = useAuthStore((s) => s.drepId);
  const { data: profile } = useMe();

  // Pick the most recent active delegation, falling back to the auth
  // context's drepId (set when a lead-DRep wallet logs in).
  const targetDrepId =
    drepId ??
    profile?.delegationHistory?.find((d) => !d.undelegatedAt)?.drepId ??
    profile?.delegationHistory?.[(profile.delegationHistory?.length ?? 1) - 1]?.drepId;

  useEffect(() => {
    if (isAuthenticated && targetDrepId) {
      navigate(`/drep/${encodeURIComponent(targetDrepId)}/delegators`, {
        replace: true,
      });
    }
  }, [isAuthenticated, targetDrepId, navigate]);

  return (
    <div className="max-w-3xl mx-auto">
      <Card padLg className="text-center py-12">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-token-full bg-[var(--brand-primary-soft)] text-[var(--brand-primary)] mb-4">
          <Lock size={24} strokeWidth={1.75} />
        </div>
        <h1 className="text-2xl font-bold mb-2 text-[var(--text-primary)]">
          Delegator Clubhouse
        </h1>
        <p className="text-sm text-[var(--text-secondary)] max-w-md mx-auto mb-6">
          {isAuthenticated
            ? 'You aren\'t delegated to a DRep yet. Browse the directory to find one and join their clubhouse.'
            : 'Connect a wallet that delegates to a DRep to enter their private clubhouse.'}
        </p>
        <Button asChild variant="primary">
          <a href="/dreps">Browse DReps</a>
        </Button>
      </Card>
    </div>
  );
}
