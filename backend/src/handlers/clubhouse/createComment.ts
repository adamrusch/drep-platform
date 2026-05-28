import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ulid } from 'ulid';
import {
  getItem,
  putItem,
  updateItem,
  tableNames,
} from '../../lib/dynamodb';
import {
  clubhouseCommentPostKey,
  type ClubhousePostItem,
  type ClubhouseCommentItem,
  type ClubhouseCommentRowItem,
} from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { resolveClubhouseMembership } from './_membership';
import { ok, badRequest, forbidden, notFound, handleError } from '../_response';

interface CreateClubhouseCommentBody {
  body: string;
  /** Optional — when present, this comment is a reply to the named
   *  comment. Clubhouse rules allow 2 levels of nesting
   *  (top-level → reply → sub-reply); this is one level deeper than
   *  Public Comments. 3-deep is rejected with 400. */
  parentCommentId?: string;
}

/**
 * Handler: POST /clubhouse/{drepId}/post/{postId}/comment
 *
 * # P0-3 de-inline migration (2026-05-28)
 *
 * Comments now live in the dedicated `clubhouse_comments` table — one
 * row per comment, partitioned by `postKey = ${drepId}#${postId}`.
 * The handler dual-writes during the rotation window:
 *
 *   1. `putItem` the new row to `clubhouse_comments` with
 *      `attribute_not_exists(commentId)` so a retry doesn't double-
 *      insert. Depth is computed from a single `GetItem(parent)` —
 *      no in-memory walk required.
 *   2. Atomically bump the denormalized counter on the parent post:
 *      `ADD commentCount :one SET lastReplyAt = :now, updatedAt = :now`.
 *      The post is the source of truth for "{n} replies" badges and
 *      the rail's "active in 24h" filter without ever scanning the
 *      comment set.
 *   3. LEGACY: append the comment to the inline `comments[]` on the
 *      post row, with a `ConditionExpression: updatedAt = :prev` so
 *      the silently-dropping RMW race is bounded to a single conflict
 *      retry. This write stays alive in THIS PR — deferring its
 *      removal until after the backfill verifies and the read path
 *      has rotated to the new table (Phases 6 and 7 in the plan).
 *
 * # Depth guard
 *
 *   - depth 0 → top-level (no `parentCommentId`)
 *   - depth 1 → reply to a top-level comment
 *   - depth 2 → sub-reply to a reply
 *
 * The Clubhouse surface caps depth at 2. A new reply with
 * `parentCommentId === X` lands at `depthOf(X) + 1`, so we reject
 * if `depthOf(parent) >= 2`. After the migration, the parent's depth
 * is read directly off its persisted row in `clubhouse_comments`
 * (one `GetItem`); pre-backfill we fall back to the in-memory walk
 * against `post.comments[]` so the gate still works during rotation.
 *
 * # KNOWN-ISSUE: votePoll RMW
 *
 * The companion handler `votePoll.ts` does its OWN read-modify-write
 * of `pollVotes` on the post row. Oracle flagged that as a separate
 * P1 follow-up — not addressed in this PR (which is scoped to the
 * comment-cap blast radius). Tracked alongside Phases 5/6/7 in the
 * plan.
 */
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    const drepIdRaw = event.pathParameters?.['drepId'];
    const postIdRaw = event.pathParameters?.['postId'];

    if (!drepIdRaw || !postIdRaw) {
      return badRequest('drepId and postId path parameters are required');
    }

    if (!event.body) {
      return badRequest('Request body is required');
    }

    let reqBody: CreateClubhouseCommentBody;
    try {
      reqBody = JSON.parse(event.body) as CreateClubhouseCommentBody;
    } catch {
      return badRequest('Invalid JSON body');
    }

    if (!reqBody.body || reqBody.body.trim().length === 0) {
      return badRequest('body is required');
    }
    if (reqBody.body.length > 5_000) {
      return badRequest('body exceeds maximum length of 5,000 characters');
    }
    if (reqBody.parentCommentId !== undefined && typeof reqBody.parentCommentId !== 'string') {
      return badRequest('parentCommentId must be a string when provided');
    }

    const drepId = decodeURIComponent(drepIdRaw);
    const postId = decodeURIComponent(postIdRaw);

    const post = await getItem<ClubhousePostItem>(tableNames.clubhousePosts, {
      drepId,
      postId,
    });

    if (!post) {
      return notFound('Clubhouse post');
    }

    // ---- Depth guard (Clubhouse: 2 levels) ----
    // Resolve the parent's depth, then derive `newDepth = parent.depth + 1`.
    // The parent lookup tries the new table first (one `GetItem`); the
    // legacy in-memory walk on `post.comments[]` is the fallback so
    // pre-migration replies still resolve correctly during rotation.
    let newDepth: 0 | 1 | 2 = 0;
    if (reqBody.parentCommentId !== undefined) {
      const parentCommentId = reqBody.parentCommentId;
      const parentRow = await getItem<ClubhouseCommentRowItem>(
        tableNames.clubhouseComments,
        {
          postKey: clubhouseCommentPostKey(drepId, postId),
          commentId: parentCommentId,
        },
      );
      let parentDepth: number;
      if (parentRow && typeof parentRow.depth === 'number') {
        parentDepth = parentRow.depth;
      } else {
        // Fallback: pre-backfill parent — read it off the inline array.
        const inlineParent = (post.comments ?? []).find(
          (c) => c.commentId === parentCommentId,
        );
        if (!inlineParent) {
          return notFound('Parent comment');
        }
        parentDepth = depthOfInlineChain(post.comments ?? [], parentCommentId);
      }
      if (parentDepth >= 2) {
        return badRequest('Replies nested deeper than 2 levels are not allowed');
      }
      newDepth = (parentDepth + 1) as 0 | 1 | 2;
    }

    // ---- Membership gate ----
    // See `_membership.ts` for the policy. Role-holders (lead /
    // committee_member / trusted_delegator) and wallets currently
    // delegating to THIS DRep may comment; everyone else is rejected.
    // Soft-fail when both Koios + Blockfrost are unreachable so a
    // transient upstream outage doesn't 503 the comment surface; the
    // role-holder branch is unaffected (DDB Get).
    const membership = await resolveClubhouseMembership(authCtx.walletAddress, drepId);
    if (!membership.isRoleHolder && !membership.isCurrentDelegator) {
      if (!membership.delegationUnknown) {
        return forbidden(
          'You must be delegated to this DRep or be a committee member to post in their clubhouse',
        );
      }
      console.warn(
        `createComment: allowing comment from ${authCtx.walletAddress} despite unknown delegation (Koios+Blockfrost both failed)`,
      );
    }

    const commentId = ulid();
    const now = new Date().toISOString();

    // ---- (1) Write the per-row comment to the NEW table FIRST. ----
    // `attribute_not_exists(commentId)` defends against a retried Lambda
    // invocation re-inserting the same row. ULIDs are globally unique
    // so a collision here means the original write already landed and
    // we should treat it as success.
    const commentRow: ClubhouseCommentRowItem = {
      postKey: clubhouseCommentPostKey(drepId, postId),
      commentId,
      drepId,
      postId,
      authorWallet: authCtx.walletAddress,
      body: reqBody.body.trim(),
      createdAt: now,
      depth: newDepth,
      ...(reqBody.parentCommentId ? { parentCommentId: reqBody.parentCommentId } : {}),
    };
    try {
      await putItem(
        tableNames.clubhouseComments,
        commentRow as unknown as Record<string, unknown>,
        'attribute_not_exists(#commentId)',
        { '#commentId': 'commentId' },
      );
    } catch (err) {
      // A retried invocation with the same ULID hits this branch — the
      // row is already written, treat it as success. Anything else is
      // a real failure that should propagate.
      if (
        err &&
        typeof err === 'object' &&
        (err as { name?: string }).name === 'ConditionalCheckFailedException'
      ) {
        console.warn(
          `createComment: clubhouse_comments row ${commentId} already existed — treating as idempotent re-do`,
        );
      } else {
        throw err;
      }
    }

    // ---- (2) Atomically bump the denormalized counters on the post. ----
    // Single UpdateItem: ADD commentCount :one SET lastReplyAt = :now,
    //                        updatedAt = :now.
    // No conditional check needed — `ADD` is commutative on the counter,
    // and `SET lastReplyAt` is monotonic-newest by design (every comment
    // is newer than the previous one within a request lifetime).
    // Best-effort: if this fails after the per-row write succeeded, the
    // comment IS persisted; the counter will resync on the next backfill
    // pass. We log and continue rather than 5xx the user.
    try {
      await updateItem(
        tableNames.clubhousePosts,
        { drepId, postId },
        'ADD #cc :one SET #lra = :now, #u = :now',
        {
          '#cc': 'commentCount',
          '#lra': 'lastReplyAt',
          '#u': 'updatedAt',
        },
        {
          ':one': 1,
          ':now': now,
        },
      );
    } catch (err) {
      console.warn(
        `createComment: counter Update failed for drepId=${drepId} postId=${postId} (comment ${commentId} was still persisted to clubhouse_comments):`,
        err,
      );
    }

    // ---- (3) LEGACY inline write — kept alive during rotation. ----
    // DO NOT remove this in this PR. The read path still tolerates the
    // inline array (until Phase 4 cuts over for new posts and Phase 6
    // stops the inline write entirely). Keeping the dual-write means
    // a rollback of the API code is safe: the inline array stays the
    // source of truth for older Lambda containers.
    //
    // The RMW race is reduced (NOT eliminated) by guarding the write
    // with `ConditionExpression: updatedAt = :prevUpdatedAt`. On
    // conflict we retry ONCE by re-reading the post — anything beyond
    // a single retry is rare enough that the new-row write above is
    // the authoritative record. The new-table write already succeeded,
    // so a dropped inline append only affects the legacy read path
    // (which the migration is replacing anyway).
    const inlineComment: ClubhouseCommentItem = {
      commentId,
      authorWallet: authCtx.walletAddress,
      body: reqBody.body.trim(),
      createdAt: now,
      ...(reqBody.parentCommentId ? { parentCommentId: reqBody.parentCommentId } : {}),
    };
    await dualWriteLegacyInlineComment(drepId, postId, post, inlineComment, now);

    return ok(inlineComment);
  } catch (err) {
    console.error('clubhouse/createComment handler error:', err);
    return handleError(err);
  }
};

/**
 * Walk the in-memory inline-comments graph to compute a parent's depth.
 * Used as a FALLBACK only — once the per-row backfill runs, parent
 * depths are read directly off the persisted `clubhouse_comments` row.
 * The walk caps defensively at 3 hops to avoid an infinite loop on
 * pathological data; legitimate chains resolve in <= 2 hops.
 */
function depthOfInlineChain(
  comments: ClubhouseCommentItem[],
  commentId: string,
): number {
  const byId = new Map<string, ClubhouseCommentItem>();
  for (const c of comments) byId.set(c.commentId, c);
  let depth = 0;
  let cursor = byId.get(commentId);
  for (let i = 0; i < 3 && cursor?.parentCommentId; i++) {
    depth += 1;
    cursor = byId.get(cursor.parentCommentId);
    if (!cursor) break;
  }
  return depth;
}

/**
 * Append `inlineComment` to the post's inline `comments[]` array using
 * a version-guarded `UpdateItem` (`ConditionExpression` on `updatedAt`).
 * On conflict, refetch the post once and retry. After one retry we
 * accept silent loss of the inline write — the per-row write above is
 * the authoritative copy, and the inline path is being removed in a
 * follow-up.
 *
 * The legacy RMW race is the reason this migration exists. Wrapping
 * it with a version guard reduces (but does not eliminate) silent
 * drops during the rotation window — full elimination requires Phase 6
 * (stop the inline write) and Phase 7 (REMOVE the inline attribute).
 */
async function dualWriteLegacyInlineComment(
  drepId: string,
  postId: string,
  initialPost: ClubhousePostItem,
  inlineComment: ClubhouseCommentItem,
  now: string,
): Promise<void> {
  let outcome = await attemptVersionGuardedAppend(
    drepId,
    postId,
    initialPost,
    inlineComment,
    now,
  );
  if (outcome === 'conflict') {
    const fresh = await getItem<ClubhousePostItem>(tableNames.clubhousePosts, {
      drepId,
      postId,
    });
    if (!fresh) {
      console.warn(
        `createComment: legacy inline write — post disappeared between read and write for drepId=${drepId} postId=${postId}`,
      );
      return;
    }
    outcome = await attemptVersionGuardedAppend(
      drepId,
      postId,
      fresh,
      inlineComment,
      now,
    );
    if (outcome === 'conflict') {
      console.warn(
        `createComment: legacy inline write lost a race after retry for drepId=${drepId} postId=${postId} (comment ${inlineComment.commentId} is persisted to clubhouse_comments)`,
      );
    }
  }
}

async function attemptVersionGuardedAppend(
  drepId: string,
  postId: string,
  post: ClubhousePostItem,
  inlineComment: ClubhouseCommentItem,
  now: string,
): Promise<'ok' | 'conflict'> {
  const prevUpdatedAt = post.updatedAt;
  const nextComments = [...(post.comments ?? []), inlineComment];
  try {
    await updateItem(
      tableNames.clubhousePosts,
      { drepId, postId },
      'SET #c = :comments, #u = :now',
      {
        '#c': 'comments',
        '#u': 'updatedAt',
      },
      {
        ':comments': nextComments,
        ':now': now,
        ':prev': prevUpdatedAt,
      },
      '#u = :prev',
    );
    return 'ok';
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      (err as { name?: string }).name === 'ConditionalCheckFailedException'
    ) {
      return 'conflict';
    }
    throw err;
  }
}
