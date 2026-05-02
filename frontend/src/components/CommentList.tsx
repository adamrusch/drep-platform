import React from 'react';
import { Star, User } from 'lucide-react';
import type { Comment } from '@/types';
import { formatRelativeTime, formatWalletAddress, cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';
import { useDeleteComment } from '@/hooks/useComments';

interface CommentListProps {
  comments: Comment[];
  actionId: string;
  isLoading?: boolean;
}

/**
 * Comment header pill stack — design ref `governance.jsx:294–305`:
 *   <name>  ⭐ Recognized  · 5.2M ₳ stake · 👤 delegates to X · time
 *
 * The data fields (`starred`, `stakeAda`, `drep`) are optional on the
 * Comment type — the backend doesn't populate them yet. The pills only
 * render when the corresponding field is present, so this component is
 * forward-compatible: once the sync layer fills the fields, the design
 * pattern materializes without further frontend changes.
 */
function CommentHeader({ comment }: { comment: Comment }): React.ReactElement {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-sm font-semibold text-[var(--text-primary)]">
        {comment.displayName ?? formatWalletAddress(comment.walletAddress)}
      </span>
      {comment.starred && (
        // .gold-star pill — see styles.css:658–679. We hand-roll the colors
        // here against the gold tokens the design uses (warning is amber,
        // close enough for a recognized badge).
        <span
          className="inline-flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-token-full bg-[rgba(245,158,11,0.12)] text-[var(--warning)]"
          title={`Recognized${comment.drep ? ` by ${comment.drep}` : ''}`}
        >
          <Star size={11} strokeWidth={2.4} />
          Recognized
        </span>
      )}
      {comment.stakeAda && (
        <span className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-token-full bg-[var(--bg-muted)] text-[var(--text-secondary)] tabular-nums">
          {comment.stakeAda} stake
        </span>
      )}
      {comment.drep && (
        <span
          className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-token-full bg-[var(--brand-primary-soft)] text-[var(--brand-primary)]"
          title="Delegates to"
        >
          <User size={10} strokeWidth={2.4} />
          {comment.drep}
        </span>
      )}
      {comment.isDRep && !comment.drep && (
        <span className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-token-full bg-[var(--brand-primary-soft)] text-[var(--brand-primary)]">
          DRep
        </span>
      )}
      {!comment.isPublic && (
        <span className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-token-full bg-[var(--bg-muted)] text-[var(--text-secondary)]">
          Members only
        </span>
      )}
    </div>
  );
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
          <div key={i} className="rounded-token-lg bg-[var(--bg-muted)] h-16 animate-pulse" />
        ))}
      </div>
    );
  }

  if (comments.length === 0) {
    return (
      <div className="text-center py-8 text-[var(--text-tertiary)] text-sm">
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
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <CommentHeader comment={comment} />
            <div className="flex items-center gap-2 flex-shrink-0">
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
