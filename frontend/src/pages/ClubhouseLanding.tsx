import type React from 'react';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isAuthenticated = useIsAuthenticated();
  const registeredDrepId = useAuthStore((s) => s.drepId);
  const { data: profile } = useMe();

  // Routing priority (most specific to least):
  //  1. `profile.delegatedToDrepId` — live on-chain delegation read by
  //     `/auth/me`. THIS is the right answer 99% of the time: "the DRep
  //     this wallet currently backs." Reads fresh on every session mount.
  //  2. `registeredDrepId` (`drepId` in the auth store) — set when the
  //     logged-in wallet IS itself a DRep. Routes a DRep into their own
  //     clubhouse so they can manage their delegators' threads.
  //  3. The newest non-undelegated entry in the DDB-stored delegation
  //     history. Fallback for stale-cache cases where step 1 hasn't
  //     resolved yet (a flicker on the very first render).
  //  4. The last entry in the delegation history, undelegated or not —
  //     surfaces "the DRep you were last with" instead of nothing.
  //
  // We deliberately do NOT preserve the old behavior of taking
  // `registeredDrepId` first — that bug was the entire point of the
  // "wallet's DRep not recognized" issue: it pinned routing to the DRep
  // the user REGISTERED AS, not the DRep they DELEGATE to. The fields
  // are independent on-chain concepts. See the `/auth/me` handler's
  // file-header for the full rationale.
  const targetDrepId =
    profile?.delegatedToDrepId ??
    registeredDrepId ??
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
          {t('clubhouse.title')}
        </h1>
        <p className="text-sm text-[var(--text-secondary)] max-w-md mx-auto mb-6">
          {isAuthenticated
            ? t('clubhouse.landing.notDelegated')
            : t('clubhouse.landing.guest')}
        </p>
        <Button asChild variant="primary">
          <a href="/dreps">{t('clubhouse.landing.browseDReps')}</a>
        </Button>
      </Card>
    </div>
  );
}
