import React from 'react';
import type { Comment } from '@/types';
import { formatRelativeTime, formatWalletAddress, cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';
import { useDeleteComment } from '@/hooks/useComments';

interface CommentListProps {
  comments: Comment[];
  actionId: string;
  isLoading?: boolean;
}

export function CommentList({ comments, actionId, isLoading }: CommentListProps): React.ReactElement {
  const { walletAddress, roles } = useAuthStore();
  const deleteComment = useDeleteComment();

  const canDelete = (comment: Comment): boolean => {
    return comment.walletAddress === walletAddress || roles.includes('lead_drep');
  };

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-md bg-muted h-16 animate-pulse" />
        ))}
      </div>
    );
  }

  if (comments.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground text-sm">
        No comments yet. Be the first to share your perspective.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {comments.map((comment) => (
        <div
          key={comment.commentId}
          className={cn(
            'rounded-token-lg border border-[var(--border-default)] bg-[var(--bg-canvas)] p-4 shadow-token-sm',
            comment.isDRep &&
              'border-[var(--brand-primary)]/30 bg-[var(--brand-primary-soft)]/30',
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-[var(--text-primary)]">
                {comment.displayName ?? formatWalletAddress(comment.walletAddress)}
              </span>
              {comment.isDRep && (
                <span className="text-[11.5px] font-semibold bg-[var(--brand-primary-soft)] text-[var(--brand-primary)] px-2 py-0.5 rounded-token-full">
                  DRep
                </span>
              )}
              {!comment.isPublic && (
                <span className="text-[11.5px] font-semibold bg-[var(--bg-muted)] text-[var(--text-secondary)] px-2 py-0.5 rounded-token-full">
                  Members only
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-[var(--text-tertiary)]">
                {formatRelativeTime(comment.createdAt)}
              </span>
              {canDelete(comment) && (
                <button
                  onClick={() =>
                    void deleteComment.mutate({
                      actionId,
                      commentId: comment.commentId,
                    })
                  }
                  disabled={deleteComment.isPending}
                  className="text-xs text-[var(--danger)] hover:underline disabled:opacity-50"
                >
                  Delete
                </button>
              )}
            </div>
          </div>
          <p className="text-sm mt-2 text-[var(--text-secondary)] whitespace-pre-wrap leading-relaxed">
            {comment.body}
          </p>
        </div>
      ))}
    </div>
  );
}
