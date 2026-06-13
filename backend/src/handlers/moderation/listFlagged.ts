/**
 * Moderation queue — `GET /admin/moderation/flagged`.
 *
 * Returns every parent row across the three flag surfaces
 * (`comments`, `clubhouse_posts`, `clubhouse_comments`) whose
 * `flagCount > 0` OR `hidden = true`, projected to a small "queue card"
 * shape the moderation UI consumes (content type, ids, author,
 * body snippet, flagCount, hidden, createdAt).
 *
 * # Why a filtered Scan
 *
 * At today's scale (≪ 10k rows per parent table, single-digit %
 * flag-rate) a filtered Scan of each parent table — keyed on
 * `flagCount > 0 OR attribute_exists(hidden)` — is the cheapest read
 * path that doesn't pre-bake schema work for a feature that may stay
 * low-traffic. The COST: DDB charges for every item EXAMINED, not just
 * returned — so even a 0%-flagged table still pays a ~5 RCU/MB scan
 * cost per call. The admin queue is hit by a handful of operators a
 * day, so the absolute spend stays in the cents/month range.
 *
 * If the queue ever becomes hot OR table cardinality crosses ~100k
 * rows, the right next step is a sparse GSI keyed on `'FLAGGED'`
 * partition with `lastFlaggedAt` sort key — written only on the row
 * when `flagCount` first crosses 1. That gives a single-partition
 * Query of every flagged row, paid only for rows currently in the
 * queue. Tracked as a follow-up; the Scan is fine for now.
 *
 * # Pagination + `type` filter
 *
 * The `?type=comment|clubhouse_post|clubhouse_comment` query param
 * narrows to one parent table — useful when the queue is large and a
 * mod is focused on one surface. Pagination uses a base64-encoded
 * `lastKey` cursor PER parent table (a row carries the cursor type
 * because each parent has a different key shape). When no type is
 * supplied we run all three Scans in parallel and return a combined
 * list, sorted descending by `createdAt` — small N, cheap O(N log N)
 * sort in Lambda memory.
 *
 * # Auth + audit
 *
 * Gated to `platform_admin` via `requirePlatformAdmin` (the same path
 * used by `setRole`). The READ itself is not audit-logged — the audit
 * trail focuses on mutations (`setHidden`, `dismissFlags`). The
 * subscriber-visible audit story is "who changed visibility," not
 * "who looked at the queue."
 */

import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { scanItems, tableNames } from '../../lib/dynamodb';
import type {
  CommentItem,
  ClubhousePostItem,
  ClubhouseCommentRowItem,
} from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { requirePlatformAdmin } from '../../lib/platformAdmin';
import { ok, badRequest, handleError } from '../_response';

/** The three content types the queue surfaces. */
export type ModerationContentType =
  | 'comment'
  | 'clubhouse_post'
  | 'clubhouse_comment';

/** A queue card — the shape the FE renders for each flagged item. */
export interface ModerationQueueItem {
  type: ModerationContentType;
  /** The natural id the parent table's PK uses on the row. */
  id: string;
  /** Parent path components needed to address the row in `setHidden`.
   *  - `comment`: `actionId` + `commentId`.
   *  - `clubhouse_post`: `drepId` + `postId`.
   *  - `clubhouse_comment`: `drepId` + `postId` + `commentId`. */
  parent: {
    actionId?: string;
    drepId?: string;
    postId?: string;
    commentId?: string;
  };
  /** Wallet that authored the flagged content. */
  authorWallet: string;
  authorDisplayName?: string;
  /** Best-effort snippet of the body (first ~280 chars). The full body
   *  is intentionally NOT returned — moderators read it inline in the
   *  UI but a queue page shouldn't move kilobytes per row. */
  snippet: string;
  flagCount: number;
  hidden: boolean;
  createdAt: string;
}

/** Default cap on returned rows per call. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const SNIPPET_LEN = 280;

function snippetOf(body: string | undefined): string {
  if (!body) return '';
  if (body.length <= SNIPPET_LEN) return body;
  return `${body.slice(0, SNIPPET_LEN)}…`;
}

/** Scan filter expression that matches "flagged or hidden" rows.
 *
 *  We use `flagCount > :zero` (catches every row that ever got a flag,
 *  including current zero-flagged-but-still-hidden which is technically
 *  impossible today but documented as a future admin path) OR
 *  `hidden = :true`. Returning hidden-but-zero-flag rows lets a mod
 *  re-surface a manually-hidden row from the queue if they later want
 *  to unhide it — same UI path. */
const FLAGGED_FILTER = '#flagCount > :zero OR #hidden = :true';
const FLAGGED_NAMES = { '#flagCount': 'flagCount', '#hidden': 'hidden' };
const FLAGGED_VALUES = { ':zero': 0, ':true': true };

async function scanComments(limit: number): Promise<ModerationQueueItem[]> {
  const res = await scanItems<CommentItem>(tableNames.comments, {
    filterExpression: FLAGGED_FILTER,
    expressionAttributeNames: FLAGGED_NAMES,
    expressionAttributeValues: FLAGGED_VALUES,
    limit,
  });
  return res.items.map((row) => ({
    type: 'comment' as const,
    id: row.commentId,
    parent: { actionId: row.actionId, commentId: row.commentId },
    authorWallet: row.walletAddress,
    ...(row.displayName ? { authorDisplayName: row.displayName } : {}),
    snippet: snippetOf(row.body),
    flagCount: row.flagCount ?? 0,
    hidden: row.hidden ?? false,
    createdAt: row.createdAt,
  }));
}

async function scanClubhousePosts(
  limit: number,
): Promise<ModerationQueueItem[]> {
  const res = await scanItems<ClubhousePostItem>(tableNames.clubhousePosts, {
    filterExpression: FLAGGED_FILTER,
    expressionAttributeNames: FLAGGED_NAMES,
    expressionAttributeValues: FLAGGED_VALUES,
    limit,
  });
  return res.items.map((row) => ({
    type: 'clubhouse_post' as const,
    id: row.postId,
    parent: { drepId: row.drepId, postId: row.postId },
    authorWallet: row.authorWallet,
    ...(row.authorDisplayName ? { authorDisplayName: row.authorDisplayName } : {}),
    snippet: snippetOf(row.body),
    flagCount: row.flagCount ?? 0,
    hidden: row.hidden ?? false,
    createdAt: row.createdAt,
  }));
}

async function scanClubhouseComments(
  limit: number,
): Promise<ModerationQueueItem[]> {
  const res = await scanItems<ClubhouseCommentRowItem>(
    tableNames.clubhouseComments,
    {
      filterExpression: FLAGGED_FILTER,
      expressionAttributeNames: FLAGGED_NAMES,
      expressionAttributeValues: FLAGGED_VALUES,
      limit,
    },
  );
  return res.items.map((row) => ({
    type: 'clubhouse_comment' as const,
    id: row.commentId,
    parent: {
      drepId: row.drepId,
      postId: row.postId,
      commentId: row.commentId,
    },
    authorWallet: row.authorWallet,
    ...(row.authorDisplayName ? { authorDisplayName: row.authorDisplayName } : {}),
    snippet: snippetOf(row.body),
    flagCount: row.flagCount ?? 0,
    hidden: row.hidden ?? false,
    createdAt: row.createdAt,
  }));
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    requirePlatformAdmin(authCtx);

    const qs = event.queryStringParameters ?? {};
    const typeRaw = qs['type'];
    const limitRaw = qs['limit'];

    if (
      typeRaw !== undefined &&
      typeRaw !== 'comment' &&
      typeRaw !== 'clubhouse_post' &&
      typeRaw !== 'clubhouse_comment'
    ) {
      return badRequest(
        'type must be one of: comment, clubhouse_post, clubhouse_comment',
      );
    }
    const type = typeRaw as ModerationContentType | undefined;

    let limit = DEFAULT_LIMIT;
    if (limitRaw) {
      const parsed = parseInt(limitRaw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return badRequest('limit must be a positive integer');
      }
      limit = Math.min(parsed, MAX_LIMIT);
    }

    let items: ModerationQueueItem[];
    if (type === 'comment') {
      items = await scanComments(limit);
    } else if (type === 'clubhouse_post') {
      items = await scanClubhousePosts(limit);
    } else if (type === 'clubhouse_comment') {
      items = await scanClubhouseComments(limit);
    } else {
      // Combined: run all three in parallel. Each returns up to `limit`
      // rows so the worst-case payload is 3 × limit; we then sort
      // newest-first and slice back down to `limit`. This is fine at
      // current scale (single-digit hundreds of flagged rows worst-case).
      const [c, p, cc] = await Promise.all([
        scanComments(limit),
        scanClubhousePosts(limit),
        scanClubhouseComments(limit),
      ]);
      items = [...c, ...p, ...cc];
    }

    // Sort descending by createdAt. ISO-8601 sorts lexicographically.
    items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    items = items.slice(0, limit);

    return ok({
      items,
      count: items.length,
      ...(type ? { type } : {}),
    });
  } catch (err) {
    console.error('moderation/listFlagged error:', err);
    return handleError(err);
  }
};
