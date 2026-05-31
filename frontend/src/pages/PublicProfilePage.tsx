import React, { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';
import { formatRelativeTime, formatWalletAddress } from '@/lib/utils';
import { useDelegationHistory } from '@/hooks/useDelegationHistory';
import type { UserProfile, DelegationRecord } from '@/types';

/**
 * Public profile page for any wallet address.
 * Shows: avatar, display name, truncated wallet address, bio, social links, delegation history.
 */
export function PublicProfilePage(): React.ReactElement {
  const { walletAddress } = useParams<{ walletAddress: string }>();

  const { data: profile, isLoading, error } = useQuery({
    queryKey: ['profile', walletAddress],
    queryFn: () => get<UserProfile>(`/profile/${encodeURIComponent(walletAddress ?? '')}`),
    enabled: Boolean(walletAddress),
  });

  if (isLoading) {
    return (
      <div className="max-w-3xl mx-auto space-y-4 animate-pulse">
        <div className="h-32 bg-muted rounded-lg" />
        <div className="h-48 bg-muted rounded-lg" />
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="text-center py-16">
        <h2 className="text-xl font-semibold mb-2">Profile not found</h2>
        <p className="text-sm text-muted-foreground mb-4">
          No public profile exists for{' '}
          <span className="font-mono">{walletAddress ? formatWalletAddress(walletAddress) : ''}</span>
        </p>
        <Link to="/" className="text-primary hover:underline text-sm">
          Back to home
        </Link>
      </div>
    );
  }

  const initials =
    profile.displayName
      ?.split(' ')
      .map((p) => p[0])
      .slice(0, 2)
      .join('')
      .toUpperCase() ?? '??';

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header card */}
      <section className="card">
        <div className="card__body" style={{ display: 'flex', gap: 'var(--s-5)', alignItems: 'flex-start' }}>
          <span className="avatar avatar--lg" style={{ background: '#0033AD', color: '#FFFFFF' }}>
            {initials}
          </span>
          <div style={{ flex: 1 }}>
            <h1 className="text-2xl font-bold">
              {profile.resolvedDisplayName ?? profile.displayName ?? formatWalletAddress(profile.walletAddress)}
            </h1>
            <p className="text-sm text-muted-foreground font-mono">
              {formatWalletAddress(profile.walletAddress, 12)}
            </p>
            {profile.isDRep && profile.drepId && (
              <Link
                to={`/dreps/${encodeURIComponent(profile.drepId)}`}
                className="mt-1 inline-flex items-center gap-1.5 text-[13px] font-semibold text-[var(--brand-primary)] hover:underline"
              >
                <span className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-token-full bg-[var(--brand-primary-soft)]">DRep</span>
                Registered DRep{profile.drepName ? ` — ${profile.drepName}` : ''} →
              </Link>
            )}
            {profile.roles.length > 0 && (
              <div className="flex gap-2 mt-2">
                {profile.roles.map((role) => (
                  <span
                    key={role}
                    className="pill"
                    style={{ fontSize: 12 }}
                  >
                    {role.replace(/_/g, ' ')}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Bio */}
      {profile.bio && (
        <section className="card">
          <div className="card__header">
            <h2 className="card__title">About</h2>
          </div>
          <div className="card__body">
            <p className="text-sm whitespace-pre-wrap">{profile.bio}</p>
          </div>
        </section>
      )}

      {/* Social links */}
      {profile.socialLinks && Object.values(profile.socialLinks).some(Boolean) && (
        <section className="card">
          <div className="card__header">
            <h2 className="card__title">Links</h2>
          </div>
          <div className="card__body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
            {profile.socialLinks.twitter && (
              <a
                href={`https://twitter.com/${profile.socialLinks.twitter.replace(/^@/, '')}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-primary hover:underline"
              >
                Twitter / X: {profile.socialLinks.twitter}
              </a>
            )}
            {profile.socialLinks.github && (
              <a
                href={`https://github.com/${profile.socialLinks.github}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-primary hover:underline"
              >
                GitHub: {profile.socialLinks.github}
              </a>
            )}
            {profile.socialLinks.website && (
              <a
                href={profile.socialLinks.website}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-primary hover:underline"
              >
                Website: {profile.socialLinks.website}
              </a>
            )}
            {profile.socialLinks.discord && (
              <span className="text-sm">Discord: {profile.socialLinks.discord}</span>
            )}
          </div>
        </section>
      )}

      {/* Delegation history — lazy-loaded via /profile/{wallet}/delegation-history.
       *  Renders the live on-chain delegation (currentDrepId) above the stored
       *  history list. The disclosure stays collapsed by default; the query
       *  only fires when expanded. */}
      <DelegationHistorySection walletAddress={profile.walletAddress} />
    </div>
  );
}

/** Lazy-loaded delegation-history disclosure. Defers the network call until
 *  the user expands the `<details>` so the public profile stays cheap. */
function DelegationHistorySection({
  walletAddress,
}: {
  walletAddress: string;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const { data, isLoading, isError, error } = useDelegationHistory(walletAddress, {
    enabled: open,
  });

  const records: DelegationRecord[] = React.useMemo(() => {
    if (!data?.delegationHistory) return [];
    // Sort newest-first by delegatedAt; tolerate missing/invalid dates by
    // pushing them to the end deterministically.
    return [...data.delegationHistory].sort((a, b) => {
      const ta = Date.parse(a.delegatedAt);
      const tb = Date.parse(b.delegatedAt);
      if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
      if (Number.isNaN(ta)) return 1;
      if (Number.isNaN(tb)) return -1;
      return tb - ta;
    });
  }, [data]);

  return (
    <section className="card">
      <details
        open={open}
        onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary
          className="card__header"
          style={{ cursor: 'pointer', listStyle: 'none' }}
        >
          <h2 className="card__title">Delegation history</h2>
          <span
            aria-hidden
            className="text-xs"
            style={{ color: 'var(--text-secondary)' }}
          >
            {open ? 'Hide' : 'Show'}
          </span>
        </summary>
        <div className="card__body">
          {isLoading && (
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Loading delegation history…
            </p>
          )}
          {isError && (
            <p className="text-sm" style={{ color: 'var(--danger)' }}>
              Could not load delegation history.
              {(error as { message?: string } | null)?.message
                ? ` ${(error as { message?: string }).message}`
                : ''}
            </p>
          )}
          {!isLoading && !isError && data && (
            <>
              {/* Live on-chain delegation — distinct from the stored history. */}
              <p
                className="text-sm"
                style={{
                  marginBottom: 'var(--s-3)',
                  color: 'var(--text-primary)',
                }}
              >
                {data.currentDrepId ? (
                  <>
                    Currently delegating to:{' '}
                    <Link
                      to={`/drep/${encodeURIComponent(data.currentDrepId)}`}
                      className="font-mono hover:underline"
                      style={{ color: 'var(--brand-primary)' }}
                    >
                      {formatWalletAddress(data.currentDrepId, 10)}
                    </Link>
                  </>
                ) : (
                  <span style={{ color: 'var(--text-secondary)' }}>
                    No current delegation found.
                  </span>
                )}
              </p>
              {records.length === 0 ? (
                <p
                  className="text-sm"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  No prior delegation records.
                </p>
              ) : (
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {records.map((record, idx) => (
                    <li
                      key={`${record.drepId}-${record.epochStart}-${idx}`}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: 'var(--s-3) 0',
                        borderBottom:
                          idx < records.length - 1
                            ? '1px solid var(--border-subtle)'
                            : 'none',
                      }}
                    >
                      <div>
                        <Link
                          to={`/drep/${encodeURIComponent(record.drepId)}`}
                          className="text-sm font-medium hover:underline"
                        >
                          {record.drepName ?? formatWalletAddress(record.drepId, 10)}
                        </Link>
                        <div className="text-xs text-muted-foreground">
                          Epoch {record.epochStart}
                          {record.epochEnd ? ` – ${record.epochEnd}` : ' – present'}
                        </div>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {formatRelativeTime(record.delegatedAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </details>
    </section>
  );
}
