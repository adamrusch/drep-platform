/**
 * DRep directory sync — populates the `drep_directory` DynamoDB table.
 *
 * Four-call cycle:
 *   1. `drep_list` — full registry (~1500–2000 rows on mainnet today,
 *      both active and inactive AND retired DReps)
 *   2. `drep_info` (batched 50/req) — voting power, deposit, lifecycle
 *   3. `drep_metadata` (batched 50/req, only DReps with `meta_url`) —
 *      CIP-119 anchor body (givenName, image, objectives, …)
 *   4. `vote_list` — global vote feed, aggregated to per-DRep
 *      `lastVotedAt` + `voteCount`. One bulk call replaces O(N)
 *      `drep_voters` calls.
 *
 * Injects:
 *   - Predefined DReps (`drep_always_abstain`, `drep_always_no_confidence`)
 *     are NOT in `drep_list` but are first-class Cardano governance
 *     participants — Abstain alone holds ~9B ADA of voting power. The
 *     sync fetches `drep_info` for them separately and synthesizes
 *     PROFILE rows with hard-coded display names and `isPredefined=true`.
 *     See `buildPredefinedDirectoryItem` and the `enrichmentVersion=4`
 *     migration note.
 *
 * Lifecycle states (all written to the directory):
 *   - `registered: true` AND `active: true` → fully active. `isActive=true`,
 *     `isRetired=false`. Surfaces by default.
 *   - `registered: true` AND `active: false` → inactive (no vote in
 *     ~drepActivity epochs). `isActive=false`, `isRetired=false`. Surfaces
 *     behind the `?includeInactive=true` toggle.
 *   - `registered: false` → retired (filed a retirement certificate).
 *     `isActive=false`, `isRetired=true`, `votingPower="0"` (regardless of
 *     what `drep_info` reports — retired DReps cannot vote). Historical
 *     `givenName`, anchor metadata, and `voteCount` / `lastVotedAt` are
 *     preserved so the historical activity remains browsable. Surfaces
 *     behind the `?includeInactive=true` toggle (retired and inactive
 *     are merged into one toggle for UX simplicity — see
 *     `handlers/directory/list.ts` for the rationale).
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
 * Idempotency: every cycle BatchGets the existing rows, builds the
 * candidate row from upstream data, and only PutItems when the candidate
 * differs from the existing row (ignoring `lastSyncedAt`). On a quiet
 * cycle this writes zero rows — saves the 38k+ WCU/hour the previous
 * Put-every-row implementation was burning on `drep_directory`. BatchGet
 * costs ~800 RRU/cycle (negligible) so the read pass is essentially
 * free. `lastSyncedAt` is no longer touched just to record "we ran" —
 * the freshness signal is `enrichmentVersion` matching the current code.
 *
 * Cadence: 30 minutes (set by SchedulerStack). DRep registrations /
 * retirements move slowly, and the user-visible "Last Voted" timestamps
 * come from the governance sync's 1-min cadence anyway. Bumped from 5
 * min as part of a cost fix — see the SchedulerStack comments.
 */

import type { ScheduledEvent, Context } from 'aws-lambda';
import {
  listAllDReps,
  fetchDRepInfoBatch,
  fetchDRepMetadata,
  listAllVotes,
  KoiosError,
  type KoiosDRepInfo,
  type KoiosDRepListEntry,
  type KoiosDRepMetadata,
  type KoiosVote,
} from '../lib/koios';
export const PREDEFINED_DREP_DISPLAY_NAMES: Record<string, string> = {
  drep_always_abstain: 'Always Abstain',
  drep_always_no_confidence: 'Always No-Confidence',
};
import { putItem, batchGetItems, tableNames } from '../lib/dynamodb';
import type {
  DRepDirectoryItem,
  DRepReference,
  DRepReferenceKind,
} from '../lib/types';

export interface DirectorySyncResult {
  total: number;
  active: number;
  inactive: number;
  retired: number;
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
 *        (`isActive=false`) instead of dropping them.
 *    3 — sync now includes retired DReps (`registered=false`) with
 *        `isRetired=true`, `votingPower="0"`, `isActive=false`. Historical
 *        anchor metadata and vote activity are preserved. Also forces
 *        re-sync after the `vote_list` pagination fix that pulls many
 *        more votes (raising `voteCount` for long-tail DReps that were
 *        previously stuck at 0).
 *    4 — adds `entityType='DREP_PROFILE'` (sparse-GSI partition key for
 *        the new `entityType-votingPower-index`, which replaces the
 *        Scan-with-FilterExpression read path that was missing DReps
 *        once POWER row growth exceeded the Scan's raw-item ceiling).
 *        Also injects the two predefined DReps (`drep_always_abstain`,
 *        `drep_always_no_confidence`) as synthesized PROFILE rows with
 *        `isPredefined=true` and hard-coded display names — they hold
 *        ~9B ADA of voting power between them but don't appear in
 *        `drep_list`, so the previous sync silently dropped them. */
const ENRICHMENT_VERSION = 4;

/** Predefined DReps — auto-vote pseudo-identities. They don't appear in
 *  Koios's `drep_list` (it only returns registered DReps), so the
 *  directory sync fetches their `drep_info` separately and synthesizes
 *  PROFILE rows for them (see `buildPredefinedDirectoryItem`). They
 *  hold massive voting power (`drep_always_abstain` ≈ 9B ADA today) so
 *  surfacing them in the directory is essential for the user to see the
 *  full Cardano governance landscape. We also filter the set out of
 *  `drep_list` defensively in case a future Koios revision starts
 *  returning them mixed in — the synthesized rows are the canonical
 *  source. */
const PREDEFINED_DREP_IDS = ['drep_always_abstain', 'drep_always_no_confidence'] as const;
const PREDEFINED_DREP_ID_SET = new Set<string>(PREDEFINED_DREP_IDS);

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
 * DRep in `drep_list`, including retired ones.
 *
 * Retired DReps (`registered === false` in the listing OR
 * `drep_status === 'retired'` in info) are forced to `isActive=false`
 * and `votingPower="0"`. The historical anchor metadata + voteCount /
 * lastVotedAt are preserved so the user can browse who they were and
 * what they voted on while active. The `isRetired=true` flag lets the
 * frontend render a distinct "Retired" badge.
 */
function buildDirectoryItem(
  drepId: string,
  listingEntry: KoiosDRepListEntry,
  info: KoiosDRepInfo | undefined,
  meta: KoiosDRepMetadata | undefined,
  voteSummary: VoteSummary | undefined,
  now: string,
): DRepDirectoryItem {
  const body = extractBody(meta?.meta_json ?? null);
  // Retirement status: `registered=false` in `drep_list` is the canonical
  // signal (a retirement certificate has been processed). `drep_info`
  // typically carries `drep_status='retired'` for the same row, but the
  // listing flag is the primary source of truth — it's set even when
  // `drep_info` hasn't been re-indexed yet.
  const isRetired = !listingEntry.registered || info?.drep_status === 'retired';
  const rawVotingPower = info?.amount ?? '0';
  // Validate the voting power string before writing — a malformed value
  // would break the GSI sort. Default to "0" on parse failure.
  let votingPowerSafe = rawVotingPower;
  try {
    BigInt(rawVotingPower);
  } catch {
    votingPowerSafe = '0';
  }
  // Retired DReps have no voting weight, regardless of what `drep_info`
  // last reported. Pin to "0" so sorts and ratification math don't
  // accidentally count them.
  if (isRetired) votingPowerSafe = '0';
  // `isActive` requires both lifecycle flags: the registration must be
  // live AND the DRep must have voted recently enough not to be
  // auto-marked inactive. Retired DReps are forced inactive.
  const isActive = !isRetired && (info?.active ?? false);
  const item: DRepDirectoryItem = {
    drepId,
    SK: 'PROFILE',
    // Sparse-GSI partition key. Present on every PROFILE row so the new
    // `entityType-votingPower-index` GSI returns them all in a single
    // Query, bypassing the table-wide Scan that was missing rows once
    // POWER history sub-rows grew past the Scan's raw-item ceiling.
    // POWER rows (`SK='POWER#NNNNNN'`) do NOT carry this attribute —
    // the index is sparse and excludes them automatically.
    entityType: 'DREP_PROFILE',
    hex: info?.hex ?? meta?.hex ?? listingEntry.hex ?? null,
    isActive,
    isRetired,
    status: info?.drep_status ?? (isRetired ? 'retired' : 'unknown'),
    deposit: info?.deposit ?? null,
    hasScript: info?.has_script ?? meta?.has_script ?? listingEntry.has_script ?? false,
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

/**
 * Synthesize a `DRepDirectoryItem` for one of the two predefined Cardano
 * DReps (`drep_always_abstain`, `drep_always_no_confidence`).
 *
 * These are auto-vote pseudo-identities, not registered DReps. They:
 *   - Do NOT appear in Koios's `drep_list` (only registered DReps do).
 *   - DO answer to `/drep_info` directly, which returns their current
 *     delegated voting power.
 *   - Have NO CIP-119 anchor metadata — no name, no image, no objectives.
 *     We hard-code their display names (`givenName`) and lower them for
 *     case-insensitive search.
 *   - Are inherently "active" — they're built-in protocol primitives,
 *     not subject to the drepActivity-based expiration that registered
 *     DReps face. We force `isActive=true`, `isRetired=false`.
 *   - Hold massive voting power on mainnet (Abstain ≈ 9B ADA today).
 *     Excluding them from the directory was hiding the largest voting
 *     blocs in Cardano governance, which is why the user reported
 *     "DReps with the most power are missing."
 *
 * `voteSummary` is included because the protocol effectively casts votes
 * on behalf of these DReps on every governance action, but in practice
 * `/vote_list` does NOT carry rows attributed to them (the auto-vote is
 * computed at ratification time, not recorded as a per-DRep vote event).
 * So `lastVotedAt` / `voteCount` are absent — the row sits at the top
 * of "voting power" sort and at the bottom of "recent activity" sort,
 * which is the right UX.
 */
function buildPredefinedDirectoryItem(
  drepId: string,
  info: KoiosDRepInfo | undefined,
  now: string,
): DRepDirectoryItem {
  const displayName = PREDEFINED_DREP_DISPLAY_NAMES[drepId] ?? drepId;
  const rawVotingPower = info?.amount ?? '0';
  let votingPowerSafe = rawVotingPower;
  try {
    BigInt(rawVotingPower);
  } catch {
    votingPowerSafe = '0';
  }
  const item: DRepDirectoryItem = {
    drepId,
    SK: 'PROFILE',
    entityType: 'DREP_PROFILE',
    hex: info?.hex ?? null,
    isActive: true,
    isRetired: false,
    isPredefined: true,
    // `drep_info` returns a `drep_status` for these (typically "registered")
    // but the conceptually correct status is "predefined" — they are not
    // subject to the same lifecycle as a real DRep. Surface that.
    status: 'predefined',
    deposit: null,
    hasScript: false,
    votingPower: votingPowerSafe,
    votingPowerPartition: 'ALL',
    votingPowerSort: padLeft(votingPowerSafe, VOTING_POWER_PAD),
    expiresEpoch: null,
    anchorUrl: null,
    anchorHash: null,
    anchorVerified: null,
    voteCount: 0,
    givenName: displayName,
    givenNameLower: displayName.toLowerCase(),
    lastSyncedAt: now,
    enrichmentVersion: ENRICHMENT_VERSION,
  };
  return item;
}

export async function runDirectorySync(): Promise<DirectorySyncResult> {
  const result: DirectorySyncResult = {
    total: 0,
    active: 0,
    inactive: 0,
    retired: 0,
    written: 0,
    skippedFresh: 0,
    withMetadata: 0,
    withGivenName: 0,
    withImage: 0,
    withLastVoted: 0,
    errors: 0,
  };

  // Step 1: list every DRep (paged). Predefined DReps are not in this
  // list — they're injected separately in Step 4b / Step 7 below from a
  // direct `drep_info` call on their hardcoded IDs.
  //
  // On `drep_list` failure we continue rather than aborting — the
  // predefined-DRep injection still needs to run so those rows stay
  // present in the directory across Koios outages. We treat the failure
  // as "no registered DReps this cycle" rather than "no sync at all".
  let listing: KoiosDRepListEntry[] = [];
  try {
    listing = await listAllDReps();
  } catch (err) {
    if (err instanceof KoiosError) {
      console.warn('Directory sync: drep_list unavailable; continuing with predefined-only cycle', err.message);
    } else {
      console.error('Directory sync: drep_list threw:', err);
    }
    result.errors++;
  }

  // Keep every DRep in the listing — registered (active + inactive) AND
  // retired. Retired DReps render with a "Retired" badge, votingPower
  // forced to "0", and historical metadata preserved so users can browse
  // who they were and what they voted on. They surface behind the
  // `?includeInactive=true` toggle alongside inactive DReps.
  //
  // Predefined DReps shouldn't appear in `drep_list`, but filter
  // defensively in case a future Koios revision surfaces them.
  const allEntries = listing.filter((d) => !PREDEFINED_DREP_ID_SET.has(d.drep_id));
  const listingByDRep = new Map<string, KoiosDRepListEntry>(
    allEntries.map((d) => [d.drep_id, d]),
  );
  const registeredCount = allEntries.filter((d) => d.registered).length;
  const retiredCount = allEntries.length - registeredCount;
  result.total = allEntries.length;
  console.log(
    `Directory sync: drep_list returned ${listing.length} (${registeredCount} registered, ${retiredCount} retired)`,
  );

  // Note: no early return on `allEntries.length === 0`. Even if the
  // registry is empty (Koios outage, fresh stack) we still want Step 4b
  // / Step 7 to run so the predefined-DRep rows stay present in the
  // directory. The for-loops over `drepIds` below iterate zero times in
  // that case — harmless.
  const drepIds = allEntries.map((d) => d.drep_id);

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

  // Step 4b: fetch `drep_info` for the predefined DReps. They don't
  // appear in `drep_list` (Koios only returns registered DReps there) so
  // we ask for them directly. Failure here doesn't poison the sync — we
  // log and emit synthesized rows with `votingPower="0"` rather than
  // dropping them from the directory entirely. Real Koios behavior: an
  // outage is unusual and the next sync cycle (30 min later) will recover.
  const predefinedInfoRows = await fetchDRepInfoBatch(
    PREDEFINED_DREP_IDS as readonly string[],
  );
  const predefinedInfoByDRep = new Map<string, KoiosDRepInfo>(
    predefinedInfoRows.map((r) => [r.drep_id, r]),
  );
  if (predefinedInfoRows.length < PREDEFINED_DREP_IDS.length) {
    console.warn(
      `Directory sync: drep_info returned ${predefinedInfoRows.length}/${PREDEFINED_DREP_IDS.length} predefined DReps; missing rows will get votingPower='0'`,
    );
  }

  // Step 5: read existing rows in bulk so we can compare-then-write.
  // Previous behavior was to Put every row every cycle; on mainnet that
  // burned ~38k WCU/hour on the directory table for ~zero changes.
  // BatchGet at 0.5 RRU per item is two orders of magnitude cheaper than
  // the wasted PutItem volume — the read pass is essentially free
  // (~800 RRU/cycle) and lets us skip the writes that would have been
  // identical to the existing row. See commit history for the cost-fix
  // rationale and CloudWatch numbers.
  //
  // Include the predefined DRep IDs in the BatchGet so the compare-then-
  // write path applies to them too — saves 2 spurious PutItems per cycle
  // once the rows are in steady state.
  const allDirectoryIds = [...drepIds, ...PREDEFINED_DREP_IDS];
  const existingRows = await batchGetItems<DRepDirectoryItem>(
    tableNames.drepDirectory,
    allDirectoryIds.map((id) => ({ drepId: id, SK: 'PROFILE' })),
  );
  const existingByDRep = new Map<string, DRepDirectoryItem>(
    existingRows.map((r) => [r.drepId, r]),
  );
  console.log(
    `Directory sync: BatchGet returned ${existingRows.length}/${allDirectoryIds.length} existing rows`,
  );

  // Step 6: build candidate rows, compare against existing (ignoring
  // `lastSyncedAt`), Put only when something genuinely differs.
  const now = new Date().toISOString();
  for (const id of drepIds) {
    try {
      const listingEntry = listingByDRep.get(id);
      // Defensive — the loop iterates `drepIds` which were derived from
      // `allEntries`, so this is unreachable in practice. Skip rather
      // than throw if Koios ever returns a malformed listing.
      if (!listingEntry) continue;
      const info = infoByDRep.get(id);
      const meta = metaByDRep.get(id);
      const summary = voteSummaries.get(id);
      const candidate = buildDirectoryItem(id, listingEntry, info, meta, summary, now);
      const existing = existingByDRep.get(id);

      // Stat counters reflect the candidate's lifecycle classification —
      // they're informational and computed regardless of whether we write.
      if (candidate.isRetired) result.retired++;
      else if (candidate.isActive) result.active++;
      else result.inactive++;
      if (meta) result.withMetadata++;
      if (candidate.givenName) result.withGivenName++;
      if (candidate.image) result.withImage++;
      if (candidate.lastVotedAt) result.withLastVoted++;

      if (existing && itemsEqualIgnoringSync(existing, candidate)) {
        // Nothing changed. Skip the Put — do NOT write just to bump
        // `lastSyncedAt`. The freshness signal is implicit: if the row
        // exists with `enrichmentVersion === ENRICHMENT_VERSION`, the
        // sync ran successfully and the data is current.
        result.skippedFresh++;
        continue;
      }

      await putItem(tableNames.drepDirectory, candidate);
      result.written++;
    } catch (err) {
      console.error(`Directory sync: failed to write ${id}:`, err);
      result.errors++;
    }
  }

  // Step 7: write the synthesized predefined-DRep rows through the same
  // compare-then-write path. Counted separately so the active/inactive/
  // retired stats stay tied to the on-chain registered population — these
  // pseudo-DReps don't fit any of those buckets cleanly.
  for (const id of PREDEFINED_DREP_IDS) {
    try {
      const info = predefinedInfoByDRep.get(id);
      const candidate = buildPredefinedDirectoryItem(id, info, now);
      const existing = existingByDRep.get(id);
      result.total++;
      result.active++; // Predefined DReps are always active by definition.
      if (candidate.givenName) result.withGivenName++;
      if (existing && itemsEqualIgnoringSync(existing, candidate)) {
        result.skippedFresh++;
        continue;
      }
      await putItem(tableNames.drepDirectory, candidate);
      result.written++;
    } catch (err) {
      console.error(`Directory sync: failed to write predefined ${id}:`, err);
      result.errors++;
    }
  }

  console.log(
    `Directory sync complete: total=${result.total} active=${result.active} ` +
      `inactive=${result.inactive} retired=${result.retired} written=${result.written} ` +
      `skippedFresh=${result.skippedFresh} ` +
      `withMetadata=${result.withMetadata} withGivenName=${result.withGivenName} ` +
      `withImage=${result.withImage} withLastVoted=${result.withLastVoted} ` +
      `errors=${result.errors}`,
  );
  return result;
}

/**
 * Deep equality between two directory rows, ignoring the volatile
 * `lastSyncedAt` field. Returns true when a Put would be a no-op from the
 * caller's point of view.
 *
 * `enrichmentVersion` is included in the comparison: a version bump in
 * code MUST trigger a Put even if the data fields look identical, since
 * the bump signals a schema migration.
 *
 * Implementation: stringify both sides with `lastSyncedAt` stripped.
 * JSON.stringify is stable for plain objects with the same key insertion
 * order, but DynamoDB unmarshalling can re-order keys, so we sort keys
 * explicitly. The object is small (~20 fields) so this is cheap.
 */
function itemsEqualIgnoringSync(a: DRepDirectoryItem, b: DRepDirectoryItem): boolean {
  return canonicalize(a) === canonicalize(b);
}

function canonicalize(item: DRepDirectoryItem): string {
  return JSON.stringify(item, (key, value) => {
    if (key === 'lastSyncedAt') return undefined;
    // Stable key order for nested objects. References is an array of
    // {kind,label,uri} — array order matters for that field (stable from
    // the source), so we don't sort it.
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
