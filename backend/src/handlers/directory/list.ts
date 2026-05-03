/**
 * GET /dreps — paginated DRep directory listing.
 *
 * Query params:
 *   - `?sort=power` (default) | `delegators` | `recent` | `name`
 *     - `power`: voting power desc (uses `votingPower-index` GSI)
 *     - `delegators`: delegator count desc (uses `delegatorCount-index` GSI;
 *       falls back to `power` for rows without delegator counts)
 *     - `recent`: most-recent vote desc (uses `lastVoted-index` GSI).
 *       Never-voted DReps are absent from the index — they sort to the
 *       bottom naturally (i.e. they don't appear in the recent-activity
 *       view at all, which is the intended behavior).
 *     - `name`: alphabetical asc by `givenName`, with unnamed DReps
 *       sorted to the end. In-memory sort over a full Scan; pagination
 *       uses a `{namePage:N}` cursor instead of a DynamoDB key.
 *   - `?includeInactive=true` — by default the listing filters to
 *     `isActive=true`. With this param, inactive (expired-but-still-
 *     registered) DReps are returned mixed in. Search and recent-activity
 *     paths apply the same filter unless overridden.
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

type SortKey = 'power' | 'delegators' | 'recent' | 'name';

function parseSort(raw: string | undefined): SortKey {
  if (raw === 'delegators' || raw === 'recent' || raw === 'name') return raw;
  return 'power';
}

/** Sort key for `sort=name`. Lowercased givenName when present; otherwise
 *  push to the end with a tilde prefix that sorts after all letters in
 *  ASCII. The drepId tail keeps the sort deterministic across re-fetches.
 */
function nameSortKey(item: DRepDirectoryItem): string {
  const name = (item.givenName as string | undefined)?.trim();
  if (name && name.length > 0) return name.toLowerCase();
  const id = (item.drepId as string | undefined) ?? '';
  return `~${id}`;
}

/** Parse the `?includeInactive=` flag. Accept the truthy spellings used
 *  by the frontend (`true`, `1`); everything else falls through to false
 *  (active-only is the default). */
function parseIncludeInactive(raw: string | undefined): boolean {
  if (raw == null) return false;
  const v = raw.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const qs = event.queryStringParameters ?? {};
    const sort = parseSort(qs['sort']);
    const includeInactive = parseIncludeInactive(qs['includeInactive']);
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

    // Build the optional `isActive=true` filter once. Applied on top of
    // every code path (Scan and Query both accept FilterExpression).
    // DynamoDB filters AFTER Limit on Scan and AFTER read on Query, so
    // we over-fetch by 2x to give the filter some headroom on the active
    // sort paths — most rows are active so this rarely costs us anything.
    const activeFilter = includeInactive
      ? null
      : {
          filterExpression: '#isActive = :true',
          expressionAttributeNames: { '#isActive': 'isActive' },
          expressionAttributeValues: { ':true': true },
        };
    // 2x over-fetch when we're filtering, capped at 100 (DynamoDB's
    // own per-request hard cap is 1MB; 100 rows is well under).
    const fetchLimit = activeFilter ? Math.min(limit * 2, 100) : limit;

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
      // Compose the search filter with the optional active filter. If
      // both apply we AND them; otherwise just the search filter.
      const filterExpression: string = activeFilter
        ? 'contains(#givenNameLower, :q) AND #isActive = :true'
        : 'contains(#givenNameLower, :q)';
      const expressionAttributeNames: Record<string, string> = activeFilter
        ? { '#givenNameLower': 'givenNameLower', '#isActive': 'isActive' }
        : { '#givenNameLower': 'givenNameLower' };
      const expressionAttributeValues: Record<string, unknown> = activeFilter
        ? { ':q': lower, ':true': true }
        : { ':q': lower };
      for (let round = 0; round < MAX_ROUNDS && collected.length < limit; round++) {
        const page = await scanItems<DRepDirectoryItem>(tableNames.drepDirectory, {
          filterExpression,
          expressionAttributeNames,
          expressionAttributeValues,
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

    // Name sort: there's no GSI for alphabetical ordering since names
    // are sparse (~1/3 of DReps have a `givenName`). Scan the full table
    // (paginated until exhausted), sort in-memory, slice by page index.
    // At ~1000 rows this is fast; revisit with a `nameSort-index` GSI
    // if the directory grows past ~10k.
    if (sort === 'name') {
      // Decode `?lastKey` as a `{ namePage: number }` cursor for this
      // sort path. Other sort paths use real DynamoDB cursors so we can't
      // cross-decode safely — but the frontend always re-issues `lastKey`
      // verbatim from the previous response so this round-trips cleanly.
      let page = 0;
      if (exclusiveStartKey && typeof (exclusiveStartKey as Record<string, unknown>)['namePage'] === 'number') {
        page = (exclusiveStartKey as { namePage: number }).namePage;
      }

      const collected: DRepDirectoryItem[] = [];
      let cursor: Record<string, unknown> | undefined;
      const PER_ROUND = 200;
      const MAX_ROUNDS = 20; // safety cap; ~4000 rows
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const pageResp = await scanItems<DRepDirectoryItem>(tableNames.drepDirectory, {
          ...(activeFilter
            ? {
                filterExpression: activeFilter.filterExpression,
                expressionAttributeNames: activeFilter.expressionAttributeNames,
                expressionAttributeValues: activeFilter.expressionAttributeValues,
              }
            : {}),
          limit: PER_ROUND,
          ...(cursor ? { exclusiveStartKey: cursor } : {}),
        });
        collected.push(...pageResp.items);
        if (!pageResp.lastEvaluatedKey) break;
        cursor = pageResp.lastEvaluatedKey;
      }
      collected.sort((a, b) => {
        const ka = nameSortKey(a);
        const kb = nameSortKey(b);
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });
      const start = page * limit;
      const end = start + limit;
      const slice = collected.slice(start, end);
      const hasMore = end < collected.length;
      return ok({
        items: slice,
        lastEvaluatedKey: hasMore
          ? Buffer.from(JSON.stringify({ namePage: page + 1 })).toString('base64')
          : undefined,
        total: slice.length,
      });
    }

    // Sort path: Query against a constant-partition GSI, sorted desc.
    // `delegators` falls back to `power` when no rows have a delegator
    // count yet (the directory sync defers this; the detail handler
    // populates it on-demand). `recent` queries `lastVoted-index` —
    // never-voted DReps are absent from the index by design.
    let indexName: string;
    let partitionAttr: string;
    if (sort === 'delegators') {
      indexName = 'delegatorCount-index';
      partitionAttr = 'delegatorCountPartition';
    } else if (sort === 'recent') {
      indexName = 'lastVoted-index';
      partitionAttr = 'lastVotedPartition';
    } else {
      indexName = 'votingPower-index';
      partitionAttr = 'votingPowerPartition';
    }

    const result = await queryItems<DRepDirectoryItem>(tableNames.drepDirectory, {
      indexName,
      keyConditionExpression: '#part = :all',
      expressionAttributeNames: {
        '#part': partitionAttr,
        ...(activeFilter?.expressionAttributeNames ?? {}),
      },
      expressionAttributeValues: {
        ':all': 'ALL',
        ...(activeFilter?.expressionAttributeValues ?? {}),
      },
      ...(activeFilter ? { filterExpression: activeFilter.filterExpression } : {}),
      limit: fetchLimit,
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
        expressionAttributeNames: {
          '#part': 'votingPowerPartition',
          ...(activeFilter?.expressionAttributeNames ?? {}),
        },
        expressionAttributeValues: {
          ':all': 'ALL',
          ...(activeFilter?.expressionAttributeValues ?? {}),
        },
        ...(activeFilter ? { filterExpression: activeFilter.filterExpression } : {}),
        limit: fetchLimit,
        scanIndexForward: false,
      });
      const trimmed = fallback.items.slice(0, limit);
      return ok({
        items: trimmed,
        lastEvaluatedKey: fallback.lastEvaluatedKey
          ? Buffer.from(JSON.stringify(fallback.lastEvaluatedKey)).toString('base64')
          : undefined,
        total: trimmed.length,
      });
    }

    // Trim to the requested limit (we may have over-fetched to absorb
    // the active filter). Preserve `lastEvaluatedKey` from DynamoDB so
    // the next page resumes correctly even if the page is short.
    const trimmed = result.items.slice(0, limit);
    return ok({
      items: trimmed,
      lastEvaluatedKey: result.lastEvaluatedKey
        ? Buffer.from(JSON.stringify(result.lastEvaluatedKey)).toString('base64')
        : undefined,
      total: trimmed.length,
    });
  } catch (err) {
    console.error('directory/list handler error:', err);
    return internalError('Failed to list DRep directory');
  }
};
