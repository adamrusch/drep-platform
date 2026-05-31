import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { post } from '@/lib/api';
import { useMe } from '@/hooks/useAuth';
import { useAuthStore } from '@/stores/authStore';
import { useUiStore } from '@/stores/uiStore';
import { useLinkDrep } from '@/hooks/useCommitteeMembership';
import type { UserProfile } from '@/types';

export function ProfileSetup(): React.ReactElement {
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
      addToast({ title: 'Profile saved', variant: 'success' });
      void navigate('/');
    },
    onError: () => {
      addToast({ title: 'Failed to save profile', variant: 'error' });
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
        {profile?.displayName ? 'Edit Profile' : 'Set Up Your Profile'}
      </h1>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Display Name</label>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={100}
            placeholder="Your public display name"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Bio</label>
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            maxLength={2_000}
            rows={4}
            placeholder="Tell the community about yourself…"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
          />
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-medium">Social Links (optional)</h3>
          {[
            { label: 'Twitter / X', value: twitter, setter: setTwitter, placeholder: '@handle' },
            { label: 'GitHub', value: github, setter: setGithub, placeholder: 'username' },
            { label: 'Website', value: website, setter: setWebsite, placeholder: 'https://…' },
          ].map(({ label, value, setter, placeholder }) => (
            <div key={label}>
              <label className="block text-xs text-muted-foreground mb-1">{label}</label>
              <input
                value={value}
                onChange={(e) => setter(e.target.value)}
                placeholder={placeholder}
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
          {upsertProfile.isPending ? 'Saving…' : 'Save Profile'}
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
      if (!connector) throw new Error('Reconnect your wallet first.');
      const api = await connector.enable({ extensions: [{ cip: 95 }] });
      const key = await api?.cip95?.getPubDRepKey?.();
      if (!key) throw new Error('This wallet did not return a DRep key (CIP-95 not supported?). Paste your drep id instead.');
      link.mutate({ drepKey: key }, { onSuccess: (r) => setLinked(r) });
    } catch (e) {
      setDetectErr((e as Error)?.message ?? 'Could not read your DRep key.');
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
      <h3 className="text-sm font-medium">Are you a DRep?</h3>
      {active ? (
        <p className="text-[13px] text-[var(--text-secondary)]">
          ✓ Linked to your DRep{linked?.drepName ? ` — ${linked.drepName}` : ''}. You're recognized as a DRep across the platform.
        </p>
      ) : (
        <>
          <p className="text-[12.5px] text-[var(--text-secondary)]">
            Link your registered DRep to be recognized as one (no committee needed). Your name defaults to your DRep name unless you set one above.
          </p>
          <div className="flex flex-wrap gap-2">
            <input
              value={drepId}
              onChange={(e) => setDrepId(e.target.value)}
              placeholder="drep1…"
              className="flex-1 min-w-[220px] rounded-md border border-[var(--border-default)] bg-[var(--bg-canvas)] px-3 py-1.5 text-[12.5px] font-mono"
            />
            <button
              type="button"
              disabled={!/^drep1[0-9a-z]{10,}$/.test(drepId.trim()) || link.isPending}
              onClick={linkPasted}
              className="rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-[12.5px] font-medium disabled:opacity-50"
            >
              {link.isPending ? 'Linking…' : 'Link'}
            </button>
            <button
              type="button"
              disabled={detecting || link.isPending}
              onClick={() => void detectAndLink()}
              className="rounded-md border border-[var(--border-default)] px-3 py-1.5 text-[12.5px] font-medium disabled:opacity-50"
            >
              {detecting ? 'Reading…' : 'Use wallet (CIP-95)'}
            </button>
          </div>
          {detectErr && <p className="text-[11.5px] text-[var(--danger)]">{detectErr}</p>}
          {link.isError && <p className="text-[11.5px] text-[var(--danger)]">{(link.error as Error)?.message}</p>}
        </>
      )}
    </div>
  );
}
