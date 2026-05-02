import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Check, MessageSquare, Lock } from 'lucide-react';
import {
  useClubhousePosts,
  useCreateClubhouseComment,
  useDeleteClubhousePost,
  useVotePoll,
} from '@/hooks/useClubhouse';
import { useAuthStore } from '@/stores/authStore';
import { formatRelativeTime, formatWalletAddress, cn } from '@/lib/utils';
import { Composer } from '@/components/clubhouse/Composer';
import { ClubhouseRail } from '@/components/rails/ClubhouseRail';
import { PageWithRail } from '@/components/Layout';
import { Button } from '@/components/ui/Button';
import type { ClubhousePost, ClubhousePollOption } from '@/types';

/**
 * Delegator Clubhouse — the README's hero flow.
 *
 * Renders:
 *  - Hero band (private-to-delegators chrome)
 *  - Composer (Discussion / Question / Poll, full poll editor)
 *  - Post stream with poll bars + threading + replies
 *  - Right rail with active threads + top contributors
 *
 * Reference: `clubhouse.jsx:79–84, 178–215, 276–297`.
 */
export function DelegatorClubhouse(): React.ReactElement {
  const { drepId } = useParams<{ drepId: string }>();
  const { data, isLoading } = useClubhousePosts(drepId ?? '');
  const { walletAddress, roles } = useAuthStore();
  const deletePost = useDeleteClubhousePost();
  const canPost =
    roles.includes('lead_drep') ||
    roles.includes('committee_member') ||
    roles.includes('trusted_delegator');

  const center = (
    <>
      <div
        className="relative overflow-hidden rounded-token-2xl border border-[var(--border-default)] p-6 sm:p-8"
        style={{ background: 'var(--bg-hero)' }}
      >
        <h1 className="m-0 text-[24px] font-bold tracking-tight text-[var(--text-primary)] flex items-center gap-3 flex-wrap">
          Delegator Clubhouse
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider px-2 py-1 rounded-token-full bg-[var(--bg-subtle)] text-[var(--text-secondary)]">
            <Lock size={11} strokeWidth={2.4} />
            Private to delegators
          </span>
        </h1>
        <p className="text-[13.5px] text-[var(--text-secondary)] max-w-[640px] mt-1.5 leading-relaxed">
          A space for delegators to ask questions, share ideas, and help shape Cardano
          governance together with their DRep.
        </p>
      </div>

      {/* Composer — only members of this clubhouse can post */}
      {drepId && canPost && <Composer drepId={drepId} />}
      {drepId && !canPost && (
        <div className="rounded-token-xl border border-dashed border-[var(--border-default)] bg-[var(--bg-subtle)] p-4 text-[13px] text-[var(--text-tertiary)] text-center">
          Connect a wallet that delegates to this DRep to post in the clubhouse.
        </div>
      )}

      {/* Post stream */}
      <div className="flex flex-col gap-4">
        {isLoading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="h-32 rounded-token-xl bg-[var(--bg-muted)] animate-pulse"
            />
          ))
        ) : (data?.items.length ?? 0) === 0 ? (
          <div className="text-center py-12 text-sm text-[var(--text-tertiary)] rounded-token-xl border border-[var(--border-default)] bg-[var(--bg-canvas)]">
            No posts yet. Be the first to start the conversation.
          </div>
        ) : (
          (data?.items ?? []).map((post) => (
            <PostCard
              key={post.postId}
              post={post}
              drepId={drepId ?? ''}
              currentWallet={walletAddress}
              isLeadDRep={roles.includes('lead_drep')}
              onDelete={() =>
                void deletePost.mutate({ drepId: drepId ?? '', postId: post.postId })
              }
            />
          ))
        )}
      </div>
    </>
  );

  return <PageWithRail rail={<ClubhouseRail />}>{center}</PageWithRail>;
}

interface PostCardProps {
  post: ClubhousePost;
  drepId: string;
  currentWallet: string | null;
  isLeadDRep: boolean;
  onDelete: () => void;
}

function PostCard({
  post,
  drepId,
  currentWallet,
  isLeadDRep,
  onDelete,
}: PostCardProps): React.ReactElement {
  const [commentBody, setCommentBody] = useState('');
  const [showComments, setShowComments] = useState(false);
  const createComment = useCreateClubhouseComment();
  const votePoll = useVotePoll();

  const canDelete = post.authorWallet === currentWallet || isLeadDRep;
  const myVote = currentWallet ? post.pollVotes?.[currentWallet] : undefined;
  const pollClosed =
    post.pollClosesAt && Date.parse(post.pollClosesAt) < Date.now();

  const handleAddComment = async (): Promise<void> => {
    if (!commentBody.trim()) return;
    await createComment.mutateAsync({ drepId, postId: post.postId, body: commentBody.trim() });
    setCommentBody('');
  };

  const handleVote = (i: number): void => {
    if (pollClosed) return;
    votePoll.mutate({ drepId, postId: post.postId, optionIndex: i });
  };

  return (
    <article className="rounded-token-xl border border-[var(--border-default)] bg-[var(--bg-canvas)] p-5 shadow-token-sm space-y-3">
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <span className="w-8 h-8 rounded-token-full bg-[var(--brand-primary-soft)] text-[var(--brand-primary)] flex items-center justify-center text-[11px] font-semibold flex-shrink-0">
            {(post.authorDisplayName ?? post.authorWallet).slice(0, 2).toUpperCase()}
          </span>
          <span className="text-sm font-semibold text-[var(--text-primary)]">
            {post.authorDisplayName ?? formatWalletAddress(post.authorWallet)}
          </span>
          {post.isDRepPost && (
            <span className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-token-full bg-[var(--brand-primary-soft)] text-[var(--brand-primary)]">
              DRep
            </span>
          )}
          {post.stakeAda && (
            <span className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-token-full bg-[var(--bg-muted)] text-[var(--text-secondary)] tabular-nums">
              {post.stakeAda} stake
            </span>
          )}
          {post.type === 'poll' && (
            <span className="inline-flex items-center text-[10.5px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-token-full bg-[var(--brand-accent-soft)] text-[var(--brand-accent)]">
              Poll
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-xs text-[var(--text-tertiary)]">
            {formatRelativeTime(post.createdAt)}
          </span>
          {canDelete && (
            <button
              onClick={onDelete}
              className="text-xs text-[var(--danger)] hover:underline"
            >
              Delete
            </button>
          )}
        </div>
      </header>

      {post.title && (
        <h3 className="text-[15px] font-semibold text-[var(--text-primary)] leading-snug">
          {post.title}
        </h3>
      )}

      <p className="text-sm text-[var(--text-secondary)] whitespace-pre-wrap leading-relaxed">
        {post.body}
      </p>

      {/* Poll bars */}
      {post.type === 'poll' && post.pollOptions && (
        <PollBars
          options={post.pollOptions}
          myVote={myVote}
          closed={Boolean(pollClosed)}
          onVote={handleVote}
          closesAt={post.pollClosesAt}
        />
      )}

      <div className="flex items-center gap-4 pt-1 text-[12.5px] text-[var(--text-tertiary)]">
        <button
          onClick={() => setShowComments(!showComments)}
          className="inline-flex items-center gap-1.5 hover:text-[var(--text-primary)] transition-colors"
        >
          <MessageSquare size={13} strokeWidth={2} />
          {post.comments.length} {post.comments.length === 1 ? 'reply' : 'replies'}
        </button>
      </div>

      {showComments && (
        <div className="border-l-2 border-[var(--border-subtle)] ml-2 pl-4 space-y-3 pt-2">
          {post.comments.map((c) => (
            <div key={c.commentId} className="flex items-start gap-2.5">
              <span className="w-6 h-6 rounded-token-full bg-[var(--bg-muted)] text-[var(--text-secondary)] flex items-center justify-center text-[10px] font-semibold flex-shrink-0 mt-0.5">
                {(c.authorDisplayName ?? c.authorWallet).slice(0, 2).toUpperCase()}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[12.5px] font-semibold text-[var(--text-primary)]">
                    {c.authorDisplayName ?? formatWalletAddress(c.authorWallet)}
                  </span>
                  <span className="text-[11px] text-[var(--text-tertiary)]">
                    {formatRelativeTime(c.createdAt)}
                  </span>
                </div>
                <p className="text-[13px] text-[var(--text-secondary)] whitespace-pre-wrap leading-relaxed mt-0.5">
                  {c.body}
                </p>
              </div>
            </div>
          ))}
          {currentWallet && (
            <div className="flex items-start gap-2 pt-1">
              <textarea
                value={commentBody}
                onChange={(e) => setCommentBody(e.target.value)}
                placeholder="Write a reply…"
                rows={2}
                className="flex-1 rounded-token-md border border-[var(--border-default)] bg-[var(--bg-canvas)] px-3 py-1.5 text-[12.5px] resize-y focus:outline-none focus-visible:shadow-token-focus"
              />
              <Button
                size="sm"
                variant="primary"
                onClick={() => void handleAddComment()}
                disabled={!commentBody.trim() || createComment.isPending}
              >
                Reply
              </Button>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

interface PollBarsProps {
  options: ClubhousePollOption[];
  myVote?: number;
  closed: boolean;
  onVote: (i: number) => void;
  closesAt?: string;
}

function PollBars({ options, myVote, closed, onVote, closesAt }: PollBarsProps): React.ReactElement {
  const total = options.reduce((s, o) => s + o.votes, 0);
  return (
    <div className="space-y-2 pt-1">
      {options.map((opt, i) => {
        const pct = total > 0 ? Math.round((opt.votes / total) * 100) : 0;
        const mine = myVote === i;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onVote(i)}
            disabled={closed}
            aria-pressed={mine}
            className={cn(
              'relative w-full text-left px-3.5 py-2.5 rounded-token-md border bg-[var(--bg-canvas)]',
              'overflow-hidden transition-all duration-150 disabled:cursor-not-allowed',
              mine
                ? 'border-[var(--brand-primary)]'
                : 'border-[var(--border-default)] hover:border-[var(--border-strong)]',
            )}
          >
            <span
              className="absolute inset-y-0 left-0 transition-[width] duration-500"
              style={{
                width: `${pct}%`,
                background: mine ? 'var(--brand-primary-soft)' : 'var(--bg-muted)',
                transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
              }}
              aria-hidden="true"
            />
            <span className="relative flex justify-between items-center text-[13.5px]">
              <span
                className={cn(
                  'flex items-center gap-2 text-[var(--text-primary)]',
                  mine ? 'font-semibold' : 'font-medium',
                )}
              >
                {mine && (
                  <Check
                    size={13}
                    strokeWidth={2.4}
                    className="text-[var(--brand-primary)]"
                    aria-hidden="true"
                  />
                )}
                {opt.label}
              </span>
              <span className="font-semibold text-[var(--text-secondary)] tabular-nums">
                {pct}%{' '}
                <span className="font-normal text-[var(--text-muted)] ml-1">
                  ({opt.votes})
                </span>
              </span>
            </span>
          </button>
        );
      })}
      <div className="text-[11.5px] text-[var(--text-tertiary)] tabular-nums">
        {total} {total === 1 ? 'vote' : 'votes'}
        {closesAt &&
          (closed
            ? ' · poll closed'
            : ` · closes ${formatRelativeTime(closesAt)}`)}
        {myVote !== undefined && (
          <span className="ml-2 text-[var(--brand-primary)] font-semibold">You voted</span>
        )}
      </div>
    </div>
  );
}
