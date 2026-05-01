import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  useClubhousePosts,
  useCreateClubhousePost,
  useCreateClubhouseComment,
  useDeleteClubhousePost,
} from '@/hooks/useClubhouse';
import { useAuthStore } from '@/stores/authStore';
import { formatRelativeTime, formatWalletAddress } from '@/lib/utils';
import type { ClubhousePost } from '@/types';

export function DelegatorClubhouse(): React.ReactElement {
  const { drepId } = useParams<{ drepId: string }>();
  const { data, isLoading } = useClubhousePosts(drepId ?? '');
  const { walletAddress, roles } = useAuthStore();
  const createPost = useCreateClubhousePost();
  const deletePost = useDeleteClubhousePost();
  const [newPostBody, setNewPostBody] = useState('');

  const handleCreatePost = async (): Promise<void> => {
    if (!newPostBody.trim() || !drepId) return;
    await createPost.mutateAsync({ drepId, body: newPostBody.trim() });
    setNewPostBody('');
  };

  if (isLoading) {
    return <div className="space-y-4 animate-pulse">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-24 bg-muted rounded-lg" />)}</div>;
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Delegator Clubhouse</h1>
      </div>

      {/* New post form */}
      {walletAddress && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <textarea
            value={newPostBody}
            onChange={(e) => setNewPostBody(e.target.value)}
            placeholder="Share an update with your delegators…"
            rows={3}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
          />
          <div className="flex justify-end">
            <button
              onClick={() => void handleCreatePost()}
              disabled={createPost.isPending || !newPostBody.trim()}
              className="rounded-md bg-primary text-primary-foreground px-4 py-1.5 text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {createPost.isPending ? 'Posting…' : 'Post'}
            </button>
          </div>
        </div>
      )}

      {/* Posts */}
      <div className="space-y-4">
        {(data?.items ?? []).map((post) => (
          <PostCard
            key={post.postId}
            post={post}
            drepId={drepId ?? ''}
            currentWallet={walletAddress}
            isLeadDRep={roles.includes('lead_drep')}
            onDelete={() => void deletePost.mutate({ drepId: drepId ?? '', postId: post.postId })}
          />
        ))}
        {data?.items.length === 0 && (
          <div className="text-center py-12 text-muted-foreground text-sm">
            No posts yet.
          </div>
        )}
      </div>
    </div>
  );
}

interface PostCardProps {
  post: ClubhousePost;
  drepId: string;
  currentWallet: string | null;
  isLeadDRep: boolean;
  onDelete: () => void;
}

function PostCard({ post, drepId, currentWallet, isLeadDRep, onDelete }: PostCardProps): React.ReactElement {
  const [commentBody, setCommentBody] = useState('');
  const [showComments, setShowComments] = useState(false);
  const createComment = useCreateClubhouseComment();

  const canDelete = post.authorWallet === currentWallet || isLeadDRep;

  const handleAddComment = async (): Promise<void> => {
    if (!commentBody.trim()) return;
    await createComment.mutateAsync({ drepId, postId: post.postId, body: commentBody.trim() });
    setCommentBody('');
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-start justify-between">
        <div>
          <span className="text-sm font-medium">
            {post.authorDisplayName ?? formatWalletAddress(post.authorWallet)}
          </span>
          {post.isDRepPost && (
            <span className="ml-2 text-xs bg-cardano-blue text-white px-1.5 py-0.5 rounded-full">DRep</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{formatRelativeTime(post.createdAt)}</span>
          {canDelete && (
            <button onClick={onDelete} className="text-xs text-destructive hover:underline">Delete</button>
          )}
        </div>
      </div>

      <p className="text-sm text-foreground/90 whitespace-pre-wrap">{post.body}</p>

      <button
        onClick={() => setShowComments(!showComments)}
        className="text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {post.comments.length} comment{post.comments.length !== 1 ? 's' : ''}
      </button>

      {showComments && (
        <div className="space-y-2 pt-2 border-t border-border">
          {post.comments.map((c) => (
            <div key={c.commentId} className="text-sm">
              <span className="font-medium mr-2">
                {c.authorDisplayName ?? formatWalletAddress(c.authorWallet)}
              </span>
              {c.body}
            </div>
          ))}
          {currentWallet && (
            <div className="flex gap-2 pt-1">
              <input
                value={commentBody}
                onChange={(e) => setCommentBody(e.target.value)}
                placeholder="Add a comment…"
                className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <button
                onClick={() => void handleAddComment()}
                disabled={!commentBody.trim() || createComment.isPending}
                className="rounded-md bg-primary text-primary-foreground px-3 py-1 text-xs font-medium hover:bg-primary/90 disabled:opacity-50"
              >
                Reply
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
