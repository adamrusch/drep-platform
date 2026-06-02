import type { CommitteeCastVote } from './types';

/**
 * Pure committee-vote resolver. No I/O — given the current casts and the
 * proposal's snapshotted "X of N" rule, it computes the live tally and whether
 * the proposal is "Committee Approved".
 *
 * Rule (settled with the user 2026-05-31):
 *  - A governance action is **Committee Approved** when at least
 *    `approvalThreshold` (X) of the `memberCount` (N) members vote **Agree**.
 *    Abstentions and disagreements simply aren't Agrees — they don't change the
 *    bar (unlike the old supermajority-of-active-pool model).
 *  - X and N are snapshotted onto the proposal at open time, so a mid-vote
 *    membership change or rule change does NOT move an in-flight proposal's bar.
 *  - There is no "doomed" computation — closing as failed/withdrawn is a human,
 *    role-gated action in the handler. The resolver only answers "is it
 *    approved right now, and how many more Agrees are needed?".
 */

export interface CommitteeResolverInput {
  /** One entry per voter. If a voter appears more than once, the LAST entry
   *  wins (defensive — callers should already pass the latest cast per voter). */
  casts: ReadonlyArray<{ voterWallet: string; vote: CommitteeCastVote }>;
  /** X — number of Agree votes required for "Committee Approved" (>= 1). */
  approvalThreshold: number;
  /** N — committee size snapshotted at open time (>= approvalThreshold). */
  memberCount: number;
}

export interface CommitteeResolverResult {
  agreeCount: number;
  disagreeCount: number;
  abstainCount: number;
  /** X — echoed for display. */
  approvalThreshold: number;
  /** N — echoed for display. */
  memberCount: number;
  /** Agree votes still needed to reach X (0 once approved). */
  agreeNeeded: number;
  /** agree / N as a percentage (informational; 0 when N === 0). */
  agreePct: number;
  /** True iff agreeCount >= approvalThreshold — i.e. "Committee Approved". */
  isApproved: boolean;
  /** Back-compat aliases for the existing handler/UI call sites. */
  isPassing: boolean;
  canCloseAsPass: boolean;
}

export function resolveCommitteeVote(
  input: CommitteeResolverInput,
): CommitteeResolverResult {
  const approvalThreshold = Math.max(1, Math.floor(input.approvalThreshold || 1));
  const memberCount = Math.max(0, Math.floor(input.memberCount || 0));

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

  const isApproved = agreeCount >= approvalThreshold;
  const agreeNeeded = Math.max(0, approvalThreshold - agreeCount);
  const agreePct = memberCount > 0 ? (agreeCount * 100) / memberCount : 0;

  return {
    agreeCount,
    disagreeCount,
    abstainCount,
    approvalThreshold,
    memberCount,
    agreeNeeded,
    agreePct,
    isApproved,
    isPassing: isApproved,
    canCloseAsPass: isApproved,
  };
}
