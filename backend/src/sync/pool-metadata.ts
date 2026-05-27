/**
 * Pool-metadata sync — populates the `pool_metadata` DDB cache from
 * Koios's `/pool_list` + `/pool_metadata`.
 *
 * # Why this sync exists
 *
 * SPO voters surface on the per-action Votes tab as bech32 `pool1...`
 * strings by default — opaque to anyone who doesn't recognize the hash.
 * Koios returns each pool's registered ticker on `/pool_list` and the
 * full off-chain metadata (name, homepage, description) on
 * `/pool_metadata`. We cache both into a single table so the votes
 * read path can join SPO rows to human-readable identifiers in one
 * BatchGet without a Koios round-trip per request.
 *
 * # Cadence
 *
 * Daily. Pool registrations and metadata change rarely (operators
 * occasionally update their ticker / homepage, but the rate is on the
 * order of dozens per day across mainnet's ~6000+ pools). A 24-hour
 * staleness window is fine.
 *
 * # Cost
 *
 * ~6500 pool IDs on mainnet today × 1 `/pool_list` (paginated 1000/page,
 * ~7 calls) + ~6500 / 50 ≈ 130 `/pool_metadata` batch calls = ~140
 * Koios calls per cycle. Well under the anonymous-tier 10 RPS limit
 * (we pace with sequential calls, ~30 min wall-clock — fits the
 * 10-minute Lambda timeout once we break into the lane pattern, but
 * sequential is simpler and we have no SLA on this cache).
 *
 * Steady-state WCU: the compare-then-write idempotency path means a
 * quiet day writes zero rows. First cycle backfills ~6500 rows (~6500
 * WCU = pennies on PAY_PER_REQUEST).
 *
 * # Idempotency
 *
 * BatchGet existing rows, build the candidate, write only when the
 * candidate's payload differs (`ticker`, `name`, `homepage`,
 * `description`). `lastSyncedAt` is touched only when something
 * actually changed — avoids spurious writes for cache-only
 * fields.
 *
 * # Row shape
 *
 * | Field           | Type | Role                                             |
 * |-----------------|------|--------------------------------------------------|
 * | `poolId`        | S    | PK — bech32 `pool1...`                           |
 * | `ticker`        | S    | Pool ticker (e.g. "ADA"); undefined when unset   |
 * | `name`          | S    | Off-chain pool name; undefined when unset        |
 * | `description`   | S    | Off-chain description; undefined when unset      |
 * | `homepage`      | S    | Off-chain homepage URL; undefined when unset     |
 * | `metaUrl`       | S    | On-chain anchor URL the metadata came from       |
 * | `lastSyncedAt`  | S    | ISO-8601 of the cycle that wrote/refreshed this  |
 *
 * # Failure modes
 *
 * Total-cycle failure is reported via the result counters; the
 * EventBridge target ignores them and the next day's cycle picks up
 * what was missed. Per-batch failures inside `/pool_metadata` are
 * isolated by the Koios helper — one bad batch logs and the rest
 * continue.
 */

import type { ScheduledEvent, Context } from 'aws-lambda';
import {
  listAllPools,
  fetchPoolMetadata,
  KoiosError,
  type KoiosPool,
  type KoiosPoolMetadata,
} from '../lib/koios';
import { batchGetItems, putItem, tableNames } from '../lib/dynamodb';

/** Row shape persisted to `pool_metadata`. Keep this in sync with the
 *  reader in `recognition.ts`. */
export interface PoolMetadataItem {
  poolId: string;
  ticker?: string;
  name?: string;
  description?: string;
  homepage?: string;
  metaUrl?: string;
  lastSyncedAt: string;
  [key: string]: unknown;
}

export interface PoolMetadataSyncResult {
  totalPools: number;
  poolsWithMetadata: number;
  rowsWritten: number;
  rowsSkipped: number;
  errors: number;
}

/** Trim + reject empty strings. DynamoDB marshals `undefined` away
 *  cleanly (we set `removeUndefinedValues`), but `''` would persist as
 *  an empty string. */
function pickString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Build the persisted row from the listing + metadata sources. The
 * listing carries the bech32 ID + ticker (when set on-chain); the
 * metadata body carries name / description / homepage when the pool
 * has registered an anchor.
 *
 * Both `metaUrl` and `ticker` can come from either source — `meta_url`
 * is on the metadata row, but a pool can have an on-chain ticker
 * without registering off-chain metadata, so we prefer the listing
 * ticker when set.
 */
export function buildPoolMetadataItem(
  listing: KoiosPool,
  meta: KoiosPoolMetadata | undefined,
  now: string,
): PoolMetadataItem {
  const item: PoolMetadataItem = {
    poolId: listing.pool_id_bech32,
    lastSyncedAt: now,
  };
  // Ticker: prefer the on-chain `ticker` from the listing (always
  // populated when set), fall back to `meta_json.ticker` if the listing
  // is blank but the off-chain body has one.
  const ticker = pickString(listing.ticker) ?? pickString(meta?.meta_json?.['ticker']);
  if (ticker) item.ticker = ticker;
  const name = pickString(meta?.meta_json?.['name']);
  if (name) item.name = name;
  const description = pickString(meta?.meta_json?.['description']);
  if (description) item.description = description;
  const homepage = pickString(meta?.meta_json?.['homepage']);
  if (homepage) item.homepage = homepage;
  const metaUrl = pickString(meta?.meta_url);
  if (metaUrl) item.metaUrl = metaUrl;
  return item;
}

/**
 * Deep-equality check ignoring `lastSyncedAt`. Returns true when a Put
 * would be a no-op from the caller's point of view. Matches the
 * pattern from `drep-directory.ts` — kept local because the row shape
 * is tiny and we don't want to pull in a generic helper for one use.
 */
function itemsEqualIgnoringSync(a: PoolMetadataItem, b: PoolMetadataItem): boolean {
  return canonicalize(a) === canonicalize(b);
}

function canonicalize(item: PoolMetadataItem): string {
  return JSON.stringify(item, (key, value) => {
    if (key === 'lastSyncedAt') return undefined;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return value;
  });
}

export async function runPoolMetadataSync(): Promise<PoolMetadataSyncResult> {
  const result: PoolMetadataSyncResult = {
    totalPools: 0,
    poolsWithMetadata: 0,
    rowsWritten: 0,
    rowsSkipped: 0,
    errors: 0,
  };

  // Step 1: enumerate every registered pool. Retired-but-still-listed
  // pools are kept too — they may have cast historical votes whose
  // metadata we still want to surface on the Votes tab.
  let listing: KoiosPool[];
  try {
    listing = await listAllPools();
  } catch (err) {
    if (err instanceof KoiosError) {
      console.warn('Pool-metadata sync: pool_list unavailable; aborting cycle', err.message);
    } else {
      console.error('Pool-metadata sync: pool_list threw:', err);
    }
    result.errors = 1;
    return result;
  }
  result.totalPools = listing.length;
  if (listing.length === 0) {
    console.log('Pool-metadata sync: pool_list empty; nothing to do');
    return result;
  }

  // Step 2: bulk-fetch metadata for every pool. `fetchPoolMetadata`
  // batches at 50/req and isolates per-batch failures internally —
  // whatever succeeded comes back, the rest just lack a row in the
  // result map. Pools that registered no metadata at all (~30% of
  // mainnet today) are also absent from the response — that's the
  // normal case, not an error.
  const allPoolIds = listing.map((p) => p.pool_id_bech32);
  const metaRows = await fetchPoolMetadata(allPoolIds);
  const metaByPool = new Map<string, KoiosPoolMetadata>(
    metaRows.map((r) => [r.pool_id_bech32, r]),
  );
  result.poolsWithMetadata = metaByPool.size;
  console.log(
    `Pool-metadata sync: pool_list=${listing.length} pool_metadata=${metaRows.length}`,
  );

  // Step 3: BatchGet existing rows so we can compare-then-write. Same
  // idempotency pattern as the DRep directory sync — a quiet day's
  // re-sync writes zero rows once the cache is warm.
  const existingRows = await batchGetItems<PoolMetadataItem>(
    tableNames.poolMetadata,
    allPoolIds.map((poolId) => ({ poolId })),
  );
  const existingByPool = new Map<string, PoolMetadataItem>(
    existingRows.map((r) => [r.poolId, r]),
  );

  // Step 4: build candidate rows and Put when something genuinely
  // differs. Empty rows (no ticker, no name, no description, no
  // homepage) are still written — they tell the read path "we've seen
  // this pool, it just has no human-readable identifiers" so the
  // BatchGet hit succeeds and the caller doesn't think the row is
  // missing.
  const now = new Date().toISOString();
  for (const listingRow of listing) {
    try {
      const meta = metaByPool.get(listingRow.pool_id_bech32);
      const candidate = buildPoolMetadataItem(listingRow, meta, now);
      const existing = existingByPool.get(listingRow.pool_id_bech32);
      if (existing && itemsEqualIgnoringSync(existing, candidate)) {
        result.rowsSkipped++;
        continue;
      }
      await putItem(tableNames.poolMetadata, candidate);
      result.rowsWritten++;
    } catch (err) {
      console.error(
        `Pool-metadata sync: failed to write ${listingRow.pool_id_bech32}:`,
        err,
      );
      result.errors++;
    }
  }

  console.log(
    `Pool-metadata sync complete: totalPools=${result.totalPools} ` +
      `withMetadata=${result.poolsWithMetadata} ` +
      `rowsWritten=${result.rowsWritten} rowsSkipped=${result.rowsSkipped} ` +
      `errors=${result.errors}`,
  );
  return result;
}

/**
 * EventBridge scheduled handler. Cadence owned by SchedulerStack —
 * daily. See file header for rationale.
 */
export const handler = async (
  _event: ScheduledEvent,
  _context: Context,
): Promise<PoolMetadataSyncResult> => {
  return runPoolMetadataSync();
};
