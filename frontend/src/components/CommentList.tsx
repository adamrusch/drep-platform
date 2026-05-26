import React, { useMemo, useState } from 'react';
import { Star, User, ChevronDown, ChevronRight, ArrowBigUp, ArrowBigDown, MessageSquare } from 'lucide-react';
import type { Comment, MyCommentVotes } from '@/types';
import { formatRelativeTime, formatWalletAddress, cn } from '@/lib/utils';
import { useAuthStore, useIsAuthenticated } from '@/stores/authStore';
import {
  useDeleteComment,
  useMyCommentVotes,
  useVoteComment,
} from '@/hooks/useComments';
import { useUiStore } from '@/stores/uiStore';
import { CommentForm } from './CommentForm';

interface CommentListProps {
  comments: Comment[];
  actionId: string;
  isLoading?: boolean;
}

/**
 * Format a signed lovelace BigInt-string into a compact "±X.XK ADA"
 * display. Used by the support-level row. Mirrors the style of
 * `formatAda` on the backend but keeps the sign and a few more
 * resolutions (we want "+0 ADA" for new comments with a tiny seed).
 */
function formatSupportAda(lovelaceStr: string | undefined): string {
  if (!lovelaceStr) return '0 ADA';
  let n: bigint;
  try {
    n = BigInt(lovelaceStr);
  } catch {
    return '0 ADA';
  }
  const sign = n < 0n ? '-' : '+';
  const abs = n < 0n ? -n : n;
  const ada = Number(abs / 1_000_000n);
  const adaFrac = Number(abs % 1_000_000n) / 1_000_000;
  const total = ada + adaFrac;
  if (total >= 1_000_000) {
    return `${sign}${(total / 1_000_000).toFixed(1).replace(/\.0$/, '')}M ADA`;
  }
  if (total >= 1_000) {
    return `${sign}${(total / 1_000).toFixed(1).replace(/\.0$/, '')}K ADA`;
  }
  return `${sign}${Math.round(total).toLocaleString()} ADA`;
}

/**
 * Header pill stack — design ref `governance.jsx:294–305`. Renders the
 * author identity + recognition / stake / DRep / DRep pills. Forward-
 * compatible: pills only render when their field is present.
 */
function CommentHeader({ comment }: { comment: Comment }): React.ReactElement {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-sm font-semibold text-[var(--text-primary)]">
        {comment.displayName ?? formatWalletAddress(comment.walletAddress)}
      </span>
      {comment.starred && (
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

interface CommentRowProps {
  comment: Comment;
  actionId: string;
  myVotes: MyCommentVotes;
  /** Compact variant for replies — tighter padding, no Reply affordance,
   *  no replies-toggle. Top-level comments pass `false`. */
  isReply: boolean;
  /** Replies of THIS comment (top-level only — replies receive []). */
  replies: Comment[];
  /** Caller's wallet address (for the "voting on own comment" gate
   *  and delete permission). */
  walletAddress: string | null;
  canDelete: (c: Comment) => boolean;
}

/**
 * One comment card — handles its own per-comment local state for the
 * reply form toggle and the replies-collapse toggle. Pulling these into
 * the parent would require a Map<commentId, openState> and a callback,
 * which is more plumbing than the actual state warrants.
 */
function CommentRow({
  comment,
  actionId,
  myVotes,
  isReply,
  replies,
  walletAddress,
  canDelete,
}: CommentRowProps): React.ReactElement {
  const [repliesOpen, setRepliesOpen] = useState(false);
  const [replyFormOpen, setReplyFormOpen] = useState(false);
  const isAuthenticated = useIsAuthenticated();
  const deleteComment = useDeleteComment();
  const voteComment = useVoteComment();
  const { addToast } = useUiStore();
  const isOwnComment = walletAddress === comment.walletAddress;
  const myVote = myVotes[comment.commentId];

  const handleVote = async (direction: 'up' | 'down'): Promise<void> => {
    if (!isAuthenticated) {
      addToast({ title: 'Connect your wallet to vote', variant: 'default' });
      return;
    }
    // Click the already-active direction = retract.
    const next = myVote === direction ? 'none' : direction;
    try {
      await voteComment.mutateAsync({
        actionId,
        commentId: comment.commentId,
        vote: next,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Vote failed';
      addToast({ title: 'Vote failed', description: msg, variant: 'error' });
    }
  };

  const replyCount = replies.length;
  const supportDisplay = formatSupportAda(comment.supportLovelace);
  // Positive total = green-tinted; negative = red-tinted; zero = neutral.
  const supportTone = comment.supportLovelace
    ? (() => {
        try {
          const n = BigInt(comment.supportLovelace);
          if (n > 0n) return 'positive';
          if (n < 0n) return 'negative';
          return 'neutral';
        } catch {
          return 'neutral';
        }
      })()
    : 'neutral';

  return (
    <div
      className={cn(
        'rounded-token-lg border border-[var(--border-default)] bg-[var(--bg-canvas)] p-4 shadow-token-sm',
        comment.isDRep &&
          'border-[var(--brand-primary)]/30 bg-[var(--brand-primary-soft)]/30',
        isReply && 'p-3',
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

      {/* Action row — vote buttons, support level, reply affordance,
          replies toggle. Two clusters: left = vote + support; right =
          reply controls. */}
      <div className="flex items-center gap-3 mt-3 flex-wrap">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void handleVote('up')}
            disabled={
              voteComment.isPending || isOwnComment || !isAuthenticated
            }
            title={
              isOwnComment
                ? "You can't vote on your own comment"
                : !isAuthenticated
                  ? 'Connect your wallet to vote'
                  : myVote === 'up'
                    ? 'Retract upvote'
                    : 'Upvote'
            }
            className={cn(
              'p-1 rounded-token-sm text-[var(--text-tertiary)] hover:text-[var(--success)]',
              'hover:bg-[var(--bg-muted)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
              myVote === 'up' && 'text-[var(--success)] bg-[var(--success-soft)]',
            )}
          >
            <ArrowBigUp size={18} strokeWidth={2} />
          </button>
          <span
            className={cn(
              'text-xs font-semibold tabular-nums px-1.5 min-w-[3rem] text-center',
              supportTone === 'positive' && 'text-[var(--success)]',
              supportTone === 'negative' && 'text-[var(--danger)]',
              supportTone === 'neutral' && 'text-[var(--text-tertiary)]',
            )}
            title={`Support Level: ${supportDisplay} (${comment.upvoteCount ?? 0} up, ${comment.downvoteCount ?? 0} down)`}
          >
            {supportDisplay}
          </span>
          <button
            type="button"
            onClick={() => void handleVote('down')}
            disabled={
              voteComment.isPending || isOwnComment || !isAuthenticated
            }
            title={
              isOwnComment
                ? "You can't vote on your own comment"
                : !isAuthenticated
                  ? 'Connect your wallet to vote'
                  : myVote === 'down'
                    ? 'Retract downvote'
                    : 'Downvote'
            }
            className={cn(
              'p-1 rounded-token-sm text-[var(--text-tertiary)] hover:text-[var(--danger)]',
              'hover:bg-[var(--bg-muted)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
              myVote === 'down' && 'text-[var(--danger)] bg-[var(--danger-soft)]',
            )}
          >
            <ArrowBigDown size={18} strokeWidth={2} />
          </button>
        </div>

        {/* Reply affordance — only on top-level comments. Authenticated
            check is on the button itself so the link is greyed-out
            rather than absent (consistent affordance for everyone). */}
        {!isReply && (
          <>
            <button
              type="button"
              onClick={() => {
                if (!isAuthenticated) {
                  addToast({
                    title: 'Connect your wallet to reply',
                    variant: 'default',
                  });
                  return;
                }
                setReplyFormOpen((x) => !x);
              }}
              className={cn(
                'inline-flex items-center gap-1 text-xs font-medium',
                'text-[var(--text-tertiary)] hover:text-[var(--brand-primary)]',
                'transition-colors',
              )}
              title={isAuthenticated ? 'Reply to this comment' : 'Connect to reply'}
            >
              <MessageSquare size={13} strokeWidth={2} />
              Reply
            </button>

            {/* Replies toggle — only renders when there ARE replies.
                Per spec: "When the count is 0, show a Reply link only,
                no replies section." */}
            {replyCount > 0 && (
              <button
                type="button"
                onClick={() => setRepliesOpen((x) => !x)}
                className={cn(
                  'inline-flex items-center gap-1 text-xs font-medium',
                  'text-[var(--text-tertiary)] hover:text-[var(--brand-primary)]',
                  'transition-colors',
                )}
                aria-expanded={repliesOpen}
              >
                {repliesOpen ? (
                  <ChevronDown size={13} strokeWidth={2} />
                ) : (
                  <ChevronRight size={13} strokeWidth={2} />
                )}
                {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
              </button>
            )}
          </>
        )}
      </div>

      {/* Inline reply form (top-level only). */}
      {!isReply && replyFormOpen && (
        <div className="mt-3 ml-4 border-l-2 border-[var(--border-default)] pl-3">
          <CommentForm
            actionId={actionId}
            parentCommentId={comment.commentId}
            onClose={() => setReplyFormOpen(false)}
          />
        </div>
      )}

      {/* Replies (top-level only, expanded). Indented under the parent. */}
      {!isReply && repliesOpen && replyCount > 0 && (
        <div className="mt-3 ml-4 border-l-2 border-[var(--border-default)] pl-3 space-y-2">
          {replies.map((r) => (
            <CommentRow
              key={r.commentId}
              comment={r}
              actionId={actionId}
              myVotes={myVotes}
              isReply
              replies={[]}
              walletAddress={walletAddress}
              canDelete={canDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function CommentList({
  comments,
  actionId,
  isLoading,
}: CommentListProps): React.ReactElement {
  const { walletAddress, roles } = useAuthStore();
  const { data: myVotesData } = useMyCommentVotes(actionId);
  const myVotes = myVotesData?.votes ?? {};

  const canDelete = (comment: Comment): boolean => {
    return comment.walletAddress === walletAddress || roles.includes('lead_drep');
  };

  // Partition into top-level + replies. The list endpoint returns them
  // mixed (sorted newest-first by SK = commentId = ULID), so we walk
  // once and bucket them.
  const { topLevel, repliesByParent } = useMemo(() => {
    const topLevel: Comment[] = [];
    const repliesByParent = new Map<string, Comment[]>();
    for (const c of comments) {
      if (c.parentCommentId) {
        const bucket = repliesByParent.get(c.parentCommentId) ?? [];
        bucket.push(c);
        repliesByParent.set(c.parentCommentId, bucket);
      } else {
        topLevel.push(c);
      }
    }
    // Replies render oldest-first under their parent (natural read
    // order). Top-level stays newest-first as the API returned them.
    for (const [k, v] of repliesByParent) {
      v.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      repliesByParent.set(k, v);
    }
    return { topLevel, repliesByParent };
  }, [comments]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-token-lg bg-[var(--bg-muted)] h-16 animate-pulse" />
        ))}
      </div>
    );
  }

  if (topLevel.length === 0) {
    return (
      <div className="text-center py-8 text-[var(--text-tertiary)] text-sm">
        No comments yet. Be the first to share your perspective.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {topLevel.map((comment) => (
        <CommentRow
          key={comment.commentId}
          comment={comment}
          actionId={actionId}
          myVotes={myVotes}
          isReply={false}
          replies={repliesByParent.get(comment.commentId) ?? []}
          walletAddress={walletAddress}
          canDelete={canDelete}
        />
      ))}
    </div>
  );
}
