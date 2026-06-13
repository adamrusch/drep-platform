/**
 * Moderation override — `PUT /admin/moderation/hidden`.
 *
 * Lets `platform_admin` directly flip the `hidden` boolean on a comment,
 * clubhouse post, or clubhouse comment — used to:
 *
 *   1. UNHIDE a row the community wrongly hid (`hidden: true` → `false`).
 *      The denormalised `flagCount` on the row is LEFT IN PLACE so the
 *      audit story stays intact and the queue can still surface the row
 *      ("admin overrode 3 flags").
 *   2. RE-HIDE a row an admin earlier unhid (`hidden: false` → `true`),
 *      or pre-emptively hide a row before the community threshold is
 *      hit (rare; the community path is the dominant mechanism).
 *
 * # Conditional update — no read-modify-write races
 *
 * The update is `SET hidden = :new` with a ConditionExpression that
 * asserts the CURRENT value matches the caller's `expected` (or that
 * `hidden` is absent and `:expected` is `false`, the implicit pre-flag
 * state). This makes the mutation idempotent: two operators clicking
 * "unhide" in parallel both succeed; the second's check passes against
 * the first's outcome (already `false`). A race that flips against
 * intent gets a 409 instead of a silent overwrite.
 *
 * For the simple "I just want it set to X, don't care about the old
 * value" path the caller can pass `expected: null` to skip the
 * pre-condition. We still capture the prior value via
 * `ReturnValues: 'ALL_OLD'` so the audit row reflects the actual
 * `old → new` transition.
 *
 * # Audit
 *
 * EVERY action audit-logs `entityType=moderation`, `eventType=
 * moderation.hidden.set` with metadata `{ targetType, targetId,
 * oldHidden, newHidden, reason }`. The audit row is the single source
 * of truth for "who reversed the community decision and why."
 *
 * # Auth
 *
 * Gated to `platform_admin`. There is NO on-chain-role gate here —
 * this surface is reserved for the platform operator, distinct from
 * the community-flag path (`requireOnChainRole`).
 */

import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { docClient, tableNames } from '../../lib/dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { clubhouseCommentPostKey } from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { requirePlatformAdmin } from '../../lib/platformAdmin';
import { writeAuditEvent } from '../../lib/audit';
import { ok, badRequest, conflict, notFound, handleError } from '../_response';
import type { ModerationContentType } from './listFlagged';

interface SetHiddenBody {
  type?: string;
  hidden?: unknown;
  reason?: unknown;
  expected?: unknown;
  // Target identifiers — only the ones relevant to `type` are required.
  actionId?: string;
  commentId?: string;
  drepId?: string;
  postId?: string;
}

/** Reason-string sanity bound — keeps the audit metadata small. */
const REASON_MAX = 500;

function parseBody(raw: string | null | undefined): SetHiddenBody | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SetHiddenBody;
  } catch {
    return null;
  }
}

function isValidType(t: unknown): t is ModerationContentType {
  return t === 'comment' || t === 'clubhouse_post' || t === 'clubhouse_comment';
}

interface TargetKey {
  table: string;
  key: Record<string, string>;
  entityId: string;
  metadata: Record<string, unknown>;
}

function resolveTarget(
  type: ModerationContentType,
  body: SetHiddenBody,
): { ok: true; target: TargetKey } | { ok: false; message: string } {
  if (type === 'comment') {
    if (!body.actionId || !body.commentId) {
      return { ok: false, message: 'actionId and commentId are required for type=comment' };
    }
    return {
      ok: true,
      target: {
        table: tableNames.comments,
        key: { actionId: body.actionId, commentId: body.commentId },
        entityId: body.commentId,
        metadata: { actionId: body.actionId, commentId: body.commentId },
      },
    };
  }
  if (type === 'clubhouse_post') {
    if (!body.drepId || !body.postId) {
      return { ok: false, message: 'drepId and postId are required for type=clubhouse_post' };
    }
    return {
      ok: true,
      target: {
        table: tableNames.clubhousePosts,
        key: { drepId: body.drepId, postId: body.postId },
        entityId: body.postId,
        metadata: { drepId: body.drepId, postId: body.postId },
      },
    };
  }
  // clubhouse_comment
  if (!body.drepId || !body.postId || !body.commentId) {
    return {
      ok: false,
      message: 'drepId, postId, and commentId are required for type=clubhouse_comment',
    };
  }
  const postKey = clubhouseCommentPostKey(body.drepId, body.postId);
  return {
    ok: true,
    target: {
      table: tableNames.clubhouseComments,
      key: { postKey, commentId: body.commentId },
      entityId: body.commentId,
      metadata: { drepId: body.drepId, postId: body.postId, commentId: body.commentId },
    },
  };
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    requirePlatformAdmin(authCtx);

    const body = parseBody(event.body ?? null);
    if (!body) return badRequest('Request body must be JSON');

    if (!isValidType(body.type)) {
      return badRequest(
        'type must be one of: comment, clubhouse_post, clubhouse_comment',
      );
    }
    const type = body.type;

    if (typeof body.hidden !== 'boolean') {
      return badRequest('hidden must be a boolean');
    }
    const newHidden = body.hidden;

    // Optional `expected` — if present, must match the current value
    // for the conditional update to succeed. `null` / undefined means
    // "no pre-condition, set whatever the current value is."
    let expected: boolean | null = null;
    if (body.expected !== undefined && body.expected !== null) {
      if (typeof body.expected !== 'boolean') {
        return badRequest('expected, when provided, must be a boolean or null');
      }
      expected = body.expected;
    }

    let reason: string | undefined;
    if (body.reason !== undefined && body.reason !== null) {
      if (typeof body.reason !== 'string') {
        return badRequest('reason, when provided, must be a string');
      }
      if (body.reason.length > REASON_MAX) {
        return badRequest(`reason exceeds ${REASON_MAX} characters`);
      }
      reason = body.reason;
    }

    const targetRes = resolveTarget(type, body);
    if (!targetRes.ok) return badRequest(targetRes.message);
    const { target } = targetRes;

    const now = new Date().toISOString();
    const exprNames: Record<string, string> = {
      '#hidden': 'hidden',
      '#updatedAt': 'updatedAt',
    };
    const exprValues: Record<string, unknown> = {
      ':new': newHidden,
      ':now': now,
    };

    // The mutation: SET hidden + bump updatedAt. We ALSO require the
    // parent row to exist (`attribute_exists(#hidden) OR
    // attribute_exists(#updatedAt)` — the row guaranteed has at least
    // one of the two; using `updatedAt` as the existence sentinel
    // because every parent row carries it).
    let conditionExpression = 'attribute_exists(#updatedAt)';
    if (expected !== null) {
      // Pre-flag rows have NO `hidden` attribute at all. The implicit
      // value is `false`. So `expected === false` accepts BOTH
      // `attribute_not_exists(#hidden)` AND `#hidden = :false`.
      // `expected === true` only accepts `#hidden = :true`.
      exprValues[':expected'] = expected;
      if (expected === false) {
        conditionExpression +=
          ' AND (attribute_not_exists(#hidden) OR #hidden = :expected)';
      } else {
        conditionExpression += ' AND #hidden = :expected';
      }
    }

    let oldHidden = false;
    try {
      const res = await docClient.send(
        new UpdateCommand({
          TableName: target.table,
          Key: target.key,
          UpdateExpression: 'SET #hidden = :new, #updatedAt = :now',
          ConditionExpression: conditionExpression,
          ExpressionAttributeNames: exprNames,
          ExpressionAttributeValues: exprValues,
          ReturnValues: 'ALL_OLD',
        }),
      );
      const oldAttrs = res.Attributes as Record<string, unknown> | undefined;
      const prior = oldAttrs?.['hidden'];
      oldHidden = typeof prior === 'boolean' ? prior : false;
    } catch (err) {
      if (
        err &&
        typeof err === 'object' &&
        (err as { name?: string }).name === 'ConditionalCheckFailedException'
      ) {
        // Two reasons this can fire:
        //   (a) The row does not exist at all (`attribute_exists`
        //       fails). 404 is the right response.
        //   (b) The `expected` precondition mismatched. 409 — another
        //       operator moved the row out from under this caller.
        //
        // We can't distinguish without a follow-up Get; favour the
        // common case. If a caller wants disambiguation they pre-GET
        // via the queue list. Returning 409 in both cases is safe —
        // it tells the caller "your assumption about the current
        // state is wrong, refresh."
        if (expected === null) {
          return notFound('Target row');
        }
        return conflict(
          'The row was modified by another operator. Refresh the queue and retry.',
        );
      }
      throw err;
    }

    await writeAuditEvent({
      entityType: 'moderation',
      entityId: target.entityId,
      eventType: 'moderation.hidden.set',
      actorWallet: authCtx.walletAddress,
      metadata: {
        targetType: type,
        ...target.metadata,
        oldHidden,
        newHidden,
        ...(reason ? { reason } : {}),
      },
    });

    return ok({
      type,
      ...target.metadata,
      oldHidden,
      newHidden,
    });
  } catch (err) {
    console.error('moderation/setHidden error:', err);
    return handleError(err);
  }
};
