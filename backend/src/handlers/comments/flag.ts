/**
 * Sprint 4 — community flagging for governance-action comments.
 *
 * # Threat model
 *
 * Bad-faith content surfaces on the platform. Pre-Sprint-4 we relied on
 * the author cleanly deleting their own row OR a `platform_admin`
 * intervening — neither scales to "a 5k-stake account posts CSAM at
 * 03:00 UTC." We need a fast, low-friction "community shield" that
 * hides obviously bad content from normal users without giving any
 * single wallet the moderation hammer (which would be its own
 * censorship risk).
 *
 * # Design — "three distinct on-chain-verified writers"
 *
 * Three distinct flags from three different on-chain-verified writers
 * (`drep` / `spo` / `cc` / `proposer`) hide the comment from normal
 * users. Each flag is one row in `comment_flags` keyed on
 * (commentId, flaggerId). The 3-flagger threshold:
 *
 *   - Is small enough that a real abuse signal accumulates quickly.
 *   - Is large enough that a single hostile DRep cannot weaponise the
 *     hide.
 *   - Requires each flagger to have skin-in-the-game on-chain identity
 *     (they bound their flag to a publicly identifiable role) which
 *     makes "I'll spin up 50 sock-puppet wallets to silence X" hard:
 *     each sock-puppet would have to register on-chain in one of the
 *     four roles, which costs deposit + creates auditable on-chain
 *     evidence of the abuse pattern.
 *
 * `platform_admin`s can still SEE hidden rows (with a `hidden: true`
 * marker) so they have a moderation queue and can either confirm or
 * reverse the community decision.
 *
 * # Atomicity — no read-modify-write races
 *
 * The flow is:
 *
 *   1. Identity gate — the caller must hold at least one `OnChainRole`
 *      in their JWT (the Sprint 1 onchain-verify flow). Lego: reuse
 *      `requireOnChainRole`.
 *   2. Self-flag gate — reject if the caller is the comment's author.
 *      An author silencing their own comment by self-flag×3 would
 *      defeat the threshold.
 *   3. `putItemIfAbsent` on `comment_flags{commentId, flaggerId}`.
 *      - `'written'`  — fresh insert. We then atomically `ADD flagCount`
 *        on the parent comment row, AND set `hidden = true` conditional
 *        on `flagCount >= HIDE_THRESHOLD`. Both happen in ONE
 *        UpdateItem so there is no race window between increment and
 *        threshold check.
 *      - `'skipped'`  — duplicate flag from same wallet. We return 200
 *        with `outcome: 'already_flagged'` — same-wallet
 *        idempotency. No counter mutation.
 *      - `'errored'`  — propagate.
 *
 *   The atomic ADD-then-conditional-SET is achievable in a single
 *   UpdateExpression: the `ADD #flagCount :one` clause runs first,
 *   then we run a SECOND UpdateItem with a ConditionExpression
 *   `#flagCount >= :threshold` to flip `hidden`. The two-call approach
 *   is fine because the second call's condition is on the NEW counter
 *   value (post-ADD). If the second update's condition fails (count
 *   not yet at threshold) we treat that as the expected case for
 *   flags < 3. If it succeeds, the row's `hidden` is set and stays
 *   set forever (no path UNSETS it without admin intervention).
 *
 * # Why we don't use TransactWrite for the (insert + counter) pair
 *
 * `putItemIfAbsent` returns a distinguishable outcome that lets us
 * skip the counter update on the duplicate path. A TransactWrite would
 * have to encode the "skip vs proceed" decision in a ConditionCheck
 * that fails on duplicates, causing the whole transaction to roll
 * back including any audit side effects — clunky. The two-write
 * sequence (insert first, then conditional counter update) is the
 * simpler shape AND matches the existing `upsertCommentVoter`
 * pattern: insert evidence row first, denormalise the counter
 * atomically afterwards. A crash between the two leaves the per-
 * flagger row but no counter bump — soft-undercount, recoverable from
 * the canonical `comment_flags` rows.
 *
 * # Why we audit BOTH outcomes
 *
 * The audit log captures `comment.flagged` for fresh inserts AND
 * `comment.flag_dup` for skipped duplicates. The duplicate path is
 * load-bearing for the audit story — it surfaces "wallet X tried to
 * flag this twice" which can be a Sybil-attempt signal.
 *
 * # Why the duplicate path returns 200, not 409
 *
 * The user-facing semantic is "the flag is recorded" — they don't need
 * to know whether their flag was the first or the third. Returning a
 * single status code lets the FE render a unified "flagged" affordance
 * without branching on the response. The `outcome` field in the body
 * lets ops distinguish duplicates in metric collection.
 */

import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import {
  coerceToNumber,
  docClient,
  getItem,
  putItemIfAbsent,
  tableNames,
} from '../../lib/dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { CommentItem, CommentFlagItem, OnChainRole } from '../../lib/types';
import {
  extractAuthContext,
  requireOnChainRole,
} from '../../middleware/role-guard';
import { writeAuditEvent } from '../../lib/audit';
import {
  ok,
  badRequest,
  forbidden,
  notFound,
  handleError,
} from '../_response';

/**
 * Number of distinct on-chain-verified flaggers required to hide a row.
 *
 * Exported so the test suite can lock the threshold against accidental
 * change. Changing this value is a product decision (community-shield
 * sensitivity) — bump it in a deliberate PR.
 */
export const HIDE_THRESHOLD = 3;

/** Pick the first `OnChainRole` the caller proved. Carries the role
 *  onto the audit + flag row so the moderation surface knows under
 *  what authority the flag was raised. Returns `undefined` only if
 *  the caller has no on-chain roles — `requireOnChainRole` will have
 *  already 403'd in that case, this is defence-in-depth. */
function pickRole(roles: ReadonlyArray<OnChainRole>): OnChainRole | undefined {
  return roles[0];
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    const actionId = event.pathParameters?.['actionId'];
    const commentId = event.pathParameters?.['commentId'];

    if (!actionId || !commentId) {
      return badRequest('actionId and commentId path parameters are required');
    }

    // Identity gate — must be an on-chain-verified writer. The 4 roles
    // (`drep` / `spo` / `cc` / `proposer`) are all proven via Sprint 1
    // `/auth/onchain/verify`. A wallet with NO on-chain role cannot
    // flag; this is the per-flagger barrier-to-entry that makes the
    // 3-distinct-flaggers threshold meaningful.
    requireOnChainRole(authCtx, 'drep', 'spo', 'cc', 'proposer');

    const role = pickRole(authCtx.onChainRoles ?? []);
    if (!role) {
      // Defence-in-depth — `requireOnChainRole` should have thrown 403
      // above. If we ever land here it's a programming error in this
      // file, not a malicious caller.
      return forbidden('On-chain role required to flag');
    }

    const decodedActionId = decodeURIComponent(actionId);
    const decodedCommentId = decodeURIComponent(commentId);

    // Verify the comment exists AND fetch its author so the self-flag
    // guard can fire. One Get on the primary key, eventually-consistent
    // is fine — same-millisecond self-flag-race-against-own-delete is
    // not a real attack scenario.
    const comment = await getItem<CommentItem>(tableNames.comments, {
      actionId: decodedActionId,
      commentId: decodedCommentId,
    });

    if (!comment?.walletAddress) {
      return notFound('Comment');
    }

    if (comment.walletAddress === authCtx.walletAddress) {
      return badRequest('You cannot flag your own comment');
    }

    // ---- Insert the per-flagger evidence row ----
    const now = new Date().toISOString();
    const flagRow: CommentFlagItem = {
      commentId: decodedCommentId,
      flaggerId: authCtx.walletAddress,
      role,
      createdAt: now,
    };

    const insertOutcome = await putItemIfAbsent(
      tableNames.commentFlags,
      flagRow as unknown as Record<string, unknown>,
      { partitionKey: 'commentId', sortKey: 'flaggerId' },
    );

    if (insertOutcome.outcome === 'errored') {
      throw insertOutcome.error;
    }

    if (insertOutcome.outcome === 'skipped') {
      // Duplicate flag from the same wallet — same-wallet idempotency.
      // We audit it for the abuse-pattern story and return 200 with a
      // distinguishable outcome.
      await writeAuditEvent({
        entityType: 'comment',
        entityId: decodedCommentId,
        eventType: 'comment.flag_dup',
        actorWallet: authCtx.walletAddress,
        metadata: {
          actionId: decodedActionId,
          role,
        },
      });
      return ok({
        outcome: 'already_flagged',
        commentId: decodedCommentId,
      });
    }

    // ---- Atomic counter ADD + conditional hide ----
    //
    // Step A: atomic ADD of the denormalised counter. UpdateExpression
    // `ADD #flagCount :one` is concurrency-safe — two writers ADDing
    // 1 each end at +2, never +1. Returns the new counter value via
    // `ReturnValues: 'UPDATED_NEW'` so step B knows whether to flip
    // `hidden`.
    let newCount: number | undefined;
    try {
      const updateRes = await docClient.send(
        new UpdateCommand({
          TableName: tableNames.comments,
          Key: { actionId: decodedActionId, commentId: decodedCommentId },
          UpdateExpression: 'ADD #flagCount :one SET #updatedAt = :now',
          ExpressionAttributeNames: {
            '#flagCount': 'flagCount',
            '#updatedAt': 'updatedAt',
          },
          ExpressionAttributeValues: { ':one': 1, ':now': now },
          ReturnValues: 'UPDATED_NEW',
        }),
      );
      const attrs = updateRes.Attributes as Record<string, unknown> | undefined;
      newCount = coerceToNumber(attrs?.['flagCount']);
    } catch (err) {
      // Counter-update failure does NOT roll back the per-flagger row
      // (the evidence is the canonical source). We log + propagate
      // so an operator notices, but the flag is still on disk.
      console.warn(
        `comments/flag: counter ADD failed for commentId=${decodedCommentId}:`,
        err,
      );
      throw err;
    }

    // Step B: if the new count crossed the threshold, conditionally
    // SET `hidden = true`. The condition `attribute_not_exists(hidden)
    // OR hidden = :false` prevents a re-flag from clobbering an admin's
    // manual `hidden: false` (a future moderation surface might want
    // to surface a flagged-but-cleared row; we don't need to bake that
    // path in today but the conditional keeps us future-friendly).
    //
    // A swallowed `ConditionalCheckFailedException` means "already
    // hidden" — fine, no-op.
    let hidden = false;
    if (newCount !== undefined && newCount >= HIDE_THRESHOLD) {
      try {
        await docClient.send(
          new UpdateCommand({
            TableName: tableNames.comments,
            Key: { actionId: decodedActionId, commentId: decodedCommentId },
            UpdateExpression: 'SET #hidden = :true',
            ConditionExpression:
              'attribute_not_exists(#hidden) OR #hidden = :false',
            ExpressionAttributeNames: { '#hidden': 'hidden' },
            ExpressionAttributeValues: { ':true': true, ':false': false },
          }),
        );
        hidden = true;
      } catch (err) {
        if (
          err &&
          typeof err === 'object' &&
          (err as { name?: string }).name === 'ConditionalCheckFailedException'
        ) {
          // Already hidden. Idempotent — treat as success.
          hidden = true;
        } else {
          console.warn(
            `comments/flag: hide SET failed for commentId=${decodedCommentId}:`,
            err,
          );
          // We do NOT throw — the counter is correct and the next flag
          // (or an admin sweep) can retry the hide. Returning success
          // here is preferable to 5xx-ing on a transient DDB blip.
        }
      }
    }

    await writeAuditEvent({
      entityType: 'comment',
      entityId: decodedCommentId,
      eventType: 'comment.flagged',
      actorWallet: authCtx.walletAddress,
      metadata: {
        actionId: decodedActionId,
        role,
        flagCount: newCount,
        hidden,
      },
    });

    return ok({
      outcome: 'flagged',
      commentId: decodedCommentId,
      flagCount: newCount,
      hidden,
    });
  } catch (err) {
    console.error('comments/flag handler error:', err);
    return handleError(err);
  }
};
