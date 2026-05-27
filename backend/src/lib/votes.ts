/**
 * Per-action vote listing — reads the `governance_votes` table for one
 * governance action, joins each row against the cached `drep_directory`
 * for the voter's display name + historical voting power, and joins SPO
 * and CC voter rows against their respective name-cache tables. Applies
 * the "supersede" dedupe rule.
 *
 * # Supersede rule
 *
 * Cardano allows a DRep (and any voter) to recast their vote on the same
 * action — the on-chain ledger keeps only the most recent vote per
 * (voter_id, action_id) tuple as authoritative. The UI wants to show the
 * full audit trail (so a delegator can see "my DRep changed their mind"),
 * but only the most recent vote per voter is "live"; earlier votes are
 * superseded and rendered with strikethrough.
 *
 * `markSupersededVotes` is a pure function over the persisted row shape.
 * Tested in `votes.test.ts`.
 *
 * # Voting power at time of vote (DRep voters)
 *
 * The `drep-voting-power-history` sync writes per-epoch POWER#{epoch}
 * rows under each DRep's partition in `drep_directory`. For each vote
 * cast in epoch N by a DRep, we look up `POWER#${padded N}` and use
 * that snapshot — true point-in-time power at the moment the vote
 * landed.
 *
 * Fallback when no POWER row exists for the vote's epoch (vote
 * pre-dates the daily sync's earliest snapshot, or a sync gap left
 * that epoch empty): we use the DRep's CURRENT `votingPower` from the
 * PROFILE row and set `votingPowerIsApprox: true` so the frontend can
 * surface that caveat (asterisk + tooltip).
 *
 * Both lookups happen in ONE `batchGetItems` call — we collect both the
 * PROFILE key and every (drepId, POWER#epoch) key the page references
 * and submit them together. The helper handles the 100-key BatchGet
 * cap internally via chunking; we don't need to chunk here.
 *
 * SPO / CC voters: no power lookup is attempted (the directory table
 * only covers DReps); power is left undefined and the row renders
 * without it.
 *
 * # Voter display names (SPO + CC)
 *
 * SPO voter rows are joined against the `pool_metadata` cache (populated
 * daily from Koios `/pool_metadata`); when the pool has a registered
 * ticker / name they surface as `poolTicker` / `poolName`.
 *
 * CC voter rows are joined against the `cc_members` cache (refreshed
 * once per epoch from Koios `/committee_info`); the CC member's
 * `ccName` is surfaced when available.
 *
 * In both cases the lookup is best-effort — a cache miss falls back to
 * the truncated bech32 the frontend already renders.
 */
import { batchGetItems, queryItems, tableNames } from './dynamodb';
import { getPoolNamesBulk, getCCMemberNamesBulk } from './recognition';
import type { DRepDirectoryItem } from './types';

/** Epoch number zero-pad width — must match `drep-voting-power-history.ts`'s
 *  `EPOCH_PAD` constant (6) so the SK we look up matches what the sync
 *  wrote. Drift would silently lose every historical lookup. */
const EPOCH_PAD = 6;

function padEpoch(n: number): string {
  const s = String(n);
  return s.length >= EPOCH_PAD ? s : '0'.repeat(EPOCH_PAD - s.length) + s;
}

/** Shape of a `POWER#{epoch}` history row in `drep_directory`. Mirrors
 *  `DRepPowerHistoryItem` from `./types` but kept local to keep the
 *  read path's expected shape obvious next to the BatchGet that
 *  produces it. The index signature is required so `batchGetItems`'s
 *  generic type constraint (`Record<string, unknown>`) accepts it. */
interface PowerHistoryRow {
  drepId: string;
  SK: string;
  epochNo: number;
  /** Stringified BigInt lovelace. */
  amount: string;
  capturedAt?: string;
  [key: string]: unknown;
}

/**
 * One persisted row in `governance_votes`, as written by
 * `sync/governance-intake.ts` Phase C.
 */
export interface GovernanceVoteItem {
  actionId: string;
  voteKey: string;
  voterRole: string;
  voterId: string;
  /** Verbatim from Koios — `'Yes' | 'No' | 'Abstain'`. */
  vote: string;
  /** ISO-8601 timestamp of the vote (derived from `block_time`). */
  votedAt: string;
  /** Unix seconds — same value as `votedAt`, kept numeric for sorting. */
  blockTime: number;
  epochNo: number;
  voteTxHash: string;
  /** CIP-100 anchor URL the voter attached to this vote (rationale). */
  metaUrl?: string;
  metaHash?: string;
  ingestedAt?: string;
  [key: string]: unknown;
}

/** Voter role tag — matches the Koios surface. The frontend renders the
 *  three groups under separate headers. */
export type VoteVoterRole = 'DRep' | 'SPO' | 'ConstitutionalCommittee';

/** Single vote row returned by the API. The frontend renders one card per
 *  entry; `superseded === true` rows get the strikethrough treatment. */
export interface ActionVoteRecord {
  voterRole: VoteVoterRole;
  voterId: string;
  /** Resolved DRep display name from the directory cache. Undefined for
   *  DReps without a `givenName` in their CIP-119 anchor. SPO voters fall
   *  back to `poolName` / `poolTicker`; CC voters to `ccName`. */
  voterDisplayName?: string;
  /** Voting power at the moment of the vote, in lovelace as stringified
   *  BigInt. For DRep voters we look up `drep_directory[drepId].POWER#${
   *  vote.epochNo}` to get the true historical snapshot. When that row
   *  is missing (vote pre-dates the daily history sync, or sync gap) we
   *  fall back to the DRep's CURRENT `votingPower` and set
   *  `votingPowerIsApprox: true` so the frontend can mark the value with
   *  an asterisk. Undefined for SPO / CC voters (the directory only
   *  covers DReps) and for DReps not in the directory cache. */
  votingPowerLovelace?: string;
  /** True when `votingPowerLovelace` is the voter's CURRENT power because
   *  no per-epoch snapshot was available for this vote's epoch. Undefined
   *  / absent when the value is the true historical snapshot (or when no
   *  power was resolved at all). The frontend renders an asterisk and a
   *  "current power; historical snapshot unavailable" tooltip. */
  votingPowerIsApprox?: boolean;
  /** SPO voter only — registered pool ticker from the `pool_metadata`
   *  cache. Undefined for non-SPO voters and when the pool has no
   *  registered metadata. */
  poolTicker?: string;
  /** SPO voter only — registered pool name from the `pool_metadata`
   *  cache. Undefined for non-SPO voters and when the pool has no
   *  registered metadata. */
  poolName?: string;
  /** Constitutional Committee voter only — CC member name from the
   *  `cc_members` cache. Undefined for non-CC voters and when the CC
   *  hot credential isn't in the cache yet. */
  ccName?: string;
  vote: 'Yes' | 'No' | 'Abstain';
  votedAt: string;
  blockTime: number;
  voteTxHash: string;
  /** CIP-100 anchor URL the voter posted with this vote (the rationale). */
  rationaleUrl?: string;
  /** True when a later vote by the same voter superseded this one. */
  superseded: boolean;
}

/**
 * Pure helper: mark older votes as `superseded`, keeping only the most
 * recent vote per (voterRole, voterId) tuple as live. Input is expected
 * to be the raw persisted rows for ONE action (any order). Output is the
 * same rows, sorted newest-first by `blockTime`, with the `superseded`
 * flag set on every row except the latest per voter.
 *
 * Tie-break on identical `blockTime`: lexicographic `voteTxHash` desc.
 * Practically impossible in production (two votes in the same block from
 * the same voter would be a ledger anomaly) but tests pin the behaviour.
 *
 * Why this lives separately from the handler: the dedupe rule is pure
 * and worth testing in isolation. The handler just composes I/O around it.
 */
export function markSupersededVotes(
  rows: readonly GovernanceVoteItem[],
): GovernanceVoteItem[] {
  // Sort newest first; tie-break on voteTxHash desc for determinism.
  const sorted = [...rows].sort((a, b) => {
    if (b.blockTime !== a.blockTime) return b.blockTime - a.blockTime;
    return b.voteTxHash.localeCompare(a.voteTxHash);
  });
  const seen = new Set<string>();
  const out: GovernanceVoteItem[] = [];
  for (const r of sorted) {
    const key = `${r.voterRole}#${r.voterId}`;
    const superseded = seen.has(key);
    if (!superseded) seen.add(key);
    out.push({ ...r, superseded });
  }
  return out;
}

/** Narrow the verbatim Koios `vote` field to the closed UI enum. Rows
 *  with unrecognized values are dropped by the caller. */
function normalizeVoteLabel(v: string): 'Yes' | 'No' | 'Abstain' | null {
  switch (v) {
    case 'Yes':
      return 'Yes';
    case 'No':
      return 'No';
    case 'Abstain':
      return 'Abstain';
    default:
      return null;
  }
}

/** Narrow the verbatim Koios `voter_role` field. Rows with unrecognized
 *  values are dropped by the caller (defensive — db-sync produces stable
 *  labels but the sync runs against an external service). */
function normalizeRoleLabel(v: string): VoteVoterRole | null {
  switch (v) {
    case 'DRep':
      return 'DRep';
    case 'SPO':
      return 'SPO';
    case 'ConstitutionalCommittee':
      return 'ConstitutionalCommittee';
    default:
      return null;
  }
}

/**
 * Fetch every persisted vote for one action, resolve DRep names + current
 * power from the directory cache, apply the supersede dedupe rule, and
 * return a UI-shaped list sorted newest-first.
 *
 * Pagination: Query on `actionId` partition. A single mainnet action sees
 * hundreds of votes today (~500 max observed); well under DynamoDB's 1MB
 * page limit. We paginate defensively in case a very-popular action grows
 * past that.
 */
export async function getVotesForAction(actionId: string): Promise<ActionVoteRecord[]> {
  const rows: GovernanceVoteItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await queryItems<GovernanceVoteItem>(tableNames.governanceVotes, {
      keyConditionExpression: '#pk = :pk',
      expressionAttributeNames: { '#pk': 'actionId' },
      expressionAttributeValues: { ':pk': actionId },
      ...(exclusiveStartKey ? { exclusiveStartKey } : {}),
    });
    rows.push(...page.items);
    exclusiveStartKey = page.lastEvaluatedKey;
  } while (exclusiveStartKey);

  if (rows.length === 0) return [];

  // ---- DRep directory lookups ----
  //
  // We need TWO row types per DRep voter:
  //   1. PROFILE row (`SK='PROFILE'`) — for the display name (givenName)
  //      and the fallback `votingPower` when no historical snapshot is
  //      available for the vote's epoch.
  //   2. POWER#{padded epoch} row — the true historical voting-power
  //      snapshot for the epoch in which the vote was cast.
  //
  // Both are partitioned on `drepId`, so we collect ALL the keys (PROFILE
  // for every unique DRep + POWER for every unique (drepId, epoch) tuple
  // a vote references) and submit them in a single BatchGet. The
  // `batchGetItems` helper internally chunks at the DDB 100-key cap and
  // retries unprocessed keys, so we don't need to chunk again here even
  // when an action attracts 1000+ votes from distinct DReps.
  //
  // Tradeoff: this adds at most N extra keys per page (where N = unique
  // (drepId, epoch) tuples) over the previous PROFILE-only path. At
  // current mainnet volume (~500 votes/action max) that's well under the
  // first BatchGet chunk; only pathologically-attended actions would
  // span more than one BatchGet call.
  const drepIds = Array.from(
    new Set(rows.filter((r) => r.voterRole === 'DRep').map((r) => r.voterId)),
  );
  // (drepId, epoch) tuples for the POWER lookups — deduped so that a
  // DRep who cast and recast in the same epoch contributes one key.
  const powerKeySeen = new Set<string>();
  const powerKeys: Array<{ drepId: string; SK: string }> = [];
  for (const r of rows) {
    if (r.voterRole !== 'DRep') continue;
    if (typeof r.epochNo !== 'number' || !Number.isFinite(r.epochNo)) continue;
    const sk = `POWER#${padEpoch(r.epochNo)}`;
    const dedupeKey = `${r.voterId}#${sk}`;
    if (powerKeySeen.has(dedupeKey)) continue;
    powerKeySeen.add(dedupeKey);
    powerKeys.push({ drepId: r.voterId, SK: sk });
  }

  const drepLookup = new Map<string, DRepDirectoryItem>();
  // Power lookup keyed by `${drepId}#${epochNo}` (numeric epoch — NOT
  // padded SK — so the read path can build the key from the row's raw
  // `epochNo` without re-padding).
  const powerLookup = new Map<string, string>();
  if (drepIds.length > 0) {
    try {
      const profileKeys = drepIds.map((drepId) => ({ drepId, SK: 'PROFILE' }));
      // Single BatchGet covering BOTH row types. The helper chunks at
      // 100-key boundaries internally, so a 700-key call (e.g. 350 DReps
      // × 1 PROFILE + 1 POWER each) becomes 7 sequential BatchGet calls
      // with automatic unprocessed-key retries.
      const items = await batchGetItems<DRepDirectoryItem | PowerHistoryRow>(
        tableNames.drepDirectory,
        [...profileKeys, ...powerKeys],
      );
      for (const it of items) {
        if (it.SK === 'PROFILE') {
          drepLookup.set(it.drepId, it as DRepDirectoryItem);
        } else if (typeof it.SK === 'string' && it.SK.startsWith('POWER#')) {
          const powerRow = it as PowerHistoryRow;
          // Use numeric epochNo for the key — that's what the read loop
          // below already has from the raw vote row.
          if (typeof powerRow.epochNo === 'number') {
            powerLookup.set(`${powerRow.drepId}#${powerRow.epochNo}`, powerRow.amount);
          }
        }
      }
    } catch (err) {
      // Directory lookup is best-effort — a transient miss should not nuke
      // the whole votes tab. Frontend will render rows without names or
      // power.
      console.warn(`getVotesForAction: directory lookup failed for ${actionId}:`, err);
    }
  }

  // ---- SPO + CC name lookups ----
  //
  // SPO voters: bech32 `pool1...` — joined against the `pool_metadata`
  // cache for ticker + name. CC voters: bech32 `cc_hot...` — joined
  // against the `cc_members` cache for display name. Both lookups are
  // best-effort (cache miss = no name; the frontend renders truncated
  // bech32). The helpers handle their own DDB caching and chunking.
  const poolIds = Array.from(
    new Set(rows.filter((r) => r.voterRole === 'SPO').map((r) => r.voterId)),
  );
  const ccHotCreds = Array.from(
    new Set(
      rows.filter((r) => r.voterRole === 'ConstitutionalCommittee').map((r) => r.voterId),
    ),
  );
  const poolNamePromise = getPoolNamesBulk(poolIds);
  const ccNamePromise = getCCMemberNamesBulk(ccHotCreds);
  const [poolNames, ccNames] = await Promise.all([poolNamePromise, ccNamePromise]);

  const deduped = markSupersededVotes(rows);

  const out: ActionVoteRecord[] = [];
  for (const r of deduped) {
    const role = normalizeRoleLabel(r.voterRole);
    const vote = normalizeVoteLabel(r.vote);
    if (!role || !vote) continue;
    const record: ActionVoteRecord = {
      voterRole: role,
      voterId: r.voterId,
      vote,
      votedAt: r.votedAt,
      blockTime: r.blockTime,
      voteTxHash: r.voteTxHash,
      superseded: r.superseded === true,
    };
    if (r.metaUrl) record.rationaleUrl = r.metaUrl;

    if (role === 'DRep') {
      const directory = drepLookup.get(r.voterId);
      if (directory?.givenName) record.voterDisplayName = directory.givenName;
      // Prefer the historical POWER snapshot for the vote's epoch; fall
      // back to the PROFILE row's CURRENT power with an isApprox flag.
      const historicalPower =
        typeof r.epochNo === 'number' && Number.isFinite(r.epochNo)
          ? powerLookup.get(`${r.voterId}#${r.epochNo}`)
          : undefined;
      if (historicalPower !== undefined) {
        record.votingPowerLovelace = historicalPower;
        // No isApprox flag — this is the true snapshot.
      } else if (directory?.votingPower) {
        record.votingPowerLovelace = directory.votingPower;
        record.votingPowerIsApprox = true;
      }
    } else if (role === 'SPO') {
      const meta = poolNames.get(r.voterId);
      if (meta?.ticker) record.poolTicker = meta.ticker;
      if (meta?.name) record.poolName = meta.name;
      // Frontend uses poolTicker + poolName to render; voterDisplayName
      // stays undefined for SPOs to keep the data shape clean.
    } else if (role === 'ConstitutionalCommittee') {
      const name = ccNames.get(r.voterId);
      if (name) record.ccName = name;
    }
    out.push(record);
  }
  return out;
}
