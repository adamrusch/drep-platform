/**
 * GET /dreps — page-numbered DRep directory listing.
 *
 * Query params:
 *   - `?sort=power` (default) | `delegators` | `recent` | `name`
 *     - `power`: voting power desc
 *     - `delegators`: delegator count desc (rows without a delegator
 *       count fall to the bottom)
 *     - `recent`: most-recent vote desc; never-voted DReps fall to the
 *       bottom
 *     - `name`: alphabetical asc by `givenName`; unnamed DReps fall to
 *       the bottom
 *   - `?includeInactive=true` — by default the listing filters to
 *     `isActive=true` AND `isRetired !== true`. With this param,
 *     inactive (expired-but-registered) DReps AND retired DReps are
 *     returned mixed in. We chose to merge "inactive" and "retired"
 *     into one toggle rather than expose two separate flags: from the
 *     directory-browsing perspective both states mean "DRep is no longer
 *     actively voting and not part of the active denominator," and the
 *     UI distinguishes them via badges on each card. The `?includeRetired=`
 *     parameter is accepted as an alias and ignored independently.
 *   - `?search=<text>` — case-insensitive substring match against
 *     `givenName`. Combined with the active filter when present.
 *   - `?page=<n>` — 0-indexed page (default 0). Backwards compat: also
 *     accepts `?lastKey=<base64>` from older clients but converts it to
 *     a page number where possible (and silently ignores unparseable
 *     cursors so the request doesn't error).
 *   - `?pageSize=<n>` — items per page, default 25, capped at 100.
 *     Legacy `?limit=` is accepted as an alias.
 *
 * Response shape (new):
 *   ```json
 *   {
 *     "items": [...],
 *     "total": <absolute count of matching rows after filter>,
 *     "page": <0-indexed>,
 *     "pageSize": <effective>,
 *     "totalPages": <ceil(total/pageSize)>,
 *     "lastEvaluatedKey": undefined  // legacy field, always absent now
 *   }
 *   ```
 *
 * Backend migration note (Aug 2026): all sort paths used to mix two
 * implementation strategies — `power` / `delegators` / `recent` queried
 * GSIs (`votingPower-index`, etc.) with DynamoDB Query pagination, while
 * `name` did a full Scan + in-memory sort with a `{namePage:N}` cursor.
 * The new pagination UX requires a true `total` count for every sort,
 * which a GSI-backed Query cannot give cheaply (DynamoDB returns
 * `Count` for the page, not the universe). Rather than maintain two
 * code paths we collapsed everything to the Scan-then-sort-in-memory
 * approach `name` already used. With ~1000 directory rows this is
 * fast (one Scan returns ~10 KB-100 KB, well under DynamoDB's 1MB page
 * cap, and the in-memory sort is microseconds). Revisit when the
 * directory grows past ~10k — at that point we'd want a real search
 * service (OpenSearch, Algolia) anyway.
 *
 * Backend migration note (2026-05-26): the read path no longer Scans
 * the base table. The `drep_directory` table is shared with the
 * `drep-voting-power-history` sync (daily POWER#NNNNNN sub-rows under
 * the same `drepId` partition), so the table has grown to ~101k items
 * for ~1623 PROFILE rows. A FilterExpression-driven Scan must pay for
 * reading every POWER row off disk before filtering settles, and was
 * exhausting its raw-item budget — returning only ~800 of 1623 PROFILE
 * rows and silently dropping DReps from the listing. The new path uses
 * a sparse GSI partitioned on `entityType='DREP_PROFILE'`: POWER rows
 * don't carry the attribute and are excluded automatically, so the
 * Query is O(PROFILE rows) not O(table size). See
 * `infra/lib/database-stack.ts` for the GSI definition.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { queryItems, tableNames } from '../../lib/dynamodb';
import type { DRepDirectoryItem } from '../../lib/types';
import { ok, internalError } from '../_response';

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
/** Cap on the per-call Query pagination loop. The new GSI is partitioned
 *  on `entityType='DREP_PROFILE'` and holds exactly one item per registered
 *  DRep (plus the two synthesized predefined-DRep rows) — ~1625 today.
 *  With 1MB Query pages and the ALL projection (~1KB/item), one Query call
 *  returns up to ~1000 items. 10 rounds × 1000 items = 10,000 PROFILE
 *  headroom — ~6x current size, leaves multi-year growth headroom. The
 *  GSI is sparse: POWER history sub-rows don't carry the partition-key
 *  attribute and are excluded automatically, so this Query is O(PROFILE
 *  rows) not O(table size) — fixing the bug that previously hid DReps
 *  from the listing once POWER rows accumulated past the Scan's ceiling. */
const MAX_QUERY_ROUNDS = 10;
/** Name of the new sparse GSI on the `drep_directory` table — see
 *  `infra/lib/database-stack.ts` for the definition and the
 *  2026-05-26 root-cause story. */
const ENTITY_TYPE_GSI_NAME = 'entityType-votingPower-index';
const ENTITY_TYPE_PROFILE = 'DREP_PROFILE';

/**
 * Module-level response cache. CloudFront in front of the API caches the
 * exact same response for 30s, but a cold-edge or invalidated CloudFront
 * entry still hits this Lambda. Without this in-Lambda cache, every cold
 * miss does a full directory Scan + in-memory sort (the heaviest endpoint
 * we have). With it, the second request from a CloudFront miss within 30s
 * reuses the in-memory result and skips the Scan entirely.
 *
 * Cache key combines all parameters that change the response (sort,
 * search, includeInactive, page, pageSize). The serialized JSON makes
 * collisions impossible at the cost of one stringify per request — fine.
 */
interface CachedListEntry {
  body: ListResponseBody;
  expiresAt: number;
}
interface ListResponseBody {
  items: DRepDirectoryItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
const _listCache = new Map<string, CachedListEntry>();
const LIST_CACHE_TTL_MS = 30_000;

/** Test-only escape hatch — same convention as `_resetCurrentDrepCache`
 *  in `lib/recognition.ts`. Lets the test harness reset the module-level
 *  cache between cases so a cached response from a prior test doesn't
 *  short-circuit the Query mock. Not exported as part of the public API
 *  contract — production callers should never need to invalidate. */
export function _resetListCache(): void {
  _listCache.clear();
}
/** Bound the cache. Each entry holds up to `pageSize` (≤100) items, and
 *  the typical hot-set is at most a few sort/search permutations × pages.
 *  Over the cap we drop the oldest entry. */
const LIST_CACHE_MAX_ENTRIES = 50;

type SortKey = 'power' | 'delegators' | 'recent' | 'name';

function parseSort(raw: string | undefined): SortKey {
  if (raw === 'delegators' || raw === 'recent' || raw === 'name') return raw;
  return 'power';
}

/** Parse the `?includeInactive=` flag. Truthy values: `true`, `1`, `yes`. */
function parseTruthy(raw: string | undefined): boolean {
  if (raw == null) return false;
  const v = raw.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

/** Parse `?page=` — non-negative integer, default 0. Returns 0 for any
 *  malformed input (including negatives) rather than failing the request. */
function parsePage(raw: string | undefined): number {
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

/** Parse `?pageSize=` (or legacy `?limit=`). Default 25, capped at 100. */
function parsePageSize(rawPageSize: string | undefined, rawLimit: string | undefined): number {
  const raw = rawPageSize ?? rawLimit;
  if (!raw) return DEFAULT_PAGE_SIZE;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(n, MAX_PAGE_SIZE);
}

/** Sort comparator factory. All sorts are stable on `drepId` to keep
 *  pagination reproducible across requests. */
function makeComparator(sort: SortKey): (a: DRepDirectoryItem, b: DRepDirectoryItem) => number {
  switch (sort) {
    case 'name': {
      // Alphabetical asc; unnamed DReps tilde-padded to sort last.
      return (a, b) => {
        const ka = nameSortKey(a);
        const kb = nameSortKey(b);
        if (ka < kb) return -1;
        if (ka > kb) return 1;
        return a.drepId < b.drepId ? -1 : a.drepId > b.drepId ? 1 : 0;
      };
    }
    case 'recent': {
      // Most-recent vote desc; never-voted (`undefined`) sorts last.
      return (a, b) => {
        const ta = a.lastVotedAt as string | undefined;
        const tb = b.lastVotedAt as string | undefined;
        if (ta && tb) {
          if (ta > tb) return -1;
          if (ta < tb) return 1;
        } else if (ta) return -1;
        else if (tb) return 1;
        return a.drepId < b.drepId ? -1 : a.drepId > b.drepId ? 1 : 0;
      };
    }
    case 'delegators': {
      // Delegator count desc. Missing counts (most rows — the directory
      // sync defers per-DRep delegator fetches) fall to the end.
      return (a, b) => {
        const da = typeof a.delegatorCount === 'number' ? a.delegatorCount : -1;
        const db = typeof b.delegatorCount === 'number' ? b.delegatorCount : -1;
        if (da !== db) return db - da;
        return a.drepId < b.drepId ? -1 : a.drepId > b.drepId ? 1 : 0;
      };
    }
    case 'power':
    default: {
      // Voting power desc — compare BigInt to avoid Number precision loss
      // past 2^53 lovelace. Malformed amounts (rare) compare as zero.
      return (a, b) => {
        const va = safeBigInt(a.votingPower);
        const vb = safeBigInt(b.votingPower);
        if (va !== vb) return va > vb ? -1 : 1;
        return a.drepId < b.drepId ? -1 : a.drepId > b.drepId ? 1 : 0;
      };
    }
  }
}

function safeBigInt(s: string | undefined | null): bigint {
  if (typeof s !== 'string' || s.length === 0) return 0n;
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}

/** Lowercased givenName when present; otherwise tilde-prefixed drepId
 *  so unnamed entries land after all letters in ASCII order. */
function nameSortKey(item: DRepDirectoryItem): string {
  const name = (item.givenName as string | undefined)?.trim();
  if (name && name.length > 0) return name.toLowerCase();
  return `~${item.drepId}`;
}

/** Build the DynamoDB FilterExpression / ExpressionAttributeNames /
 *  ExpressionAttributeValues for the active/retired/search filter applied
 *  on top of the `entityType-votingPower-index` Query.
 *
 *  **Migration note (2026-05-26):** the read path switched from Scan to
 *  Query against a new sparse GSI partitioned on `entityType='DREP_PROFILE'`.
 *  The GSI is by definition PROFILE-only (POWER history rows don't carry
 *  the partition-key attribute), so the previous `SK = 'PROFILE'` filter
 *  is no longer needed — DynamoDB only ever returns PROFILE rows. The
 *  surviving filter conditions handle the user-toggleable concerns:
 *  active-only and name search. Exported for unit tests. */
export function buildDirectoryListFilter(opts: {
  includeInactive: boolean;
  search: string | undefined;
}): {
  /** Empty string when no filter is needed (default view with no search).
   *  Callers must skip passing `filterExpression` to Query in that case —
   *  DynamoDB rejects an empty FilterExpression. */
  filterExpression: string;
  expressionAttributeNames: Record<string, string>;
  expressionAttributeValues: Record<string, unknown>;
} {
  const conditions: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};

  if (!opts.includeInactive) {
    // Default view: hide both inactive AND retired DReps. Predefined
    // DReps (`drep_always_abstain`, `drep_always_no_confidence`) carry
    // `isActive=true` and `isRetired=false` from the sync, so they
    // surface in this view — which is the desired behavior: they hold
    // ~9B ADA of voting power and should appear in the default list.
    //
    // We do NOT use `attribute_not_exists(isRetired)` because rows synced
    // before enrichmentVersion 3 didn't carry the field — they were all
    // implicitly registered. Pre-v3 rows have `isRetired` absent, which
    // we treat as `false` (the v2 sync filtered out non-registered).
    conditions.push('#isActive = :true');
    conditions.push('(attribute_not_exists(#isRetired) OR #isRetired = :false)');
    names['#isActive'] = 'isActive';
    names['#isRetired'] = 'isRetired';
    values[':true'] = true;
    values[':false'] = false;
  }
  if (opts.search) {
    conditions.push('contains(#givenNameLower, :q)');
    names['#givenNameLower'] = 'givenNameLower';
    values[':q'] = opts.search.toLowerCase();
  }
  return {
    filterExpression: conditions.join(' AND '),
    expressionAttributeNames: names,
    expressionAttributeValues: values,
  };
}

/** Query every PROFILE row via the sparse `entityType-votingPower-index`
 *  GSI. Returns the full matching set — callers sort and slice in memory.
 *
 *  The Query partitions on `entityType='DREP_PROFILE'` (one logical
 *  partition holding only the 1623-ish PROFILE rows; POWER history rows
 *  are excluded automatically because they don't carry the attribute).
 *  Filter conditions are applied AFTER the Query reads the items, so the
 *  filter ordering doesn't affect read-capacity cost — DynamoDB bills for
 *  every item examined, but on this GSI "items examined" equals "PROFILE
 *  rows," which is the same as the matching set in the broad case. */
async function queryAllMatching(opts: {
  includeInactive: boolean;
  search: string | undefined;
}): Promise<DRepDirectoryItem[]> {
  const filter = buildDirectoryListFilter(opts);
  const accumulated: DRepDirectoryItem[] = [];
  let cursor: Record<string, unknown> | undefined;
  for (let round = 0; round < MAX_QUERY_ROUNDS; round++) {
    const page = await queryItems<DRepDirectoryItem>(tableNames.drepDirectory, {
      indexName: ENTITY_TYPE_GSI_NAME,
      keyConditionExpression: '#et = :entityType',
      expressionAttributeNames: {
        '#et': 'entityType',
        ...filter.expressionAttributeNames,
      },
      expressionAttributeValues: {
        ':entityType': ENTITY_TYPE_PROFILE,
        ...filter.expressionAttributeValues,
      },
      // Filter only applied when there's actually something to filter on —
      // an empty FilterExpression is rejected by DynamoDB.
      ...(filter.filterExpression
        ? { filterExpression: filter.filterExpression }
        : {}),
      // We always sort in memory below for non-`power` sorts; for `power`
      // the GSI sort key (`votingPowerSort`) already orders the rows. We
      // re-sort regardless so the comparator-driven path stays uniform
      // across sort modes — the cost is a microsecond per request.
      ...(cursor ? { exclusiveStartKey: cursor } : {}),
    });
    accumulated.push(...page.items);
    if (!page.lastEvaluatedKey) break;
    cursor = page.lastEvaluatedKey;
  }
  if (accumulated.length >= MAX_QUERY_ROUNDS * 1000) {
    // Loud signal that we've grown past the buffer headroom — would only
    // trip if PROFILE count exceeds 10k. Bump `MAX_QUERY_ROUNDS` at that
    // point or move to keyset pagination at the handler boundary.
    console.warn(
      `directory/list: hit MAX_QUERY_ROUNDS (${MAX_QUERY_ROUNDS}) — accumulator may be incomplete (${accumulated.length} rows)`,
    );
  }
  return accumulated;
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  // Same Cache-Control on every code path so CloudFront edge can cache
  // even a cache-hit Lambda response.
  const cacheHeaders = { 'Cache-Control': 'public, max-age=30, s-maxage=30' };

  try {
    const qs = event.queryStringParameters ?? {};
    const sort = parseSort(qs['sort']);
    const includeInactive = parseTruthy(qs['includeInactive']) || parseTruthy(qs['includeRetired']);
    const search = qs['search']?.trim() || undefined;
    const pageSize = parsePageSize(qs['pageSize'], qs['limit']);
    const page = parsePage(qs['page']);
    // Legacy `?lastKey=<base64>` from the pre-page-numbers UI is silently
    // ignored — the response shape no longer carries `lastEvaluatedKey`,
    // and we'd have no way to translate a DynamoDB cursor to a page
    // number anyway. Old clients will land on page 0 and re-paginate.

    // Module-level cache check. We have to clamp `page` against `totalPages`,
    // and that depends on a Scan result we don't have yet — so we cache by
    // the *requested* parameters, not the clamped ones. A request for
    // page=99 vs page=4 (where totalPages=5) results in identical responses
    // but different cache keys; tolerable, the entries are small.
    const cacheKey = JSON.stringify({ sort, search, includeInactive, page, pageSize });
    const cached = _listCache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return ok(cached.body, cacheHeaders);
    }

    const allMatching = await queryAllMatching({ includeInactive, search });
    const comparator = makeComparator(sort);
    allMatching.sort(comparator);
    const total = allMatching.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    // Clamp page to valid range — easier than 400-erroring a stale URL.
    // If the caller asks for page 99 and we only have 5, return page 4
    // (last page) rather than an empty result with confusing pagination.
    const clampedPage = Math.min(page, totalPages - 1);
    const start = clampedPage * pageSize;
    const end = start + pageSize;
    const items = allMatching.slice(start, end);

    const body: ListResponseBody = {
      items,
      total,
      page: clampedPage,
      pageSize,
      totalPages,
    };

    // Insert into cache. Evict oldest if over cap (Map preserves insertion
    // order — the first key is the oldest).
    _listCache.set(cacheKey, { body, expiresAt: now + LIST_CACHE_TTL_MS });
    if (_listCache.size > LIST_CACHE_MAX_ENTRIES) {
      const oldestKey = _listCache.keys().next().value;
      if (oldestKey !== undefined) _listCache.delete(oldestKey);
    }

    return ok(body, cacheHeaders);
  } catch (err) {
    console.error('directory/list handler error:', err);
    return internalError('Failed to list DRep directory');
  }
};
