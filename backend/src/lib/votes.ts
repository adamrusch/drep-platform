/**
 * Per-action vote listing — reads the `governance_votes` table for one
 * governance action, joins each row against the cached `drep_directory`
 * for the voter's display name + current voting power, and applies the
 * "supersede" dedupe rule.
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
 * # Voting power at time of vote
 *
 * The persisted row carries only the vote certificate fields (no power).
 * Koios's `/vote_list` doesn't include voter power either, and we'd need
 * a per-vote `/drep_history?epoch_no=N` lookup to reconstruct true point-
 * in-time power — too expensive at scale.
 *
 * We surface the voter's CURRENT voting power from the `drep_directory`
 * cache and label it accordingly on the frontend. SPO / CC voters: no
 * power lookup is attempted (the directory table only covers DReps);
 * power is left undefined and the row renders without it.
 *
 * TODO(historical-power): if we ever capture per-epoch DRep voting power
 * (the `drep-voting-power-history` sync already does this on a daily
 * cadence — see `backend/src/sync/drep-voting-power-history.ts`), wire
 * that into `getVotesForAction` here to surface power-at-vote-epoch
 * instead of current power.
 */
import { batchGetItems, queryItems, tableNames } from './dynamodb';
import type { DRepDirectoryItem } from './types';

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
   *  DReps without a `givenName` in their CIP-119 anchor, and for SPO / CC
   *  voters (we don't maintain a name lookup for those today). */
  voterDisplayName?: string;
  /** Current voting power in lovelace as a stringified BigInt. Undefined
   *  when we can't resolve it (SPO / CC voters; DReps not in directory
   *  cache; directory lookup failed). See module header for the
   *  "current vs. at-time-of-vote" caveat. */
  votingPowerLovelace?: string;
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

  // Resolve DRep names + power in one BatchGetItem call. SPO / CC voters
  // aren't in the directory and stay unresolved (the UI renders the raw
  // voter ID for those, which is the right behaviour today — we don't
  // maintain a name lookup for SPOs or committee members).
  const drepIds = Array.from(
    new Set(rows.filter((r) => r.voterRole === 'DRep').map((r) => r.voterId)),
  );
  const drepLookup = new Map<string, DRepDirectoryItem>();
  if (drepIds.length > 0) {
    try {
      const items = await batchGetItems<DRepDirectoryItem>(
        tableNames.drepDirectory,
        drepIds.map((drepId) => ({ drepId, SK: 'PROFILE' })),
      );
      for (const it of items) {
        drepLookup.set(it.drepId, it);
      }
    } catch (err) {
      // Directory lookup is best-effort — a transient miss should not nuke
      // the whole votes tab. Frontend will render rows without names.
      console.warn(`getVotesForAction: directory lookup failed for ${actionId}:`, err);
    }
  }

  const deduped = markSupersededVotes(rows);

  const out: ActionVoteRecord[] = [];
  for (const r of deduped) {
    const role = normalizeRoleLabel(r.voterRole);
    const vote = normalizeVoteLabel(r.vote);
    if (!role || !vote) continue;
    const directory = role === 'DRep' ? drepLookup.get(r.voterId) : undefined;
    out.push({
      voterRole: role,
      voterId: r.voterId,
      ...(directory?.givenName ? { voterDisplayName: directory.givenName } : {}),
      ...(directory?.votingPower ? { votingPowerLovelace: directory.votingPower } : {}),
      vote,
      votedAt: r.votedAt,
      blockTime: r.blockTime,
      voteTxHash: r.voteTxHash,
      ...(r.metaUrl ? { rationaleUrl: r.metaUrl } : {}),
      superseded: r.superseded === true,
    });
  }
  return out;
}
