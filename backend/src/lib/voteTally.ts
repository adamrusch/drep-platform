/**
 * Vote-tally builder. Combines raw on-chain votes with global active-voter
 * lookups to produce the per-role tally exposed to the frontend, including
 * the all-important `notVoted` slice — the fraction of total active voting
 * power that hasn't yet cast a vote on this action.
 *
 * Why this lives separately from blockfrost.ts:
 *   - The math is shared between the Koios fast-path and the Blockfrost
 *     fallback in the sync.
 *   - It's pure (no I/O); easy to unit-test in isolation.
 *   - Predefined-DRep and per-action-type special cases (NoConfidence on
 *     SPOs is "abstain by default", No-Confidence-yes on always-no-confidence,
 *     etc.) are non-trivial enough to deserve their own module.
 */
import type { BlockfrostProposalVote } from './blockfrost';
import type {
  GovernanceActionType,
  VoteRoleTally,
  VoteSlice,
  VoteTally,
} from './types';

// ---- Predefined DRep IDs ----
//
// Cardano governance defines two synthetic DRep "addresses" that any stake
// account can delegate to as a standing auto-vote:
//   - drep_always_abstain: counts as Abstain on every action
//   - drep_always_no_confidence: counts as YES on NoConfidence actions
//     (the delegator wants to remove the committee) and as NO on every
//     other action (they distrust the proposer).
// Their voting power is fetched via Koios's drep_info endpoint.

export const DREP_ALWAYS_ABSTAIN = 'drep_always_abstain';
export const DREP_ALWAYS_NO_CONFIDENCE = 'drep_always_no_confidence';

// ---- Lookups passed in by the sync ----

/**
 * Inputs the tally builder needs from the global active-voter lookups.
 * Any field can be omitted — when the upstream lookup failed, we still
 * compute as much of the tally as we can from the data we have. A missing
 * lookup means `notVoted` for that role is reported as zero (rather than
 * lying about a denominator we don't know).
 */
export interface TallyLookups {
  /** drep_id → voting power in lovelace. Excludes predefined DReps. */
  drepPower?: ReadonlyMap<string, bigint>;
  /** pool_id_bech32 → active stake in lovelace. */
  poolStake?: ReadonlyMap<string, bigint>;
  /** Active CC member hot IDs. */
  committeeIds?: ReadonlySet<string>;
  /** Voting power delegated to drep_always_abstain. Auto-vote across all actions. */
  alwaysAbstainPower?: bigint;
  /** Voting power delegated to drep_always_no_confidence. Auto-vote across
   *  all actions, but the "direction" depends on the action type. */
  alwaysNoConfidencePower?: bigint;
}

// ---- Helpers ----

function emptySlice(): VoteSlice {
  return { count: 0, power: '0' };
}

function emptyRole(): { yes: bigint; no: bigint; abstain: bigint } & {
  yesCount: number;
  noCount: number;
  abstainCount: number;
} {
  return {
    yes: 0n,
    no: 0n,
    abstain: 0n,
    yesCount: 0,
    noCount: 0,
    abstainCount: 0,
  };
}

function buildRoleTally(
  role: ReturnType<typeof emptyRole>,
  totalActiveCount: number,
  totalActivePower: bigint,
): VoteRoleTally {
  const yes: VoteSlice = { count: role.yesCount, power: role.yes.toString() };
  const no: VoteSlice = { count: role.noCount, power: role.no.toString() };
  const abstain: VoteSlice = {
    count: role.abstainCount,
    power: role.abstain.toString(),
  };
  // notVoted = totalActive minus everyone who cast a vote of any kind.
  // Floor at zero — if the cast-vote sum somehow exceeds totalActive
  // (stale lookups vs. fresh votes mid-snapshot), we'd rather report
  // "no remaining" than a negative number that breaks the UI.
  const castCount = role.yesCount + role.noCount + role.abstainCount;
  const castPower = role.yes + role.no + role.abstain;
  const notVotedCount = Math.max(0, totalActiveCount - castCount);
  const notVotedPowerBig =
    totalActivePower > castPower ? totalActivePower - castPower : 0n;
  const notVoted: VoteSlice = {
    count: notVotedCount,
    power: notVotedPowerBig.toString(),
  };
  const totalActive: VoteSlice = {
    count: totalActiveCount,
    power: totalActivePower.toString(),
  };
  return { yes, no, abstain, notVoted, totalActive };
}

/**
 * Empty tally — every slice zeroed. Used as a graceful fallback when the
 * sync couldn't fetch the active-voter lookups for a cycle. The frontend
 * still renders the four labels (Yes / No / Abstain / Not Voted) with zero
 * percentages, which is the right "no data yet" state.
 */
export function emptyTally(): VoteTally {
  const empty: VoteRoleTally = {
    yes: emptySlice(),
    no: emptySlice(),
    abstain: emptySlice(),
    notVoted: emptySlice(),
    totalActive: emptySlice(),
  };
  return { drep: empty, spo: empty, cc: empty };
}

// ---- Public API ----

/**
 * Build a full VoteTally (with notVoted + totalActive) from raw on-chain
 * votes and the active-voter lookups.
 *
 * Predefined DReps:
 *   - alwaysAbstainPower is added to drep.abstain on every action.
 *   - alwaysNoConfidencePower is added to drep.yes on NoConfidence actions
 *     and to drep.no on every other action.
 *   These auto-votes only contribute to `power` — there are no voter
 *   "headcounts" because the predefined DReps aggregate stake from many
 *   delegators. This matches how the existing UI talks about voting power:
 *   power is the rigorous denominator; count is illustrative.
 *
 * SPOs on NoConfidence:
 *   Per CIP-1694, SPOs that haven't explicitly voted on a NoConfidence
 *   action are treated as abstaining (NOT as no-voters). We compute the
 *   raw notVoted counts as before — the frontend can decide whether to
 *   relabel the slice for display, and the API consumer gets the truth.
 *   We do NOT silently fold notVoted into abstain here; that conflates
 *   two distinct on-chain facts and is harder to undo than to add later.
 *
 * `actionType` is currently used only as a hint for predefined-DRep
 *   directionality (NoConfidence flips drep_always_no_confidence to "yes").
 *   The slot is kept so the frontend can render per-action display rules
 *   without re-deriving them from the tally.
 */
export function tallyVotesWithPower(
  votes: readonly BlockfrostProposalVote[],
  totals: {
    totalDrepCount: number;
    totalDrepPower: bigint;
    totalPoolCount: number;
    totalPoolPower: bigint;
    totalCcCount: number;
    /** CC has no per-voter weighting on mainnet today; power tracks count. */
    totalCcPower: bigint;
  },
  lookups: TallyLookups,
  actionType: GovernanceActionType,
): VoteTally {
  const drep = emptyRole();
  const spo = emptyRole();
  const cc = emptyRole();

  for (const v of votes) {
    const bucket =
      v.voter_role === 'drep' ? drep : v.voter_role === 'spo' ? spo : cc;
    let power: bigint;
    if (v.voter_role === 'drep') {
      power = lookups.drepPower?.get(v.voter) ?? 0n;
    } else if (v.voter_role === 'spo') {
      power = lookups.poolStake?.get(v.voter) ?? 0n;
    } else {
      // CC: every member counts as 1 unit of power. We deliberately do
      // NOT cross-check against `committeeIds` here — Blockfrost reports
      // CC voters under the `cc_hot_id` they signed with, but the field
      // format (bech32 vs. hex vs. credential-prefixed) varies between
      // Blockfrost's vote endpoint and Koios's `committee_info`. Gating
      // on Set membership silently drops every CC vote when the formats
      // disagree. Blockfrost has already validated the voter is on-chain
      // by the time the vote record reaches us, so trusting the role tag
      // is the right move. Rotated-out members can no longer cast votes.
      power = 1n;
    }
    if (v.vote === 'yes') {
      bucket.yes += power;
      bucket.yesCount += 1;
    } else if (v.vote === 'no') {
      bucket.no += power;
      bucket.noCount += 1;
    } else if (v.vote === 'abstain') {
      bucket.abstain += power;
      bucket.abstainCount += 1;
    }
  }

  // ---- Predefined-DRep auto-votes ----
  // These contribute power but no headcount (delegators-as-individuals
  // don't appear in vote records).
  if (lookups.alwaysAbstainPower && lookups.alwaysAbstainPower > 0n) {
    drep.abstain += lookups.alwaysAbstainPower;
  }
  if (lookups.alwaysNoConfidencePower && lookups.alwaysNoConfidencePower > 0n) {
    if (actionType === 'NoConfidence') {
      drep.yes += lookups.alwaysNoConfidencePower;
    } else {
      drep.no += lookups.alwaysNoConfidencePower;
    }
  }

  return {
    drep: buildRoleTally(drep, totals.totalDrepCount, totals.totalDrepPower),
    spo: buildRoleTally(spo, totals.totalPoolCount, totals.totalPoolPower),
    cc: buildRoleTally(cc, totals.totalCcCount, totals.totalCcPower),
  };
}
