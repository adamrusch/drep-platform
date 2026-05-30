/**
 * GET /clubhouse/{drepId}/post/{postId}/comments
 *
 * Lazy-load the per-row comments for a single Clubhouse post. The
 * collapsed post card on the frontend renders only the count badge
 * (off the denormalized `commentCount` field on the post row); the
 * full thread is fetched only when the user expands the panel.
 *
 * Returns every comment under one `postKey` partition in a single
 * `Query`, ULID-ordered (ascending = oldest first), with `depth`
 * preserved so the frontend can render the 2-level threading the same
 * way it does today against the inline array.
 *
 * # Response shape
 *
 * ```json
 * {
 *   "data": {
 *     "items": [ClubhouseComment, ClubhouseComment, ...]
 *   }
 * }
 * ```
 *
 * Each `items[i]` matches the same `ClubhouseComment` wire shape the
 * frontend already consumes from the inline array — `commentId`,
 * `authorWallet`, `authorDisplayName?`, `body`, `createdAt`,
 * `parentCommentId?`. The FE bucket-by-parent grouping logic in
 * `DelegatorClubhouse.tsx` works unchanged.
 *
 * No auth on this read — comments are public-read alongside the
 * containing post. The membership gate is only on writes.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { queryItems, tableNames } from '../../lib/dynamodb';
import {
  clubhouseCommentPostKey,
  type ClubhouseCommentRowItem,
} from '../../lib/types';
import { ok, badRequest, internalError } from '../_response';

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const drepIdRaw = event.pathParameters?.['drepId'];
    const postIdRaw = event.pathParameters?.['postId'];
    if (!drepIdRaw || !postIdRaw) {
      return badRequest('drepId and postId path parameters are required');
    }
    const drepId = decodeURIComponent(drepIdRaw);
    const postId = decodeURIComponent(postIdRaw);
    const postKey = clubhouseCommentPostKey(drepId, postId);

    // Single-partition Query — every comment for one post lives under
    // one `postKey`. ScanIndexForward defaults to true so we get
    // ULID-ascending (oldest first), which matches the on-the-wire
    // order the frontend already expects from the inline array.
    //
    // Defensive pagination: at ~10 comments median × 1KB row size,
    // even a pathological post with 400 comments fits in a single 1MB
    // DDB page. The loop is here to handle the truly unbounded case
    // without burning a Lambda timeout.
    const items: ClubhouseCommentRowItem[] = [];
    let lastKey: Record<string, unknown> | undefined;
    let pageGuard = 0;
    while (pageGuard++ < 10) {
      const result = await queryItems<ClubhouseCommentRowItem>(
        tableNames.clubhouseComments,
        {
          keyConditionExpression: '#pk = :v',
          expressionAttributeNames: { '#pk': 'postKey' },
          expressionAttributeValues: { ':v': postKey },
          ...(lastKey ? { exclusiveStartKey: lastKey } : {}),
        },
      );
      for (const it of result.items) items.push(it);
      if (!result.lastEvaluatedKey) break;
      lastKey = result.lastEvaluatedKey;
    }

    // Strip the partition-key bookkeeping (`postKey`, `drepId`,
    // `postId`, `depth`) before returning. The FE's `ClubhouseComment`
    // type is the legacy inline shape; preserving it keeps the
    // listComments response interchangeable with the inline-array
    // fallback during rotation.
    //
    // `authorDelegationActive` (Batch CLUBHOUSE-DELEGATION-GATE,
    // 2026-05-30) is surfaced ONLY when explicitly false — the absent
    // / true / undefined case all mean "active" on the frontend and
    // omitting the field saves wire bytes for the vast majority of
    // rows. The frontend renders the "no longer delegated" badge
    // strictly on `authorDelegationActive === false`.
    const responseItems = items.map((row) => ({
      commentId: row.commentId,
      authorWallet: row.authorWallet,
      body: row.body,
      createdAt: row.createdAt,
      ...(row.authorDisplayName ? { authorDisplayName: row.authorDisplayName } : {}),
      ...(row.parentCommentId ? { parentCommentId: row.parentCommentId } : {}),
      ...(row.authorDelegationActive === false
        ? { authorDelegationActive: false as const }
        : {}),
    }));

    return ok({ items: responseItems });
  } catch (err) {
    console.error('clubhouse/listComments handler error:', err);
    return internalError('Failed to list clubhouse comments');
  }
};
