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
            'rounded-md border border-border bg-card p-3',
            comment.isDRep && 'border-cardano-blue/30 bg-blue-50/30',
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">
                {comment.displayName ?? formatWalletAddress(comment.walletAddress)}
              </span>
              {comment.isDRep && (
                <span className="text-xs bg-cardano-blue text-white px-1.5 py-0.5 rounded-full font-medium">
                  DRep
                </span>
              )}
              {!comment.isPublic && (
                <span className="text-xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded-full">
                  Members only
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
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
                  className="text-xs text-destructive hover:underline disabled:opacity-50"
                >
                  Delete
                </button>
              )}
            </div>
          </div>
          <p className="text-sm mt-2 text-foreground/90 whitespace-pre-wrap">{comment.body}</p>
        </div>
      ))}
    </div>
  );
}
