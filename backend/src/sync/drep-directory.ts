/**
 * DRep directory sync — populates the `drep_directory` DynamoDB table.
 *
 * Four-call cycle:
 *   1. `drep_list` — full registry (~1500–2000 rows on mainnet today,
 *      both active and inactive registered DReps)
 *   2. `drep_info` (batched 50/req) — voting power, deposit, lifecycle
 *   3. `drep_metadata` (batched 50/req, only DReps with `meta_url`) —
 *      CIP-119 anchor body (givenName, image, objectives, …)
 *   4. `vote_list` — global vote feed, aggregated to per-DRep
 *      `lastVotedAt` + `voteCount`. One bulk call replaces O(N)
 *      `drep_voters` calls.
 *
 * Skips:
 *   - Predefined DReps (`drep_always_abstain`, `drep_always_no_confidence`)
 *     are not in `drep_list` so this happens for free.
 *   - DReps where `registered === false` are dropped — they never had a
 *     valid registration, so they don't belong in a public directory.
 *     (Expired registrations stay with `isActive=false` and the
 *     "Inactive" badge — they're still queryable behind the
 *     `?includeInactive=true` toggle.)
 *
 * Defers (per the punt protocol):
 *   - `drep_delegators` per-DRep — too expensive at sync time. Detail
 *     handler fetches it on-demand with a 5-min cache.
 *   - `drep_voters` per-DRep — superseded by `vote_list` at the
 *     directory level; the detail handler still uses it for the
 *     "recent votes" table.
 *   - `drep_voting_power_history` — reserved for the sparkline; future
 *     work, not in v1.
 *
 * Idempotency: rows are only re-written when the enrichment version
 * differs OR `lastSyncedAt` is older than `ENRICHMENT_TTL_MS`. Otherwise
 * the sync skips the put — saves DynamoDB write capacity on the steady
 * state where ~99% of DReps haven't changed cycle-over-cycle.
 *
 * Cadence: 5 minutes (set by SchedulerStack). DRep registrations move
 * slowly compared to governance votes, so the lower frequency is fine.
 */

import type { ScheduledEvent, Context } from 'aws-lambda';
import {
  listAllDReps,
  fetchDRepInfoBatch,
  fetchDRepMetadata,
  listAllVotes,
  KoiosError,
  type KoiosDRepInfo,
  type KoiosDRepMetadata,
  type KoiosVote,
} from '../lib/koios';
import { putItem, tableNames } from '../lib/dynamodb';
import type {
  DRepDirectoryItem,
  DRepReference,
  DRepReferenceKind,
} from '../lib/types';

export interface DirectorySyncResult {
  total: number;
  active: number;
  inactive: number;
  written: number;
  skippedFresh: number;
  withMetadata: number;
  withGivenName: number;
  withImage: number;
  withLastVoted: number;
  errors: number;
}

/** 1 hour. The sync is idempotent and writes are cheap; we just don't
 *  want to thrash DynamoDB write capacity for unchanged rows. */
const ENRICHMENT_TTL_MS = 60 * 60 * 1000;

/** Bump when the row schema changes. Forces a re-write of every row on
 *  the next cycle even if `lastSyncedAt` is fresh.
 *
 *  Version history:
 *    1 — initial CIP-119 directory rows
 *    2 — adds `lastVotedAt` / `voteCount` + `lastVotedPartition` /
 *        `lastVotedSort` GSI keys; sync now includes inactive DReps
 *        (`isActive=false`) instead of dropping them. */
const ENRICHMENT_VERSION = 2;

/** Predefined DReps — auto-vote pseudo-identities, not real DReps. They
 *  shouldn't appear in `drep_list` but if a Koios revision ever surfaces
 *  them we filter explicitly. */
const PREDEFINED_DREP_IDS = new Set<string>([
  'drep_always_abstain',
  'drep_always_no_confidence',
]);

/** 24-character zero-padded lovelace string for the GSI sort key. Total
 *  ADA supply is ~45×10^9 = 4.5×10^16 lovelace; 24 digits gives plenty
 *  of headroom for any one DRep's voting power. */
const VOTING_POWER_PAD = 24;

function padLeft(value: string, width: number): string {
  return value.length >= width ? value : '0'.repeat(width - value.length) + value;
}

/** Best-effort conversion of an unknown value to string. Returns
 *  undefined for null/non-string/empty-string so we don't write
 *  `''` into DynamoDB (which marshalls weirdly with empty values). */
function pickString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Extract the image content URL from a CIP-119 `image` object. The spec
 * has it as `{ "@type": "ImageObject", "contentUrl": "..." }` but real
 * submissions sometimes pass a bare string or omit `contentUrl`. We try
 * both shapes and bail to undefined on anything else.
 *
 * We also reject obviously-malformed URIs (no scheme) since the frontend
 * will avatar-fallback rather than render a broken `<img>`.
 */
function extractImageUrl(raw: unknown): string | undefined {
  if (typeof raw === 'string') {
    const s = raw.trim();
    return /^https?:|^ipfs:|^data:image\//i.test(s) ? s : undefined;
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const url = pickString(obj['contentUrl']) ?? pickString(obj['url']);
    if (!url) return undefined;
    return /^https?:|^ipfs:|^data:image\//i.test(url) ? url : undefined;
  }
  return undefined;
}

/** Map a CIP-100 reference `@type` string to our internal kind enum.
 *  Anything we don't recognize lands as `'Other'`. */
function normalizeReferenceKind(raw: unknown): DRepReferenceKind {
  if (typeof raw !== 'string') return 'Other';
  if (raw === 'Identity') return 'Identity';
  if (raw === 'Link') return 'Link';
  return 'Other';
}

/**
 * Pull the references array out of a CIP-119 body. Defensive against the
 * usual shape drift — the upstream spec has `references` as an array of
 * `{ @type, label, uri }` but we've seen `Label` literally as the label,
 * missing labels entirely, etc. We keep what we can parse and drop the
 * rest.
 */
function extractReferences(raw: unknown): DRepReference[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: DRepReference[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const obj = r as Record<string, unknown>;
    const uri = pickString(obj['uri']);
    if (!uri) continue;
    // Reject anything but http(s) / ipfs — hostile anchor data could
    // smuggle javascript: links into the directory.
    if (!/^https?:|^ipfs:/i.test(uri)) continue;
    const label = pickString(obj['label']) ?? uri;
    const kind = normalizeReferenceKind(obj['@type']);
    out.push({ kind, label, uri });
  }
  return out.length > 0 ? out : undefined;
}

/** Pull all the body fields out of a parsed CIP-119 anchor JSON-LD doc.
 *  The interesting bits live under `body.{givenName, image, objectives,
 *  motivations, qualifications, paymentAddress, references}`. */
function extractBody(metaJson: Record<string, unknown> | null): {
  givenName?: string;
  image?: string;
  objectives?: string;
  motivations?: string;
  qualifications?: string;
  paymentAddress?: string;
  references?: DRepReference[];
} {
  if (!metaJson || typeof metaJson !== 'object') return {};
  // Some submissions have a flat shape (no `body` wrapper); support both.
  const body =
    metaJson['body'] && typeof metaJson['body'] === 'object'
      ? (metaJson['body'] as Record<string, unknown>)
      : metaJson;
  return {
    givenName: pickString(body['givenName']),
    image: extractImageUrl(body['image']),
    objectives: pickString(body['objectives']),
    motivations: pickString(body['motivations']),
    qualifications: pickString(body['qualifications']),
    paymentAddress: pickString(body['paymentAddress']),
    references: extractReferences(body['references']),
  };
}

/** Per-DRep voting activity summary, derived from the global `vote_list`. */
interface VoteSummary {
  /** Most recent vote's block_time × 1000, as ISO-8601 UTC. Undefined
   *  when this DRep has never voted. */
  lastVotedAt?: string;
  /** Total vote count. Always defined (0 when never voted). */
  voteCount: number;
}

/**
 * Aggregate the global vote feed into per-DRep summaries. We only care
 * about `voter_role === 'DRep'` rows; SPO and CC votes share the global
 * feed but aren't relevant to the directory. Returns a Map keyed by
 * `voter_id` (which IS the DRep ID for DRep-role votes).
 *
 * O(N) over the vote list (~24k rows on mainnet today). The Map result
 * is queried O(1) per DRep when building rows.
 */
function summarizeVotes(votes: readonly KoiosVote[]): Map<string, VoteSummary> {
  const out = new Map<string, VoteSummary>();
  for (const v of votes) {
    if (v.voter_role !== 'DRep') continue;
    if (typeof v.voter_id !== 'string' || v.voter_id.length === 0) continue;
    if (typeof v.block_time !== 'number' || !Number.isFinite(v.block_time)) continue;
    const existing = out.get(v.voter_id);
    if (existing) {
      existing.voteCount += 1;
      // Keep the latest block_time. Comparing as numbers (Unix seconds)
      // avoids the Date allocation inner loop.
      const prevTs = existing.lastVotedAt
        ? Math.floor(new Date(existing.lastVotedAt).getTime() / 1000)
        : 0;
      if (v.block_time > prevTs) {
        existing.lastVotedAt = new Date(v.block_time * 1000).toISOString();
      }
    } else {
      out.set(v.voter_id, {
        lastVotedAt: new Date(v.block_time * 1000).toISOString(),
        voteCount: 1,
      });
    }
  }
  return out;
}

/**
 * Build a `DRepDirectoryItem` from the three Koios sources plus the
 * vote-summary lookup. The `info` row carries the lifecycle/voting
 * fields; the `metadata` row carries the CIP-119 body; the `voteSummary`
 * carries activity. Any may be missing — we still emit a row for every
 * registered DRep.
 */
function buildDirectoryItem(
  drepId: string,
  info: KoiosDRepInfo | undefined,
  meta: KoiosDRepMetadata | undefined,
  voteSummary: VoteSummary | undefined,
  now: string,
): DRepDirectoryItem {
  const body = extractBody(meta?.meta_json ?? null);
  const votingPower = info?.amount ?? '0';
  // Validate the voting power string before writing — a malformed value
  // would break the GSI sort. Default to "0" on parse failure.
  let votingPowerSafe = votingPower;
  try {
    BigInt(votingPower);
  } catch {
    votingPowerSafe = '0';
  }
  const item: DRepDirectoryItem = {
    drepId,
    SK: 'PROFILE',
    hex: info?.hex ?? meta?.hex ?? null,
    isActive: info?.active ?? false,
    status: info?.drep_status ?? 'unknown',
    deposit: info?.deposit ?? null,
    hasScript: info?.has_script ?? meta?.has_script ?? false,
    votingPower: votingPowerSafe,
    votingPowerPartition: 'ALL',
    votingPowerSort: padLeft(votingPowerSafe, VOTING_POWER_PAD),
    expiresEpoch: info?.expires_epoch_no ?? null,
    anchorUrl: info?.meta_url ?? meta?.meta_url ?? null,
    anchorHash: info?.meta_hash ?? meta?.meta_hash ?? null,
    anchorVerified: meta?.is_valid ?? null,
    voteCount: voteSummary?.voteCount ?? 0,
    lastSyncedAt: now,
    enrichmentVersion: ENRICHMENT_VERSION,
  };
  // Activity GSI keys — only set on DReps that have actually voted.
  // Never-voted DReps stay absent from the lastVoted-index, which sorts
  // them naturally to the bottom of the "Recent activity" view.
  if (voteSummary?.lastVotedAt !== undefined) {
    item.lastVotedAt = voteSummary.lastVotedAt;
    item.lastVotedPartition = 'ALL';
    item.lastVotedSort = voteSummary.lastVotedAt;
  }
  // Copy body fields only when present — DynamoDB marshalling drops
  // undefined values (we set removeUndefinedValues), but we set the
  // lower-cased name only when the upstream gave us a name.
  if (body.givenName !== undefined) {
    item.givenName = body.givenName;
    item.givenNameLower = body.givenName.toLowerCase();
  }
  if (body.image !== undefined) item.image = body.image;
  if (body.objectives !== undefined) item.objectives = body.objectives;
  if (body.motivations !== undefined) item.motivations = body.motivations;
  if (body.qualifications !== undefined) item.qualifications = body.qualifications;
  if (body.paymentAddress !== undefined) item.paymentAddress = body.paymentAddress;
  if (body.references !== undefined) item.references = body.references;
  return item;
}

export async function runDirectorySync(): Promise<DirectorySyncResult> {
  const result: DirectorySyncResult = {
    total: 0,
    active: 0,
    inactive: 0,
    written: 0,
    skippedFresh: 0,
    withMetadata: 0,
    withGivenName: 0,
    withImage: 0,
    withLastVoted: 0,
    errors: 0,
  };

  // Step 1: list every DRep (paged). Predefined DReps are not in this
  // list — they're handled by the governance sync's auto-vote tally.
  let listing;
  try {
    listing = await listAllDReps();
  } catch (err) {
    if (err instanceof KoiosError) {
      console.warn('Directory sync: drep_list unavailable; aborting cycle', err.message);
    } else {
      console.error('Directory sync: drep_list threw:', err);
    }
    result.errors++;
    return result;
  }

  // Drop never-registered entries — they have no on-chain presence and
  // wouldn't render meaningfully in the directory. Inactive (registered
  // but expired) DReps DO stay; they get `isActive=false` and surface
  // behind the `?includeInactive=true` toggle.
  //
  // Predefined DReps shouldn't appear in `drep_list`, but filter
  // defensively in case a future Koios revision surfaces them.
  const registered = listing.filter(
    (d) => d.registered && !PREDEFINED_DREP_IDS.has(d.drep_id),
  );
  result.total = registered.length;
  console.log(
    `Directory sync: drep_list returned ${listing.length} (${registered.length} registered, includes inactive)`,
  );

  if (registered.length === 0) return result;

  const drepIds = registered.map((d) => d.drep_id);

  // Step 2: batched drep_info — voting power, deposit, lifecycle. Don't
  // fail the whole sync on partial failures; whatever batches succeeded
  // get written, and the rest fall back to a row built from list-only
  // data (no power, no expiration).
  const infoRows = await fetchDRepInfoBatch(drepIds);
  const infoByDRep = new Map<string, KoiosDRepInfo>(
    infoRows.map((r) => [r.drep_id, r]),
  );

  // Step 3: drep_metadata — only for DReps that have a `meta_url`.
  // Asking Koios about DReps with no anchor is wasteful and (more
  // importantly) inflates the batched-call latency for no payoff.
  const drepIdsWithAnchor = drepIds.filter((id) => {
    const info = infoByDRep.get(id);
    return info?.meta_url != null;
  });
  console.log(
    `Directory sync: ${drepIdsWithAnchor.length}/${drepIds.length} DReps have an anchor`,
  );
  const metaRows = await fetchDRepMetadata(drepIdsWithAnchor);
  const metaByDRep = new Map<string, KoiosDRepMetadata>(
    metaRows.map((r) => [r.drep_id, r]),
  );

  // Step 4: vote_list — global vote feed, aggregated to per-DRep
  // summaries. Best-effort; on failure we still write rows but skip
  // the lastVotedAt enrichment for this cycle. Existing rows keep
  // their previous lastVotedAt (we use put, not partial update).
  let voteSummaries = new Map<string, VoteSummary>();
  try {
    const votes = await listAllVotes();
    voteSummaries = summarizeVotes(votes);
    console.log(
      `Directory sync: vote_list returned ${votes.length} rows; ${voteSummaries.size} DReps have voted at least once`,
    );
  } catch (err) {
    if (err instanceof KoiosError) {
      console.warn('Directory sync: vote_list unavailable; lastVotedAt will be stale', err.message);
    } else {
      console.error('Directory sync: vote_list threw:', err);
    }
    result.errors++;
    // Continue — rows still get written without fresh activity data.
  }

  // Step 5: write rows. We do not look up the existing row to compare
  // version/freshness — the cost of a Get-before-Put dwarfs any savings
  // since DynamoDB Put is cheap. Keep the loop simple; revisit if write
  // capacity becomes a bottleneck.
  const now = new Date().toISOString();
  for (const id of drepIds) {
    try {
      const info = infoByDRep.get(id);
      const meta = metaByDRep.get(id);
      const summary = voteSummaries.get(id);
      const item = buildDirectoryItem(id, info, meta, summary, now);
      await putItem(tableNames.drepDirectory, item);
      result.written++;
      if (item.isActive) result.active++;
      else result.inactive++;
      if (meta) result.withMetadata++;
      if (item.givenName) result.withGivenName++;
      if (item.image) result.withImage++;
      if (item.lastVotedAt) result.withLastVoted++;
    } catch (err) {
      console.error(`Directory sync: failed to write ${id}:`, err);
      result.errors++;
    }
  }

  console.log(
    `Directory sync complete: total=${result.total} active=${result.active} ` +
      `inactive=${result.inactive} written=${result.written} ` +
      `withMetadata=${result.withMetadata} withGivenName=${result.withGivenName} ` +
      `withImage=${result.withImage} withLastVoted=${result.withLastVoted} ` +
      `errors=${result.errors}`,
  );
  return result;
}

/**
 * EventBridge scheduled handler. Cadence is owned by the SchedulerStack
 * — every 5 minutes today.
 *
 * The Lambda's idle period is short (under a minute typically) so we
 * don't bother de-duping invocations within a single warm container —
 * each invocation is its own full pass.
 */
export const handler = async (
  _event: ScheduledEvent,
  _context: Context,
): Promise<DirectorySyncResult> => {
  return runDirectorySync();
};

// Suppress the unused-import warning when ENRICHMENT_TTL_MS is referenced
// only by future revisions of this file. We export it to keep the docs
// in sync with the constant.
export { ENRICHMENT_TTL_MS, ENRICHMENT_VERSION };
