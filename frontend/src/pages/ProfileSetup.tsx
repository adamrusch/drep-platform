import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { post } from '@/lib/api';
import { useMe } from '@/hooks/useAuth';
import { useAuthStore } from '@/stores/authStore';
import { useUiStore } from '@/stores/uiStore';
import { useLinkDrep } from '@/hooks/useCommitteeMembership';
import { pasteDrepLinkAllowed } from '@/lib/stage';
import type { UserProfile } from '@/types';

export function ProfileSetup(): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: profile } = useMe();
  const { setProfile } = useAuthStore();
  const { addToast } = useUiStore();

  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [twitter, setTwitter] = useState('');
  const [github, setGithub] = useState('');
  const [website, setWebsite] = useState('');

  useEffect(() => {
    if (profile) {
      setDisplayName(profile.displayName ?? '');
      setBio(profile.bio ?? '');
      setTwitter(profile.socialLinks?.twitter ?? '');
      setGithub(profile.socialLinks?.github ?? '');
      setWebsite(profile.socialLinks?.website ?? '');
    }
  }, [profile]);

  const upsertProfile = useMutation({
    mutationFn: (data: Partial<UserProfile>) => post<UserProfile>('/profile', data),
    onSuccess: (updated) => {
      setProfile(updated);
      addToast({ title: t('profileSetup.savedToast'), variant: 'success' });
      void navigate('/');
    },
    onError: () => {
      addToast({ title: t('profileSetup.saveFailedToast'), variant: 'error' });
    },
  });

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    upsertProfile.mutate({
      displayName: displayName.trim() || undefined,
      bio: bio.trim() || undefined,
      socialLinks: {
        twitter: twitter.trim() || undefined,
        github: github.trim() || undefined,
        website: website.trim() || undefined,
      },
    });
  };

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <h1 className="text-2xl font-bold">
        {profile?.displayName ? t('profileSetup.editTitle') : t('profileSetup.setupTitle')}
      </h1>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">{t('profileSetup.displayName')}</label>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={100}
            placeholder={t('profileSetup.displayNamePlaceholder')}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">{t('profileSetup.bio')}</label>
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            maxLength={2_000}
            rows={4}
            placeholder={t('profileSetup.bioPlaceholder')}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
          />
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-medium">{t('profileSetup.socialLinks')}</h3>
          {[
            { key: 'twitter', value: twitter, setter: setTwitter },
            { key: 'github', value: github, setter: setGithub },
            { key: 'website', value: website, setter: setWebsite },
          ].map(({ key, value, setter }) => (
            <div key={key}>
              <label className="block text-xs text-muted-foreground mb-1">{t(`profileSetup.fields.${key}`)}</label>
              <input
                value={value}
                onChange={(e) => setter(e.target.value)}
                placeholder={t(`profileSetup.placeholders.${key}`)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          ))}
        </div>

        <button
          type="submit"
          disabled={upsertProfile.isPending}
          className="w-full rounded-md bg-primary text-primary-foreground py-2 text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
        >
          {upsertProfile.isPending ? t('profileSetup.saving') : t('profileSetup.save')}
        </button>
      </form>

      <DrepLinkSection currentDrepId={profile?.drepId} />
    </div>
  );
}

/**
 * Link your wallet to your on-chain DRep so you're recognized as a DRep across
 * the platform — no committee required. CIP-95 (proves control) or paste.
 */
function DrepLinkSection({ currentDrepId }: { currentDrepId?: string }): React.ReactElement {
  const { t } = useTranslation();
  const walletName = useAuthStore((s) => s.walletName);
  const link = useLinkDrep();
  const [drepId, setDrepId] = useState('');
  const [detecting, setDetecting] = useState(false);
  const [detectErr, setDetectErr] = useState<string | null>(null);
  const [linked, setLinked] = useState<{ drepId: string; drepName?: string } | null>(null);

  const detectAndLink = async (): Promise<void> => {
    setDetecting(true);
    setDetectErr(null);
    try {
      const cardano = (
        window as unknown as {
          cardano?: Record<string, { enable: (o?: unknown) => Promise<{ cip95?: { getPubDRepKey?: () => Promise<string> } }> }>;
        }
      ).cardano;
      const connector = walletName ? cardano?.[walletName] : undefined;
      if (!connector) throw new Error(t('profileSetup.drepLink.reconnectError'));
      const api = await connector.enable({ extensions: [{ cip: 95 }] });
      const key = await api?.cip95?.getPubDRepKey?.();
      if (!key) throw new Error(t('profileSetup.drepLink.noKeyError'));
      link.mutate({ drepKey: key }, { onSuccess: (r) => setLinked(r) });
    } catch (e) {
      setDetectErr((e as Error)?.message ?? t('profileSetup.drepLink.readKeyError'));
    } finally {
      setDetecting(false);
    }
  };

  const linkPasted = (): void => {
    if (!/^drep1[0-9a-z]{10,}$/.test(drepId.trim())) return;
    link.mutate({ drepId: drepId.trim() }, { onSuccess: (r) => setLinked(r) });
  };

  const active = linked?.drepId ?? currentDrepId;

  return (
    <div className="mt-6 rounded-md border border-[var(--border-default)] p-4 space-y-2">
      <h3 className="text-sm font-medium">{t('profileSetup.drepLink.heading')}</h3>
      {active ? (
        <p className="text-[13px] text-[var(--text-secondary)]">
          {linked?.drepName
            ? t('profileSetup.drepLink.linkedWithName', { name: linked.drepName })
            : t('profileSetup.drepLink.linked')}
        </p>
      ) : (
        <>
          <p className="text-[12.5px] text-[var(--text-secondary)]">
            {t('profileSetup.drepLink.explainer')}
          </p>
          <div className="flex flex-wrap gap-2">
            {pasteDrepLinkAllowed() && (
              <>
                <input
                  value={drepId}
                  onChange={(e) => setDrepId(e.target.value)}
                  placeholder={t('profileSetup.drepLink.drepIdPlaceholder')}
                  className="flex-1 min-w-[220px] rounded-md border border-[var(--border-default)] bg-[var(--bg-canvas)] px-3 py-1.5 text-[12.5px] font-mono"
                />
                <button
                  type="button"
                  disabled={!/^drep1[0-9a-z]{10,}$/.test(drepId.trim()) || link.isPending}
                  onClick={linkPasted}
                  className="rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-[12.5px] font-medium disabled:opacity-50"
                >
                  {link.isPending ? t('profileSetup.drepLink.linking') : t('profileSetup.drepLink.link')}
                </button>
              </>
            )}
            <button
              type="button"
              disabled={detecting || link.isPending}
              onClick={() => void detectAndLink()}
              className="rounded-md border border-[var(--border-default)] px-3 py-1.5 text-[12.5px] font-medium disabled:opacity-50"
            >
              {detecting ? t('profileSetup.drepLink.reading') : t('profileSetup.drepLink.useWallet')}
            </button>
          </div>
          {detectErr && <p className="text-[11.5px] text-[var(--danger)]">{detectErr}</p>}
          {link.isError && <p className="text-[11.5px] text-[var(--danger)]">{(link.error as Error)?.message}</p>}
        </>
      )}
    </div>
  );
}
