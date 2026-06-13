/**
 * Moderation queue — `GET /admin/moderation/flaggers`.
 *
 * Returns the per-flagger evidence rows for a single flagged item: who
 * raised the flag, the on-chain role they proved at flag time, and the
 * timestamp. Surfaces Sybil signals — e.g. three flags from wallets
 * registered minutes apart from a never-used proposer credential.
 *
 * # Why this is a separate endpoint
 *
 * The queue (`listFlagged`) returns the parent rows + denormalised
 * `flagCount`. The flagger list is a second-click drill-down — most
 * moderation decisions don't need it. Splitting the read keeps the
 * queue page cheap (no per-item RW per parent of N flag rows).
 *
 * # Read shape
 *
 *   - `comment` flags: `Query(commentFlags, PK=commentId)`. SK is
 *     `flaggerId`. Single-partition Query.
 *   - `clubhouse_post` flags: `Query(clubhousePostFlags, PK=postKey)`
 *     where `postKey = '${drepId}#${postId}'`. SK is `flaggerId`.
 *   - `clubhouse_comment` flags: `Query(clubhouseCommentFlags,
 *     PK=postKey)` followed by an in-memory filter to the rows whose
 *     `commentId` matches the path commentId. The SK shape
 *     (`commentId#flaggerId`) does NOT begin with `commentId` cleanly
 *     enough for a `begins_with` Query (the encoding would have to
 *     escape `#` inside the commentId — ULIDs don't contain `#`, so a
 *     `begins_with('${commentId}#')` is actually safe today, but we
 *     keep the safer "filter after Query" path for resilience to
 *     future id changes). At single-digit-thousands of comments per
 *     post worst-case the in-memory filter is negligible.
 *
 * # Auth + audit
 *
 * Gated to `platform_admin`. READ-only; not audit-logged.
 */

import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { queryItems, tableNames } from '../../lib/dynamodb';
import {
  clubhouseCommentPostKey,
  type CommentFlagItem,
  type ClubhousePostFlagItem,
  type ClubhouseCommentFlagItem,
} from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { requirePlatformAdmin } from '../../lib/platformAdmin';
import { ok, badRequest, handleError } from '../_response';
import type { ModerationContentType } from './listFlagged';

/** A single flagger row, projected for the queue UI. */
export interface ModerationFlagger {
  flaggerId: string;
  role: string;
  createdAt: string;
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    requirePlatformAdmin(authCtx);

    const qs = event.queryStringParameters ?? {};
    const typeRaw = qs['type'];
    if (
      typeRaw !== 'comment' &&
      typeRaw !== 'clubhouse_post' &&
      typeRaw !== 'clubhouse_comment'
    ) {
      return badRequest(
        'type query param is required and must be one of: comment, clubhouse_post, clubhouse_comment',
      );
    }
    const type = typeRaw as ModerationContentType;

    let flaggers: ModerationFlagger[];

    if (type === 'comment') {
      const commentId = qs['commentId'];
      if (!commentId) {
        return badRequest('commentId query param is required for type=comment');
      }
      const res = await queryItems<CommentFlagItem>(tableNames.commentFlags, {
        keyConditionExpression: '#commentId = :commentId',
        expressionAttributeNames: { '#commentId': 'commentId' },
        expressionAttributeValues: { ':commentId': decodeURIComponent(commentId) },
        limit: 100,
      });
      flaggers = res.items.map((r) => ({
        flaggerId: r.flaggerId,
        role: r.role,
        createdAt: r.createdAt,
      }));
    } else if (type === 'clubhouse_post') {
      const drepId = qs['drepId'];
      const postId = qs['postId'];
      if (!drepId || !postId) {
        return badRequest(
          'drepId and postId query params are required for type=clubhouse_post',
        );
      }
      const postKey = clubhouseCommentPostKey(
        decodeURIComponent(drepId),
        decodeURIComponent(postId),
      );
      const res = await queryItems<ClubhousePostFlagItem>(
        tableNames.clubhousePostFlags,
        {
          keyConditionExpression: '#postKey = :postKey',
          expressionAttributeNames: { '#postKey': 'postKey' },
          expressionAttributeValues: { ':postKey': postKey },
          limit: 100,
        },
      );
      flaggers = res.items.map((r) => ({
        flaggerId: r.flaggerId,
        role: r.role,
        createdAt: r.createdAt,
      }));
    } else {
      // clubhouse_comment
      const drepId = qs['drepId'];
      const postId = qs['postId'];
      const commentId = qs['commentId'];
      if (!drepId || !postId || !commentId) {
        return badRequest(
          'drepId, postId, and commentId query params are required for type=clubhouse_comment',
        );
      }
      const postKey = clubhouseCommentPostKey(
        decodeURIComponent(drepId),
        decodeURIComponent(postId),
      );
      const decodedCommentId = decodeURIComponent(commentId);
      const res = await queryItems<ClubhouseCommentFlagItem>(
        tableNames.clubhouseCommentFlags,
        {
          keyConditionExpression: '#postKey = :postKey',
          expressionAttributeNames: { '#postKey': 'postKey' },
          expressionAttributeValues: { ':postKey': postKey },
          limit: 200,
        },
      );
      flaggers = res.items
        .filter((r) => r.commentId === decodedCommentId)
        .map((r) => ({
          flaggerId: r.flaggerId,
          role: r.role,
          createdAt: r.createdAt,
        }));
    }

    // Stable order — most recent first.
    flaggers.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

    return ok({ type, flaggers, count: flaggers.length });
  } catch (err) {
    console.error('moderation/getFlaggers error:', err);
    return handleError(err);
  }
};
