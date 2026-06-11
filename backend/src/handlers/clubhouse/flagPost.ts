/**
 * Sprint 4 — community flagging for clubhouse posts.
 *
 * Sibling of `handlers/comments/flag.ts` — same design, different
 * resource. The threat-model, identity gate, atomicity reasoning, and
 * threshold (`HIDE_THRESHOLD = 3`) are documented exhaustively at the
 * top of that file; this header only calls out the deltas.
 *
 * # Deltas vs the comments flag
 *
 *   - Resource: clubhouse posts (`clubhouse_posts` table). Composite
 *     key (drepId, postId).
 *   - Flag-row partition key: `postKey = ${drepId}#${postId}`, matching
 *     the format already used by `clubhouse_comments`. See the
 *     `clubhouse_post_flags` table-stack rationale for why we reuse
 *     the format instead of inventing a second composite shape.
 *   - The hide threshold is the SAME constant (3). A future product
 *     decision can split the comment vs post thresholds; for Sprint 4
 *     they share the value.
 */

import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import {
  docClient,
  getItem,
  putItemIfAbsent,
  tableNames,
} from '../../lib/dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  clubhouseCommentPostKey,
  type ClubhousePostItem,
  type ClubhousePostFlagItem,
  type OnChainRole,
} from '../../lib/types';
import {
  extractAuthContext,
  requireOnChainRole,
} from '../../middleware/role-guard';
import { writeAuditEvent } from '../../lib/audit';
import { HIDE_THRESHOLD } from '../comments/flag';
import {
  ok,
  badRequest,
  forbidden,
  notFound,
  handleError,
} from '../_response';

/** First-in-line role from the caller's on-chain credentials.
 *  Bound onto the flag row for the audit trail. */
function pickRole(roles: ReadonlyArray<OnChainRole>): OnChainRole | undefined {
  return roles[0];
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

    requireOnChainRole(authCtx, 'drep', 'spo', 'cc', 'proposer');

    const role = pickRole(authCtx.onChainRoles ?? []);
    if (!role) {
      return forbidden('On-chain role required to flag');
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

    // Self-flag gate — same rationale as the comments handler.
    if (post.authorWallet === authCtx.walletAddress) {
      return badRequest('You cannot flag your own post');
    }

    const postKey = clubhouseCommentPostKey(drepId, postId);
    const now = new Date().toISOString();
    const flagRow: ClubhousePostFlagItem = {
      postKey,
      flaggerId: authCtx.walletAddress,
      role,
      createdAt: now,
    };

    const insertOutcome = await putItemIfAbsent(
      tableNames.clubhousePostFlags,
      flagRow as unknown as Record<string, unknown>,
      { partitionKey: 'postKey', sortKey: 'flaggerId' },
    );

    if (insertOutcome.outcome === 'errored') {
      throw insertOutcome.error;
    }

    if (insertOutcome.outcome === 'skipped') {
      await writeAuditEvent({
        entityType: 'clubhouse_post',
        entityId: postId,
        eventType: 'clubhouse.post.flag_dup',
        actorWallet: authCtx.walletAddress,
        metadata: { drepId, role },
      });
      return ok({
        outcome: 'already_flagged',
        postId,
      });
    }

    // Atomic ADD of the counter on the post row.
    let newCount: number | undefined;
    try {
      const updateRes = await docClient.send(
        new UpdateCommand({
          TableName: tableNames.clubhousePosts,
          Key: { drepId, postId },
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
      const c = attrs?.['flagCount'];
      if (typeof c === 'number') newCount = c;
      else if (typeof c === 'bigint') newCount = Number(c);
    } catch (err) {
      console.warn(
        `clubhouse/flagPost: counter ADD failed for drepId=${drepId} postId=${postId}:`,
        err,
      );
      throw err;
    }

    let hidden = false;
    if (newCount !== undefined && newCount >= HIDE_THRESHOLD) {
      try {
        await docClient.send(
          new UpdateCommand({
            TableName: tableNames.clubhousePosts,
            Key: { drepId, postId },
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
          hidden = true;
        } else {
          console.warn(
            `clubhouse/flagPost: hide SET failed for drepId=${drepId} postId=${postId}:`,
            err,
          );
        }
      }
    }

    await writeAuditEvent({
      entityType: 'clubhouse_post',
      entityId: postId,
      eventType: 'clubhouse.post.flagged',
      actorWallet: authCtx.walletAddress,
      metadata: {
        drepId,
        role,
        flagCount: newCount,
        hidden,
      },
    });

    return ok({
      outcome: 'flagged',
      postId,
      flagCount: newCount,
      hidden,
    });
  } catch (err) {
    console.error('clubhouse/flagPost handler error:', err);
    return handleError(err);
  }
};
