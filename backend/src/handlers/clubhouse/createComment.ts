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
import { writeAuditEvent } from '../../lib/audit';
import { resolveIdentity } from '../../lib/identity';
import { resolveClubhouseMembership } from './_membership';
import { ok, badRequest, forbidden, notFound, serviceUnavailable, handleError } from '../_response';

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
 * # P0-3 de-inline migration — Phase 6 cutover (2026-05-28)
 *
 * Comments now live in the dedicated `clubhouse_comments` table — one
 * row per comment, partitioned by `postKey = ${drepId}#${postId}`. The
 * dual-write that existed in the Phases 1–4 PR has been REMOVED in
 * this Phase 6 cutover; new comments persist ONLY to the new table.
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
 *
 * # Why removing the dual-write is safe now
 *
 *   - Production has ZERO historical comments — the clubhouse-comment
 *     feature was never used before the P0-3 migration. The Phase 1–4
 *     backfill processed 7360 posts but wrote 0 comment rows, so there
 *     is no legacy data to fall back to.
 *   - Read paths already prefer the new table:
 *       - `list.ts` projects OUT inline `comments` at the Query level.
 *       - `_rail.ts` per-active-post Queries `clubhouse_comments`.
 *       - Frontend renders `commentCount ?? comments?.length ?? 0`.
 *   - Rollback is bounded by the SEC-2 deploy ordering: redeploying
 *     the previous Lambda image restores the dual-write, and the new
 *     rows already written stay live as the source of truth.
 *
 * # Depth guard
 *
 *   - depth 0 → top-level (no `parentCommentId`)
 *   - depth 1 → reply to a top-level comment
 *   - depth 2 → sub-reply to a reply
 *
 * The Clubhouse surface caps depth at 2. A new reply with
 * `parentCommentId === X` lands at `depthOf(X) + 1`, so we reject if
 * `depthOf(parent) >= 2`. The depth is read directly off the parent's
 * persisted row in `clubhouse_comments` (one `GetItem`); the inline-
 * array fallback for pre-backfill rows remains as defense in depth
 * but is dead code in production.
 *
 * # Companion: votePoll RMW
 *
 * The companion handler `votePoll.ts` previously did its OWN read-
 * modify-write of `pollVotes` on the post row. Fixed in SEC-2
 * (2026-05-28) — `votePoll` now issues a single atomic UpdateExpression
 * (`SET pollVotes.<wallet> = :newIdx` + `ADD pollOptions[i].votes`)
 * guarded by a per-wallet ConditionExpression. No RMW on either path.
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
    //
    // **2026-05-28 SEC-2 fail-closed change:** when both Koios +
    // Blockfrost are unreachable AND the caller is not a role-holder,
    // reject with 503 — uncertainty about delegation MUST NOT grant
    // access. The role-holder branch is the bypass: committee membership
    // is a local DDB Get with no upstream dependency, so the DRep and
    // their committee retain comment access during outages.
    //
    // Prior behavior (≤ 2026-05-27) soft-allowed; Oracle flagged that
    // as fail-open. See `_membership.ts` for the full rationale.
    const membership = await resolveClubhouseMembership(authCtx.walletAddress, drepId);
    if (!membership.isRoleHolder && !membership.isCurrentDelegator) {
      if (membership.delegationUnknown) {
        // Fail-CLOSED: role-holders never hit this branch (they would
        // have been let through above on `isRoleHolder`). A non-role-
        // holder gets a 503 so they can retry once upstream recovers.
        console.warn(
          `createComment: 503 rejecting ${authCtx.walletAddress} on drepId=${drepId} — delegation lookup failed (Koios+Blockfrost both unreachable) and caller is not a role-holder`,
        );
        await writeAuditEvent({
          entityType: 'auth',
          entityId: authCtx.walletAddress,
          eventType: 'auth.delegation_unverified',
          actorWallet: authCtx.walletAddress,
          metadata: {
            surface: 'createComment',
            drepId,
            postId,
          },
        });
        return serviceUnavailable(
          "Couldn't verify your delegation right now, please retry",
        );
      }
      await writeAuditEvent({
        entityType: 'clubhouse_post',
        entityId: postId,
        eventType: 'clubhouse.comment.denied',
        actorWallet: authCtx.walletAddress,
        metadata: {
          surface: 'createComment',
          drepId,
          reason: 'not_member',
        },
      });
      return forbidden(
        'You must be delegated to this DRep or be a committee member to post in their clubhouse',
      );
    }

    const commentId = ulid();
    const now = new Date().toISOString();
    // Same identity precedence as posts: profile name → DRep name → stake.
    const authorDisplayName = (await resolveIdentity(authCtx.walletAddress)).displayName;

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
      ...(authorDisplayName ? { authorDisplayName } : {}),
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

    // Best-effort audit AFTER the authoritative new-table write +
    // counter update. The audit fires for the per-row write, which is
    // the source of truth post-migration.
    await writeAuditEvent({
      entityType: 'clubhouse_comment',
      entityId: commentId,
      eventType: 'clubhouse.comment.created',
      actorWallet: authCtx.walletAddress,
      metadata: {
        drepId,
        postId,
        depth: newDepth,
        ...(reqBody.parentCommentId ? { parentCommentId: reqBody.parentCommentId } : {}),
      },
    });

    // P0-3 Phase 6 cutover (2026-05-28): the LEGACY inline `comments[]`
    // append on the post row has been REMOVED. New comments now live
    // ONLY in the `clubhouse_comments` table (written above). The
    // denormalized counter (`commentCount` / `lastReplyAt`) is still
    // bumped on the post; reads use the new table via `listComments.ts`
    // / `_rail.ts`. The Phase 7 cleanup script (`backend/scripts/
    // cleanup-inline-comments.ts`) one-shot REMOVEs the residual
    // (empty) `comments` attribute on existing post rows.
    //
    // Why this is safe NOW: production has ZERO historical comments
    // (the feature was never used pre-migration; the Phase 1-4 backfill
    // wrote 0 comment rows). All read paths already prefer the new
    // table — see `list.ts` (projects OUT inline `comments`),
    // `_rail.ts` (per-active-post Query against `clubhouse_comments`),
    // and the frontend's `commentCount ?? comments?.length ?? 0`
    // fallback. The dual-write existed only as a rollback safety net
    // during the rotation window; with the new table proven and the
    // backfill complete, the inline write is now pure cost + a race
    // surface.
    const inlineComment: ClubhouseCommentItem = {
      commentId,
      authorWallet: authCtx.walletAddress,
      body: reqBody.body.trim(),
      createdAt: now,
      ...(reqBody.parentCommentId ? { parentCommentId: reqBody.parentCommentId } : {}),
    };

    return ok(inlineComment);
  } catch (err) {
    console.error('clubhouse/createComment handler error:', err);
    return handleError(err);
  }
};

/**
 * Walk the in-memory inline-comments graph to compute a parent's depth.
 * Used as a FALLBACK only when the new-table parent row is absent —
 * legitimate post-migration chains resolve via the `clubhouse_comments`
 * `GetItem` above. The walk caps defensively at 3 hops to avoid an
 * infinite loop on pathological data; legitimate chains resolve in
 * <= 2 hops.
 *
 * Production has ZERO historical comments (the feature was never used
 * pre-migration), so the inline-array fallback is now effectively
 * dead code in production — but it's kept here as defense in depth in
 * case a pre-backfill row ever surfaces during a rollback window. The
 * Phase 7 cleanup script strips the residual empty `comments` attribute
 * from post rows.
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
