/**
 * GET /dreps — paginated DRep directory listing.
 *
 * Query params:
 *   - `?sort=power` (default) | `delegators` | `recent`
 *     - `power`: voting power desc (uses `votingPower-index` GSI)
 *     - `delegators`: delegator count desc (uses `delegatorCount-index` GSI;
 *       falls back to `power` for rows without delegator counts)
 *     - `recent`: not yet wired — falls back to `power` until the per-DRep
 *       last-voted timestamp lands. Documented intent here so the frontend
 *       can ship the dropdown today.
 *   - `?search=<text>` — case-insensitive substring match against
 *     `givenName`. Implemented as a Scan with FilterExpression — fine at
 *     ~2000 rows, replace with OpenSearch when scale demands it.
 *   - `?limit=<n>` — default 20, capped at 50.
 *   - `?lastKey=<base64>` — opaque pagination cursor.
 *
 * Response shape: `{ items: DRepDirectoryItem[], lastEvaluatedKey?, total }`.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { queryItems, scanItems, tableNames } from '../../lib/dynamodb';
import type { DRepDirectoryItem } from '../../lib/types';
import { ok, internalError } from '../_response';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

type SortKey = 'power' | 'delegators' | 'recent';

function parseSort(raw: string | undefined): SortKey {
  if (raw === 'delegators' || raw === 'recent') return raw;
  return 'power';
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const qs = event.queryStringParameters ?? {};
    const sort = parseSort(qs['sort']);
    const search = qs['search']?.trim();
    const limit = qs['limit']
      ? Math.min(Math.max(parseInt(qs['limit'], 10) || DEFAULT_LIMIT, 1), MAX_LIMIT)
      : DEFAULT_LIMIT;
    const exclusiveStartKey = qs['lastKey']
      ? (JSON.parse(Buffer.from(qs['lastKey'], 'base64').toString('utf-8')) as Record<
          string,
          unknown
        >)
      : undefined;

    // Search path: Scan with a contains() filter on the lower-cased
    // `givenName`. DynamoDB applies FilterExpression *after* Limit, so
    // a single Scan with `Limit: 20` only examines 20 items and filters
    // them — a page of 20 examined items will rarely contain matches
    // when the directory is large. Iterate until we either fill the
    // page or exhaust the table. Hard-cap at 5 round trips to bound
    // worst-case latency on tiny match-counts.
    //
    // At ~1000 rows this is fast enough; revisit with OpenSearch when
    // the directory grows past ~10k.
    if (search && search.length > 0) {
      const lower = search.toLowerCase();
      const collected: DRepDirectoryItem[] = [];
      let cursor: Record<string, unknown> | undefined = exclusiveStartKey;
      let lastKey: Record<string, unknown> | undefined;
      const MAX_ROUNDS = 5;
      // Per-round we ask for 200 items to keep filter overhead small
      // relative to the round-trip; we still trim to `limit` before
      // returning.
      const PER_ROUND_LIMIT = 200;
      for (let round = 0; round < MAX_ROUNDS && collected.length < limit; round++) {
        const page = await scanItems<DRepDirectoryItem>(tableNames.drepDirectory, {
          filterExpression: 'contains(#givenNameLower, :q)',
          expressionAttributeNames: { '#givenNameLower': 'givenNameLower' },
          expressionAttributeValues: { ':q': lower },
          limit: PER_ROUND_LIMIT,
          ...(cursor ? { exclusiveStartKey: cursor } : {}),
        });
        collected.push(...page.items);
        lastKey = page.lastEvaluatedKey;
        if (!page.lastEvaluatedKey) break;
        cursor = page.lastEvaluatedKey;
      }
      const trimmed = collected.slice(0, limit);
      return ok({
        items: trimmed,
        // Only return `lastKey` if we trimmed (more matches available)
        // OR DynamoDB still has more rows to scan. Otherwise the user
        // hits "Load more" and gets an empty next page.
        lastEvaluatedKey:
          collected.length > limit || lastKey
            ? lastKey
              ? Buffer.from(JSON.stringify(lastKey)).toString('base64')
              : undefined
            : undefined,
        total: trimmed.length,
      });
    }

    // Sort path: Query against a constant-partition GSI, sorted desc.
    // `delegators` falls back to `power` when no rows have a delegator
    // count yet (the directory sync defers this; the detail handler
    // populates it on-demand). `recent` is also stubbed to `power`
    // until per-DRep recent-vote timestamps land.
    const indexName =
      sort === 'delegators' ? 'delegatorCount-index' : 'votingPower-index';
    const partitionAttr =
      sort === 'delegators' ? 'delegatorCountPartition' : 'votingPowerPartition';

    const result = await queryItems<DRepDirectoryItem>(tableNames.drepDirectory, {
      indexName,
      keyConditionExpression: '#part = :all',
      expressionAttributeNames: { '#part': partitionAttr },
      expressionAttributeValues: { ':all': 'ALL' },
      limit,
      // Descending — highest first.
      scanIndexForward: false,
      ...(exclusiveStartKey ? { exclusiveStartKey } : {}),
    });

    // If the delegators index is empty (no rows have a delegator count
    // yet), fall back to the voting-power index so the page isn't blank.
    if (sort === 'delegators' && result.items.length === 0 && !exclusiveStartKey) {
      const fallback = await queryItems<DRepDirectoryItem>(tableNames.drepDirectory, {
        indexName: 'votingPower-index',
        keyConditionExpression: '#part = :all',
        expressionAttributeNames: { '#part': 'votingPowerPartition' },
        expressionAttributeValues: { ':all': 'ALL' },
        limit,
        scanIndexForward: false,
      });
      return ok({
        items: fallback.items,
        lastEvaluatedKey: fallback.lastEvaluatedKey
          ? Buffer.from(JSON.stringify(fallback.lastEvaluatedKey)).toString('base64')
          : undefined,
        total: fallback.count,
      });
    }

    return ok({
      items: result.items,
      lastEvaluatedKey: result.lastEvaluatedKey
        ? Buffer.from(JSON.stringify(result.lastEvaluatedKey)).toString('base64')
        : undefined,
      total: result.count,
    });
  } catch (err) {
    console.error('directory/list handler error:', err);
    return internalError('Failed to list DRep directory');
  }
};
