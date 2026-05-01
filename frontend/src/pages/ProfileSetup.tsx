import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { post } from '@/lib/api';
import { useMe } from '@/hooks/useAuth';
import { useAuthStore } from '@/stores/authStore';
import { useUiStore } from '@/stores/uiStore';
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
    </div>
  );
}
