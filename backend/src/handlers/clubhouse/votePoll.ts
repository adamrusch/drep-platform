import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, getItem, tableNames } from '../../lib/dynamodb';
import type { ClubhousePostItem } from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { writeAuditEvent } from '../../lib/audit';
import { resolveClubhouseMembership } from './_membership';
import {
  ok,
  badRequest,
  forbidden,
  notFound,
  conflict,
  serviceUnavailable,
  handleError,
} from '../_response';

/**
 * Cast / change a vote on a clubhouse poll.
 *
 * # Security trade-off
 *
 * The other write paths in this codebase require a fresh wallet signature
 * (mutation-nonce flow) on top of the JWT cookie. Poll voting is *intentionally*
 * exempt: a poll inside a private clubhouse is a low-stakes signal, the
 * surface area is tiny (single integer per wallet per post), and forcing
 * a wallet popup for every vote click would torch the UX. We rely on the
 * httpOnly auth cookie + the committee-membership check below.
 *
 * If poll results ever start driving on-chain decisions, swap this back
 * to the mutation-nonce flow. The handler shape is otherwise identical.
 *
 * # SEC-2 2026-05-28 — Atomic vote write (race fix)
 *
 * Prior behavior: read the post, mutate `pollVotes` + `pollOptions[].votes`
 * in memory, `putItem` the whole row back. Two wallets clicking ~simultaneously
 * each read the SAME `pollOptions[i].votes` baseline, each adds 1 in memory,
 * each writes — final count goes up by 1 instead of 2. Same RMW race class
 * as the comment-array race fixed in P0-3.
 *
 * Current behavior: single atomic `UpdateItem` that combines:
 *   - `SET pollVotes.<wallet> = :newIdx, updatedAt = :now` — idempotent.
 *   - `ADD pollOptions[newIdx].votes :one` — atomic, commutative.
 *   - `ADD pollOptions[prevIdx].votes :negOne` (only when the wallet had
 *     a previous vote on this poll) — atomic, decrements the old bucket.
 *
 * The write is guarded by a `ConditionExpression` that checks BOTH:
 *   - `attribute_exists(postId)` — the post wasn't deleted between our
 *     read and our write.
 *   - the wallet's `pollVotes` entry is still what we read OR doesn't
 *     exist — the previous-vote value didn't change under us. If it did
 *     (a concurrent vote from the SAME wallet landed first — unusual but
 *     possible with click-spamming), the condition fails, we re-read,
 *     recompute prev, and retry ONCE. After one retry we surface 409 so
 *     the caller can refresh.
 *
 * This eliminates the double-count without per-option counter denormalization
 * — the in-row array element IS the counter, and DDB's `ADD` on a list
 * element path is atomic.
 *
 * # Why a single retry is enough
 *
 * Concurrent votes from DIFFERENT wallets touch different
 * `pollVotes.<walletA>` vs `pollVotes.<walletB>` paths and DIFFERENT
 * (potentially overlapping) `pollOptions[i].votes` counters. The
 * ConditionExpression keys on the CALLER's wallet entry only, so two
 * concurrent votes from different wallets never block each other — both
 * succeed in one round-trip each. The retry is only relevant for the
 * narrow case of one wallet sending two near-simultaneous requests.
 */
interface VoteBody {
  /** Index into `pollOptions` (0-based). For multi-choice polls clients
   *  send one request per toggled option. */
  optionIndex: number;
}

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

    let body: VoteBody;
    try {
      body = JSON.parse(event.body) as VoteBody;
    } catch {
      return badRequest('Invalid JSON body');
    }

    if (typeof body.optionIndex !== 'number' || !Number.isInteger(body.optionIndex)) {
      return badRequest('optionIndex must be an integer');
    }

    const drepId = decodeURIComponent(drepIdRaw);
    const postId = decodeURIComponent(postIdRaw);

    // One Get to validate (type=poll, in-range index, not closed) and to
    // capture the caller's previous vote on this poll (the guard value
    // for the atomic update).
    const post = await getItem<ClubhousePostItem>(tableNames.clubhousePosts, {
      drepId,
      postId,
    });
    if (!post) return notFound('Clubhouse post');

    if (post.type !== 'poll' || !post.pollOptions || post.pollOptions.length === 0) {
      return badRequest('This post is not a poll');
    }

    if (post.pollClosesAt && Date.parse(post.pollClosesAt) < Date.now()) {
      return badRequest('This poll has closed');
    }

    if (body.optionIndex < 0 || body.optionIndex >= post.pollOptions.length) {
      return badRequest('optionIndex is out of range');
    }

    // ---- Membership gate (Batch CLUBHOUSE-DELEGATION-GATE, 2026-05-30) ----
    // Mirrors `createComment.ts` / `createPost.ts` — the Clubhouse is
    // delegator-scoped, so poll voting must be gated identically. Prior
    // to this PR `votePoll` had NO delegation check (the SEC-2 batch
    // wired the gate onto post + comment writes but missed this surface).
    //
    // Posture (identical to the comment/post handlers):
    //   - role-holder (lead / committee_member / trusted_delegator) →
    //     allow, irrespective of upstream weather (committee Get is a
    //     local DDB read with no external dependency).
    //   - confirmed current delegator → allow.
    //   - confirmed NOT delegated AND NOT a role-holder → 403.
    //   - delegation unknown (dual-upstream Koios+Blockfrost outage)
    //     AND NOT a role-holder → 503 (fail-CLOSED — uncertainty about
    //     delegation MUST NOT grant access).
    //
    // The gate runs BEFORE the idempotent same-option short-circuit so
    // an un-delegated wallet cannot silently re-confirm a prior vote
    // by re-submitting the same optionIndex. The 3h sweep separately
    // revokes such votes; this gate prevents NEW activity at cast time.
    const membership = await resolveClubhouseMembership(authCtx.walletAddress, drepId);
    if (!membership.isRoleHolder && !membership.isCurrentDelegator) {
      if (membership.delegationUnknown) {
        console.warn(
          `votePoll: 503 rejecting ${authCtx.walletAddress} on drepId=${drepId} postId=${postId} — delegation lookup failed (Koios+Blockfrost both unreachable) and caller is not a role-holder`,
        );
        await writeAuditEvent({
          entityType: 'auth',
          entityId: authCtx.walletAddress,
          eventType: 'auth.delegation_unverified',
          actorWallet: authCtx.walletAddress,
          metadata: {
            surface: 'votePoll',
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
        eventType: 'clubhouse.poll.denied',
        actorWallet: authCtx.walletAddress,
        metadata: {
          surface: 'votePoll',
          drepId,
          reason: 'not_member',
        },
      });
      return forbidden(
        'You must be delegated to this DRep or be a committee member to vote in their clubhouse',
      );
    }

    const previousIndex = post.pollVotes?.[authCtx.walletAddress];

    // Defensive note: every poll persisted via `createPost.ts` is
    // initialized with `pollVotes: {}` at the moment of poll creation
    // (see the `...(pollOptions ? { pollVotes: {} } : {})` spread there),
    // so the atomic `SET pollVotes.<wallet> = :newIdx` below always has
    // a valid map path. If a pre-init poll ever appears in DDB (none
    // exist in prod per git history — the spread predates the first
    // poll write), the UpdateItem would 400 with ValidationException
    // and be visible in CloudWatch. The handleError fallback would
    // surface a 500 in that case rather than silently swallowing.

    // Idempotent: voting the same option twice is a no-op rather than a
    // double-count. Cheap fast-path — saves an UpdateItem when the user
    // re-confirms their existing vote (common when navigating back to a
    // poll they already voted on).
    if (previousIndex === body.optionIndex) {
      return ok(post);
    }

    // ---- Atomic targeted UpdateItem (with single-retry on guard miss) ----
    let attempts = 0;
    let currentPrev = previousIndex;
    let updatedPost: ClubhousePostItem | undefined;
    while (true) {
      attempts++;
      try {
        updatedPost = await applyVoteUpdate({
          drepId,
          postId,
          walletAddress: authCtx.walletAddress,
          newIndex: body.optionIndex,
          previousIndex: currentPrev,
        });
        break;
      } catch (err) {
        if (
          err &&
          typeof err === 'object' &&
          (err as { name?: string }).name === 'ConditionalCheckFailedException' &&
          attempts < 2
        ) {
          // Re-read to discover the actual previous value, then retry.
          const fresh = await getItem<ClubhousePostItem>(tableNames.clubhousePosts, {
            drepId,
            postId,
          });
          if (!fresh) {
            // Race: post was deleted between our calls. Surface 404.
            return notFound('Clubhouse post');
          }
          const freshPrev = fresh.pollVotes?.[authCtx.walletAddress];
          // If the concurrent vote already landed on our desired option,
          // we're done. Return the fresh post.
          if (freshPrev === body.optionIndex) {
            return ok(fresh);
          }
          currentPrev = freshPrev;
          continue;
        }
        throw err;
      }
    }

    // Best-effort audit AFTER the atomic update succeeds.
    await writeAuditEvent({
      entityType: 'clubhouse_post',
      entityId: postId,
      eventType: 'clubhouse.poll.voted',
      actorWallet: authCtx.walletAddress,
      metadata: {
        drepId,
        optionIndex: body.optionIndex,
        priorOptionIndex: previousIndex ?? null,
      },
    });

    return ok(updatedPost ?? post);
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      (err as { name?: string }).name === 'ConditionalCheckFailedException'
    ) {
      // Out of retries — surface 409 so the caller can refresh + retry.
      return conflict('Poll vote conflicted with a concurrent write; please retry');
    }
    console.error('clubhouse/votePoll handler error:', err);
    return handleError(err);
  }
};

/**
 * Issue the atomic UpdateItem that flips this wallet's vote. Throws
 * `ConditionalCheckFailedException` when the guarded preconditions don't
 * hold (the wallet's previous vote moved under us, or the post was
 * deleted). The caller decides whether to retry or surface the error.
 *
 * Returns the post as DynamoDB reports it post-update (via
 * `ReturnValues: 'ALL_NEW'`). The shape matches `ClubhousePostItem`.
 *
 * # Expression structure
 *
 *   - `SET pollVotes.<wallet> = :newIdx, updatedAt = :now` — record the
 *     vote; idempotent on retry.
 *   - `ADD pollOptions[newIdx].votes :one` — atomic counter bump for the
 *     newly-chosen option. DynamoDB's `ADD` on a missing nested attr
 *     initializes to the operand, so a brand-new poll with `votes: 0`
 *     remains correct.
 *   - When `previousIndex !== undefined`: also `ADD pollOptions[prev].votes :negOne`
 *     to decrement the previous bucket. Both `ADD`s land atomically.
 *
 * # Why ConditionExpression on the wallet's previous vote
 *
 * Without the guard, the SAME wallet sending two near-simultaneous votes
 * (e.g. clicked option B before option A's request finished) would land
 * BOTH ADDs and over-count. With the guard keyed on the wallet's prior
 * value, the second request fails its condition, falls into the retry,
 * re-reads, and discovers the correct `previousIndex`.
 *
 * Different wallets have INDEPENDENT pollVotes paths; their ADDs on
 * shared `pollOptions[i].votes` don't conflict — DDB ADD is commutative.
 */
async function applyVoteUpdate(opts: {
  drepId: string;
  postId: string;
  walletAddress: string;
  newIndex: number;
  previousIndex: number | undefined;
}): Promise<ClubhousePostItem | undefined> {
  const now = new Date().toISOString();
  const names: Record<string, string> = {
    '#pv': 'pollVotes',
    '#wallet': opts.walletAddress,
    '#u': 'updatedAt',
    '#po': 'pollOptions',
    '#v': 'votes',
    '#pk': 'postId',
  };
  const values: Record<string, unknown> = {
    ':newIdx': opts.newIndex,
    ':now': now,
    ':one': 1,
  };

  // Build the ADD clause. DynamoDB requires list indices to be literals
  // in the expression string — they cannot be parameterized via
  // ExpressionAttributeValues. We've already validated `opts.newIndex`
  // and `opts.previousIndex` against `pollOptions.length` upstream.
  const addParts: string[] = [`#po[${opts.newIndex}].#v :one`];
  if (opts.previousIndex !== undefined && opts.previousIndex !== opts.newIndex) {
    addParts.push(`#po[${opts.previousIndex}].#v :negOne`);
    values[':negOne'] = -1;
  }

  // Guard the write on the wallet's previous vote being what we read.
  // Two sub-cases:
  //   (a) wallet hasn't voted yet → guard `attribute_not_exists(pollVotes.<wallet>)`
  //   (b) wallet voted before → guard `pollVotes.<wallet> = :prev`
  // The ConditionExpression also requires the post still exists.
  let conditionExpression: string;
  if (opts.previousIndex === undefined) {
    conditionExpression = 'attribute_exists(#pk) AND attribute_not_exists(#pv.#wallet)';
  } else {
    conditionExpression = 'attribute_exists(#pk) AND #pv.#wallet = :prev';
    values[':prev'] = opts.previousIndex;
  }

  const result = await docClient.send(
    new UpdateCommand({
      TableName: tableNames.clubhousePosts,
      Key: { drepId: opts.drepId, postId: opts.postId },
      UpdateExpression: `SET #pv.#wallet = :newIdx, #u = :now ADD ${addParts.join(', ')}`,
      ConditionExpression: conditionExpression,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }),
  );
  return result.Attributes as ClubhousePostItem | undefined;
}
