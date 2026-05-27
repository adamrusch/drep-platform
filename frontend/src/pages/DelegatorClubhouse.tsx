import React, { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  MessageSquare,
  Lock,
  Pin,
  Radio,
} from 'lucide-react';
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
import type { ClubhousePost, ClubhouseComment, ClubhousePollOption } from '@/types';

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
          sortClubhousePosts(data?.items ?? []).map((post) => (
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

/**
 * Sort clubhouse posts so that pinned `auto_ga` posts surface above
 * chronological posts. Within pinned, newest-first by `createdAt`.
 * Within non-pinned, newest-first (the order the API already returns).
 *
 * Unpinned auto_ga posts (the GA has completed) drop into the
 * chronological stream as historical records — they remain visible
 * but no longer dominate the top of the feed. This matches the locked
 * spec: "auto-posts are pinned until the GA transitions to executed/
 * expired, then unpinned — they become chronological. DO NOT DELETE them."
 */
function sortClubhousePosts(posts: readonly ClubhousePost[]): ClubhousePost[] {
  const pinned: ClubhousePost[] = [];
  const rest: ClubhousePost[] = [];
  for (const p of posts) {
    if (p.pinned === true) pinned.push(p);
    else rest.push(p);
  }
  pinned.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // The API already returns chronological-desc; preserve that order
  // by not re-sorting `rest`. Note: returning a sorted copy of the
  // input array (vs mutating in place) keeps React-Query's cached
  // data immutable.
  return [...pinned, ...rest];
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

  const isAutoPost = post.type === 'auto_ga';
  // Auto-posts are immortal in the sense that they're not deletable
  // by any user (they're "owned" by the platform, not by the
  // `_system:governance_feed` sentinel wallet). The lead DRep also
  // can't delete them — they're the platform's record of what GAs
  // were active when. Backend rejects deletes on these via the
  // matching wallet check in `deletePost.ts`; UI just hides the
  // affordance.
  const canDelete =
    !isAutoPost && (post.authorWallet === currentWallet || isLeadDRep);
  const myVote = currentWallet ? post.pollVotes?.[currentWallet] : undefined;
  const pollClosed =
    post.pollClosesAt && Date.parse(post.pollClosesAt) < Date.now();

  // Partition comments into top-level + nested. The Clubhouse surface
  // allows 2 levels (top → reply → sub-reply). We bucket reply lists
  // by their parent so each `CommentRow` knows its own descendants.
  // Sub-replies of replies appear in a separate map keyed by reply id.
  const { topLevel, repliesByParent } = useMemo(() => {
    const topLevel: ClubhouseComment[] = [];
    const repliesByParent = new Map<string, ClubhouseComment[]>();
    for (const c of post.comments) {
      if (c.parentCommentId) {
        const bucket = repliesByParent.get(c.parentCommentId) ?? [];
        bucket.push(c);
        repliesByParent.set(c.parentCommentId, bucket);
      } else {
        topLevel.push(c);
      }
    }
    // Replies render oldest-first under their parent. Top-level uses
    // server order (newest-first via SK = commentId ULID).
    for (const v of repliesByParent.values()) {
      v.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }
    return { topLevel, repliesByParent };
  }, [post.comments]);

  const handleAddTopLevelComment = async (): Promise<void> => {
    if (!commentBody.trim()) return;
    await createComment.mutateAsync({ drepId, postId: post.postId, body: commentBody.trim() });
    setCommentBody('');
  };

  const handleVote = (i: number): void => {
    if (pollClosed) return;
    votePoll.mutate({ drepId, postId: post.postId, optionIndex: i });
  };

  return (
    <article
      className={cn(
        'rounded-token-xl border bg-[var(--bg-canvas)] p-5 shadow-token-sm space-y-3',
        isAutoPost
          ? 'border-[var(--info-soft)]'
          : 'border-[var(--border-default)]',
      )}
    >
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          {/* Author rendering. Auto-posts get NO avatar circle — a
              small Radio icon stands in for the system-feed origin.
              Organic posts keep the existing two-letter initial avatar. */}
          {isAutoPost ? (
            <span
              className="w-8 h-8 rounded-token-full bg-[var(--info-soft)] text-[var(--info)] flex items-center justify-center flex-shrink-0"
              title="drep.tools governance feed"
              aria-label="Governance feed"
            >
              <Radio size={14} strokeWidth={2.2} />
            </span>
          ) : (
            <span className="w-8 h-8 rounded-token-full bg-[var(--brand-primary-soft)] text-[var(--brand-primary)] flex items-center justify-center text-[11px] font-semibold flex-shrink-0">
              {(post.authorDisplayName ?? post.authorWallet).slice(0, 2).toUpperCase()}
            </span>
          )}
          <span className="text-sm font-semibold text-[var(--text-primary)]">
            {isAutoPost
              ? 'drep.tools'
              : post.authorDisplayName ?? formatWalletAddress(post.authorWallet)}
          </span>
          {isAutoPost && (
            <span
              className="inline-flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-token-full bg-[var(--info-soft)] text-[var(--info)]"
              title="Auto-generated by drep.tools when this governance action was first detected"
            >
              Governance feed
            </span>
          )}
          {post.pinned && (
            <span
              className="inline-flex items-center gap-1 text-[10.5px] font-semibold px-2 py-0.5 rounded-token-full bg-[var(--bg-muted)] text-[var(--text-secondary)]"
              title="Pinned until this governance action completes"
            >
              <Pin size={10} strokeWidth={2.4} />
              Pinned
            </span>
          )}
          {post.isDRepPost && !isAutoPost && (
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

      {/* GA link — only on auto-posts. Lives above the title so the
          user sees what action this is referring to before the
          (possibly truncated) abstract. */}
      {isAutoPost && post.autoSource?.actionId && (
        <Link
          to={`/governance/${encodeURIComponent(post.autoSource.actionId)}`}
          className="inline-flex items-center gap-1 text-[12.5px] font-medium text-[var(--info)] hover:underline"
        >
          View governance action
          <ExternalLink size={11} strokeWidth={2.2} />
        </Link>
      )}

      {post.title && (
        <h3 className="text-[15px] font-semibold text-[var(--text-primary)] leading-snug">
          {post.title}
        </h3>
      )}

      <p className="text-sm text-[var(--text-secondary)] whitespace-pre-wrap leading-relaxed">
        {post.body}
      </p>

      {/* Frozen-at annotation — subtle, only on auto-posts. The
          locked spec calls this out as a required UI signal:
          "Body frozen at first sync: if the GA anchor metadata changes
          after the auto-post is created, the post body does NOT update."
          We render a small superscript right under the body so a user
          who scans the rest can still see the abstract is point-in-time. */}
      {isAutoPost && post.autoSource?.abstractFrozenAt && (
        <p className="text-[11px] text-[var(--text-tertiary)] italic">
          <sup>frozen at sync time</sup>{' '}
          <span title={post.autoSource.abstractFrozenAt}>
            ({formatRelativeTime(post.autoSource.abstractFrozenAt)})
          </span>
        </p>
      )}

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
          {topLevel.map((c) => (
            <ClubhouseCommentRow
              key={c.commentId}
              comment={c}
              depth={0}
              drepId={drepId}
              postId={post.postId}
              currentWallet={currentWallet}
              repliesByParent={repliesByParent}
            />
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
                onClick={() => void handleAddTopLevelComment()}
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

interface ClubhouseCommentRowProps {
  comment: ClubhouseComment;
  /** 0 = top-level, 1 = reply, 2 = sub-reply. Determines whether the
   *  Reply affordance renders (only on 0 and 1; depth 2 is the
   *  Clubhouse cap). */
  depth: 0 | 1 | 2;
  drepId: string;
  postId: string;
  currentWallet: string | null;
  repliesByParent: Map<string, ClubhouseComment[]>;
}

/**
 * One comment row. Manages its own toggle state for replies and the
 * inline reply form. The 2-level depth limit is enforced by:
 *   1. The backend rejecting 3-deep submissions with 400.
 *   2. The UI hiding the Reply affordance on depth-2 (sub-reply) rows.
 *
 * Sub-replies indent under their reply (single line of vertical rule);
 * the visual depth-2 step is one indent past the depth-1 step.
 */
function ClubhouseCommentRow({
  comment,
  depth,
  drepId,
  postId,
  currentWallet,
  repliesByParent,
}: ClubhouseCommentRowProps): React.ReactElement {
  const [repliesOpen, setRepliesOpen] = useState(false);
  const [replyFormOpen, setReplyFormOpen] = useState(false);
  const [replyBody, setReplyBody] = useState('');
  const createComment = useCreateClubhouseComment();

  const childReplies = repliesByParent.get(comment.commentId) ?? [];
  const childCount = childReplies.length;
  // Depth 2 is the cap — no Reply affordance at that level.
  const canReply = depth < 2 && currentWallet !== null;

  const handleSubmitReply = async (): Promise<void> => {
    if (!replyBody.trim()) return;
    await createComment.mutateAsync({
      drepId,
      postId,
      body: replyBody.trim(),
      parentCommentId: comment.commentId,
    });
    setReplyBody('');
    setReplyFormOpen(false);
    // Auto-open the replies list so the new reply is visible without
    // a second click. The query invalidation re-fetches the post in
    // the background.
    setRepliesOpen(true);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2.5">
        <span className="w-6 h-6 rounded-token-full bg-[var(--bg-muted)] text-[var(--text-secondary)] flex items-center justify-center text-[10px] font-semibold flex-shrink-0 mt-0.5">
          {(comment.authorDisplayName ?? comment.authorWallet).slice(0, 2).toUpperCase()}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[12.5px] font-semibold text-[var(--text-primary)]">
              {comment.authorDisplayName ?? formatWalletAddress(comment.authorWallet)}
            </span>
            <span className="text-[11px] text-[var(--text-tertiary)]">
              {formatRelativeTime(comment.createdAt)}
            </span>
          </div>
          <p className="text-[13px] text-[var(--text-secondary)] whitespace-pre-wrap leading-relaxed mt-0.5">
            {comment.body}
          </p>

          {/* Reply / replies-toggle row. Mirrors the Public Comments
              pattern but allows one more level of depth. */}
          {(canReply || childCount > 0) && (
            <div className="flex items-center gap-3 mt-1.5 flex-wrap">
              {canReply && (
                <button
                  type="button"
                  onClick={() => setReplyFormOpen((x) => !x)}
                  className="inline-flex items-center gap-1 text-[11.5px] font-medium text-[var(--text-tertiary)] hover:text-[var(--brand-primary)] transition-colors"
                >
                  <MessageSquare size={11} strokeWidth={2} />
                  Reply
                </button>
              )}
              {childCount > 0 && (
                <button
                  type="button"
                  onClick={() => setRepliesOpen((x) => !x)}
                  className="inline-flex items-center gap-1 text-[11.5px] font-medium text-[var(--text-tertiary)] hover:text-[var(--brand-primary)] transition-colors"
                  aria-expanded={repliesOpen}
                >
                  {repliesOpen ? (
                    <ChevronDown size={11} strokeWidth={2} />
                  ) : (
                    <ChevronRight size={11} strokeWidth={2} />
                  )}
                  {childCount} {childCount === 1 ? 'reply' : 'replies'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Inline reply form. Indented one level past the parent so the
          visual hierarchy mirrors the depth. */}
      {replyFormOpen && (
        <div className="ml-8 border-l-2 border-[var(--border-default)] pl-3 flex items-start gap-2">
          <textarea
            value={replyBody}
            onChange={(e) => setReplyBody(e.target.value)}
            placeholder="Write a reply…"
            rows={2}
            className="flex-1 rounded-token-md border border-[var(--border-default)] bg-[var(--bg-canvas)] px-3 py-1.5 text-[12.5px] resize-y focus:outline-none focus-visible:shadow-token-focus"
          />
          <Button
            size="sm"
            variant="primary"
            onClick={() => void handleSubmitReply()}
            disabled={!replyBody.trim() || createComment.isPending}
          >
            Reply
          </Button>
        </div>
      )}

      {/* Nested replies. Recursive — depth tracks the visual indent
          and gates the Reply affordance. The backend rejects 3-deep
          submissions even if the UI somehow ever surfaces the
          affordance there. */}
      {repliesOpen && childCount > 0 && (
        <div className="ml-8 border-l-2 border-[var(--border-default)] pl-3 space-y-2">
          {childReplies.map((r) => (
            <ClubhouseCommentRow
              key={r.commentId}
              comment={r}
              depth={(depth + 1) as 0 | 1 | 2}
              drepId={drepId}
              postId={postId}
              currentWallet={currentWallet}
              repliesByParent={repliesByParent}
            />
          ))}
        </div>
      )}
    </div>
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
