import type { CommitteeCastVote } from './types';

/**
 * Pure committee-vote resolver. No I/O — given the current casts and the
 * proposal's snapshotted threshold + quorum, it computes the live tally and
 * whether the proposal currently passes.
 *
 * Settled rules (see docs/PHASE2_COMMITTEE_PLAN.md):
 *  - Pass = configurable supermajority applied to the NON-ABSTAINING pool
 *    (`activePool = agree + disagree`). Abstain shrinks the pool, which makes
 *    passage easier.
 *  - Quorum = at least `quorum` (default 3) non-abstaining voters before a
 *    proposal can resolve.
 *  - Decision D2 = A: there is NO "doomed" computation. Closing a proposal as
 *    failed (or withdrawing it) is a human judgement call gated by role in the
 *    handler, not a property of the tally. The resolver only answers
 *    "is it passing right now?".
 *
 * `thresholdPct` is assumed already validated to 51..100 (never below simple
 * majority) at config-set time — see handlers/committee/updateVotingConfig.
 * At 51% the supermajority test coincides exactly with a strict majority for
 * every pool size, so the floor is honoured.
 */

export interface CommitteeResolverInput {
  /** One entry per voter. If a voter appears more than once, the LAST entry
   *  wins (defensive — callers should already pass the latest cast per voter). */
  casts: ReadonlyArray<{ voterWallet: string; vote: CommitteeCastVote }>;
  /** Supermajority percentage applied to the non-abstaining pool (51..100). */
  thresholdPct: number;
  /** Minimum non-abstaining voters required to resolve (>= 1). */
  quorum: number;
}

export interface CommitteeResolverResult {
  agreeCount: number;
  disagreeCount: number;
  abstainCount: number;
  /** agree + disagree. Abstain is excluded, so abstaining shrinks this. */
  activePool: number;
  /** True once activePool >= quorum. */
  quorumMet: boolean;
  /** agree / activePool as a percentage (0 when activePool === 0). May be
   *  fractional — formatting is the caller's concern. */
  agreePct: number;
  /** True iff quorumMet AND agree is a supermajority of the active pool. */
  isPassing: boolean;
  /** True iff any committee member may close the proposal as PASSED right now. */
  canCloseAsPass: boolean;
}

export function resolveCommitteeVote(
  input: CommitteeResolverInput,
): CommitteeResolverResult {
  const { thresholdPct, quorum } = input;

  // Defensive dedupe: keep the last cast per voter.
  const latest = new Map<string, CommitteeCastVote>();
  for (const c of input.casts) latest.set(c.voterWallet, c.vote);

  let agreeCount = 0;
  let disagreeCount = 0;
  let abstainCount = 0;
  for (const vote of latest.values()) {
    if (vote === 'Agree') agreeCount++;
    else if (vote === 'Disagree') disagreeCount++;
    else abstainCount++;
  }

  const activePool = agreeCount + disagreeCount;
  const quorumMet = activePool >= quorum;
  const agreePct = activePool > 0 ? (agreeCount * 100) / activePool : 0;

  // Integer cross-multiplication avoids floating-point edge cases right at the
  // threshold (e.g. 2/3 vs 67%).
  const meetsThreshold = agreeCount * 100 >= activePool * thresholdPct;
  const isPassing = quorumMet && activePool > 0 && meetsThreshold;

  return {
    agreeCount,
    disagreeCount,
    abstainCount,
    activePool,
    quorumMet,
    agreePct,
    isPassing,
    canCloseAsPass: isPassing,
  };
}
