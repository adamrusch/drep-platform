/**
 * Vote-tally builder. Combines raw on-chain votes with global active-voter
 * lookups to produce the per-role tally exposed to the frontend, with the
 * CIP-1694 ratification math applied correctly.
 *
 * The user-facing correction codified here:
 *
 *   Total Active Voting Stake (the ratification denominator) =
 *     active DRep voting power
 *   + auto-no-confidence delegated stake
 *   − (auto-abstain is REMOVED — it's NOT in active voting stake)
 *
 * CIP-1694 (Pre-defined Voting Options): "If an Ada holder delegates to
 * Abstain, then their stake is actively marked as not participating in
 * governance. The effect of delegating to Abstain on chain is that the
 * delegated stake will not be considered to be a part of the active
 * voting stake."
 *
 * The ratification slice identity that MUST hold exactly (BigInt):
 *
 *   yes.power + no.power + notVoted.power == totalActive.power
 *
 * `abstain` is informational only — it carries explicit on-chain abstain
 * votes plus auto-abstain power (for DReps). The frontend renders it as
 * a footnote BELOW the donut, separated from the ratification slices.
 *
 * Why this lives separately from blockfrost.ts:
 *   - The math is shared between the Koios fast-path and the Blockfrost
 *     fallback in the sync.
 *   - It's pure (no I/O); easy to reason about in isolation.
 *   - The CIP-1694 special cases (auto-no-confidence direction flip on
 *     NoConfidence actions; SPO unvoted-collapses-to-abstain on
 *     NoConfidence) are non-trivial and benefit from a focused module.
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
//   - drep_always_abstain: counts as Abstain on every action. Per CIP-1694
//     this stake is explicitly NOT part of the active voting stake — it is
//     the user opting out of governance entirely. We therefore exclude it
//     from `totalActive` and surface it ONLY in the informational `abstain`
//     slice.
//   - drep_always_no_confidence: counts as YES on NoConfidence actions
//     (the delegator wants to remove the committee) and as NO on every
//     other action (they distrust the proposer). This stake IS part of the
//     active voting stake — it expresses a position rather than opting out.

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
  /** Voting power delegated to drep_always_abstain. Auto-vote across all
   *  actions; excluded from the ratification denominator per CIP-1694. */
  alwaysAbstainPower?: bigint;
  /** Voting power delegated to drep_always_no_confidence. Auto-vote across
   *  all actions; INCLUDED in the ratification denominator. The "direction"
   *  depends on the action type. */
  alwaysNoConfidencePower?: bigint;
}

/**
 * Per-role denominators the sync derived from the lookups. Note:
 * `totalDrepPower` here is the sum of REGISTERED active DRep voting power
 * (i.e. the result of summing `drepPower` values). The tally builder is
 * responsible for then folding in auto-no-confidence power to compute the
 * final `totalActive.power` the UI will use. We deliberately do NOT
 * pre-add auto-no-confidence here — that conflation is exactly what made
 * the previous version of this module wrong.
 */
export interface TallyTotals {
  /** Headcount of registered active DReps. Excludes predefined DReps
   *  (auto-vote delegations aren't individual voters). */
  totalDrepCount: number;
  /** Sum of registered active DRep voting power, in lovelace. EXCLUDES
   *  both auto-abstain and auto-no-confidence — those are added by the
   *  tally builder when constructing the per-action denominator. */
  totalDrepPower: bigint;
  /** Headcount of currently-active stake pools. */
  totalPoolCount: number;
  /** Sum of active pool live_stake, in lovelace. */
  totalPoolPower: bigint;
  /** Headcount of authorized CC members. */
  totalCcCount: number;
  /** CC has no per-voter weighting on mainnet today; power tracks count. */
  totalCcPower: bigint;
}

// ---- Helpers ----

function emptySlice(): VoteSlice {
  return { count: 0, power: '0' };
}

interface RoleAccumulator {
  yes: bigint;
  no: bigint;
  abstain: bigint;
  yesCount: number;
  noCount: number;
  abstainCount: number;
}

function emptyAccumulator(): RoleAccumulator {
  return {
    yes: 0n,
    no: 0n,
    abstain: 0n,
    yesCount: 0,
    noCount: 0,
    abstainCount: 0,
  };
}

function bigintToSlice(power: bigint, count: number): VoteSlice {
  return { count, power: power.toString() };
}

/**
 * Build the per-role tally from accumulated cast-vote contributions and
 * the role's totalActive denominator. Centralizes the 3-slice ratification
 * identity check so each role's caller (DRep / SPO / CC) doesn't repeat
 * the math.
 *
 * @param acc Accumulated cast-vote contributions (raw, before predefined
 *   auto-votes get folded in).
 * @param totalActiveCount Headcount denominator for this role.
 * @param totalActivePower Power denominator for this role (lovelace) —
 *   the ratification denominator. For DReps this excludes auto-abstain.
 * @param totalRegisteredCount Informational headcount including auto-
 *   abstain delegators where applicable. For headcount roles (SPO, CC)
 *   this equals totalActiveCount.
 * @param totalRegisteredPower Informational power denominator including
 *   auto-abstain. For SPO / CC this equals totalActivePower.
 * @param notVotedAsAbstain When true (SPO + NoConfidence per CIP-1694),
 *   stake that didn't vote is treated as Abstain rather than Not Voted.
 *   The `notVoted` slice in this case carries zero, and the unvoted stake
 *   surfaces in `abstain` informationally — but, per CIP-1694, abstain
 *   stake is not in the active voting stake. We therefore subtract it from
 *   `totalActive` so the 3-slice identity still holds.
 * @param autoAbstainPower DRep-only breakout to record on the tally.
 * @param autoNoConfidencePower DRep-only breakout to record on the tally.
 */
function buildRoleTally(
  acc: RoleAccumulator,
  totalActiveCount: number,
  totalActivePower: bigint,
  totalRegisteredCount: number,
  totalRegisteredPower: bigint,
  notVotedAsAbstain: boolean,
  autoAbstainPower?: bigint,
  autoNoConfidencePower?: bigint,
): VoteRoleTally {
  // The `notVoted` ratification slice is the residual of totalActive after
  // yes + no are subtracted. Floor at zero — a negative value would
  // indicate a stale-lookup vs fresh-vote mid-snapshot mismatch, and a
  // negative slice would break BigInt-stringification round-tripping.
  const yesPower = acc.yes;
  const noPower = acc.no;
  const castRatificationPower = yesPower + noPower;
  const remaining =
    totalActivePower > castRatificationPower
      ? totalActivePower - castRatificationPower
      : 0n;

  let notVotedPower = remaining;
  let notVotedCount = Math.max(
    0,
    totalActiveCount - acc.yesCount - acc.noCount - acc.abstainCount,
  );
  let abstainPower = acc.abstain;
  let abstainCount = acc.abstainCount;
  let resolvedTotalActivePower = totalActivePower;
  let resolvedTotalActiveCount = totalActiveCount;

  if (notVotedAsAbstain) {
    // CIP-1694 SPO rule: SPOs that haven't explicitly voted on a
    // NoConfidence action are treated as abstaining (NOT no-voters).
    // We move the residual `notVoted` stake into `abstain` for display,
    // but per CIP-1694 abstain stake is excluded from the active voting
    // stake — so we also remove it from `totalActive` to preserve the
    // 3-slice identity (yes + no + notVoted == totalActive).
    abstainPower = abstainPower + notVotedPower;
    abstainCount = abstainCount + notVotedCount;
    resolvedTotalActivePower = resolvedTotalActivePower - notVotedPower;
    resolvedTotalActiveCount = Math.max(
      0,
      resolvedTotalActiveCount - notVotedCount,
    );
    notVotedPower = 0n;
    notVotedCount = 0;
  }

  const result: VoteRoleTally = {
    yes: bigintToSlice(yesPower, acc.yesCount),
    no: bigintToSlice(noPower, acc.noCount),
    notVoted: bigintToSlice(notVotedPower, notVotedCount),
    abstain: bigintToSlice(abstainPower, abstainCount),
    totalActive: bigintToSlice(resolvedTotalActivePower, resolvedTotalActiveCount),
    totalRegistered: bigintToSlice(totalRegisteredPower, totalRegisteredCount),
  };
  if (autoAbstainPower !== undefined) {
    result.autoAbstainPower = autoAbstainPower.toString();
  }
  if (autoNoConfidencePower !== undefined) {
    result.autoNoConfidencePower = autoNoConfidencePower.toString();
  }
  return result;
}

/**
 * Empty tally — every slice zeroed. Used as a graceful fallback when the
 * sync couldn't fetch the active-voter lookups for a cycle. The frontend
 * still renders the slice labels with zero percentages, which is the
 * right "no data yet" state.
 */
export function emptyTally(): VoteTally {
  const empty: VoteRoleTally = {
    yes: emptySlice(),
    no: emptySlice(),
    notVoted: emptySlice(),
    abstain: emptySlice(),
    totalActive: emptySlice(),
    totalRegistered: emptySlice(),
  };
  return { drep: empty, spo: empty, cc: empty };
}

// ---- Public API ----

/**
 * Build a full VoteTally with CIP-1694-correct ratification math from raw
 * on-chain votes and the active-voter lookups.
 *
 * # The math (per CIP-1694 + GovTool docs)
 *
 * For DReps:
 *
 *   totalActive.power     = activeDrepPower + autoNoConfidencePower
 *                           (NOT plus autoAbstainPower)
 *   totalRegistered.power = totalActive.power + autoAbstainPower
 *
 *   Non-NoConfidence actions:
 *     yes.power      = Σ DReps' yes power
 *     no.power       = Σ DReps' no power + autoNoConfidencePower
 *     abstain.power  = Σ DReps' abstain power + autoAbstainPower   (info)
 *     notVoted.power = totalActive.power - yes.power - no.power
 *
 *   NoConfidence actions:
 *     yes.power      = Σ DReps' yes power + autoNoConfidencePower
 *     no.power       = Σ DReps' no power
 *     abstain.power  = Σ DReps' abstain power + autoAbstainPower   (info)
 *     notVoted.power = totalActive.power - yes.power - no.power
 *
 * For SPOs:
 *
 *   totalActive.power = sum of active pool live_stake.
 *   yes / no / abstain.power = Σ SPOs' votes (no auto-vote analog
 *   exposed by Koios today — see Punt protocol in the spec).
 *   notVoted.power = totalActive.power - yes.power - no.power
 *
 *   NoConfidence-special-case: SPO stake that hasn't explicitly voted is
 *   treated as Abstain (CIP-1694 SPO rule). The residual notVoted stake
 *   is moved into abstain and removed from totalActive (since abstain is
 *   excluded from active voting stake).
 *
 * For CC: power == count (1 vote per authorized member).
 *
 *   totalActive.count = number of authorized CC members.
 *   yes / no / abstain.count = explicit votes.
 *   notVoted.count = totalActive.count - yes.count - no.count.
 *
 * # Why this matters
 *
 * Cardano governance thresholds (e.g. ratification at 51% of active
 * voting stake) evaluate against `totalActive.power`. The previous
 * implementation included auto-abstain stake in `totalActive` AND
 * subtracted abstain from notVoted, which (a) made the percentages
 * smaller than they actually are and (b) overstated the "Not Voted"
 * slice. This corrected version surfaces the same denominator the
 * ledger uses to ratify.
 */
export function tallyVotesWithPower(
  votes: readonly BlockfrostProposalVote[],
  totals: TallyTotals,
  lookups: TallyLookups,
  actionType: GovernanceActionType,
): VoteTally {
  const drep = emptyAccumulator();
  const spo = emptyAccumulator();
  const cc = emptyAccumulator();

  // ---- Pass 1: explicit on-chain votes ----
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

  // ---- Pass 2: predefined-DRep auto-votes ----
  // These contribute power but no headcount (delegators-as-individuals
  // don't appear in vote records).
  const autoAbstainPower = lookups.alwaysAbstainPower ?? 0n;
  const autoNoConfidencePower = lookups.alwaysNoConfidencePower ?? 0n;

  // Auto-abstain is ALWAYS Abstain. It contributes to the informational
  // `abstain` slice but per CIP-1694 is excluded from active voting stake.
  if (autoAbstainPower > 0n) {
    drep.abstain += autoAbstainPower;
  }
  // Auto-no-confidence direction-flips: Yes on NoConfidence, No otherwise.
  // It IS in active voting stake (the delegator expressed a position).
  if (autoNoConfidencePower > 0n) {
    if (actionType === 'NoConfidence') {
      drep.yes += autoNoConfidencePower;
    } else {
      drep.no += autoNoConfidencePower;
    }
  }

  // ---- Pass 3: build the per-role denominators ----
  //
  // DRep totalActive = registered active DRep power + auto-no-confidence.
  // (autoAbstainPower is intentionally NOT added — that's the math fix.)
  //
  // DRep totalRegistered = totalActive + autoAbstainPower. Lets the UI say
  // "abstain is X% of registered DRep stake" without confusion.
  const drepTotalActivePower = totals.totalDrepPower + autoNoConfidencePower;
  const drepTotalRegisteredPower = drepTotalActivePower + autoAbstainPower;

  // SPO totalActive = sum of active pool live_stake. No auto-vote analog
  // is exposed by Koios's pool_list today — predefined SPO voting options
  // exist in CIP-1694 but the Koios endpoint surface for them is unclear,
  // so we punt that special case (per the spec's Punt protocol).
  const spoTotalActivePower = totals.totalPoolPower;
  const spoTotalRegisteredPower = spoTotalActivePower;

  // CC totalActive = count of authorized members. CC abstain has no auto-
  // analog so totalRegistered == totalActive.
  const ccTotalActivePower = totals.totalCcPower;
  const ccTotalRegisteredPower = ccTotalActivePower;

  // CIP-1694 SPO NoConfidence rule: unvoted SPO stake collapses into
  // abstain rather than notVoted. The flag flows through buildRoleTally,
  // which moves the residual stake from notVoted to abstain AND deducts
  // it from totalActive (preserving the 3-slice ratification identity,
  // since abstain is outside the active voting stake).
  const spoNotVotedAsAbstain = actionType === 'NoConfidence';

  return {
    drep: buildRoleTally(
      drep,
      totals.totalDrepCount,
      drepTotalActivePower,
      totals.totalDrepCount,
      drepTotalRegisteredPower,
      false,
      autoAbstainPower,
      autoNoConfidencePower,
    ),
    spo: buildRoleTally(
      spo,
      totals.totalPoolCount,
      spoTotalActivePower,
      totals.totalPoolCount,
      spoTotalRegisteredPower,
      spoNotVotedAsAbstain,
    ),
    cc: buildRoleTally(
      cc,
      totals.totalCcCount,
      ccTotalActivePower,
      totals.totalCcCount,
      ccTotalRegisteredPower,
      false,
    ),
  };
}
