import React from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';
import { useClubhousePosts } from '@/hooks/useClubhouse';
import type { DRepCommittee } from '@/types';
import { formatRelativeTime } from '@/lib/utils';

export function DRepPublicProfile(): React.ReactElement {
  const { drepId } = useParams<{ drepId: string }>();

  const { data: drep, isLoading } = useQuery({
    queryKey: ['drep', drepId],
    queryFn: () => get<DRepCommittee>(`/drep/${encodeURIComponent(drepId ?? '')}`),
    enabled: Boolean(drepId),
  });

  const { data: postsData } = useClubhousePosts(drepId ?? '');

  if (isLoading) {
    return (
      <div className="max-w-3xl mx-auto space-y-4 animate-pulse">
        <div className="h-32 bg-muted rounded" />
      </div>
    );
  }

  if (!drep) {
    return (
      <div className="text-center py-16">
        <h2 className="text-xl font-semibold mb-2">DRep not found</h2>
        <Link to="/drep" className="text-primary hover:underline text-sm">
          Browse DReps
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-2xl font-bold mb-1">{drep.committeeName}</h1>
        <p className="text-sm text-muted-foreground mb-4">{drep.description}</p>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span>{drep.members.length} member{drep.members.length !== 1 ? 's' : ''}</span>
          <span>Active since {formatRelativeTime(drep.createdAt)}</span>
        </div>
      </div>

      {/* Members */}
      <div className="rounded-lg border border-border bg-card p-4">
        <h2 className="font-semibold mb-3">Committee Members</h2>
        <div className="space-y-2">
          {drep.members.map((member) => (
            <Link
              key={member.walletAddress}
              to={`/profile/${member.walletAddress}`}
              className="flex items-center justify-between py-2 px-3 rounded hover:bg-muted transition-colors"
            >
              <div>
                <div className="text-sm font-medium">
                  {member.displayName ?? `${member.walletAddress.slice(0, 12)}…`}
                </div>
                <div className="text-xs text-muted-foreground">{member.role}</div>
              </div>
              <span className="text-xs text-muted-foreground">
                Joined {formatRelativeTime(member.joinedAt)}
              </span>
            </Link>
          ))}
        </div>
      </div>

      {/* Recent clubhouse posts */}
      {postsData && postsData.items.length > 0 && (
        <div className="space-y-3">
          <h2 className="font-semibold">Recent Updates</h2>
          {postsData.items.slice(0, 3).map((post) => (
            <div key={post.postId} className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">
                  {post.authorDisplayName ?? `${post.authorWallet.slice(0, 8)}…`}
                </span>
                <span className="text-xs text-muted-foreground">
                  {formatRelativeTime(post.createdAt)}
                </span>
              </div>
              <p className="text-sm text-foreground/90 line-clamp-3">{post.body}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
