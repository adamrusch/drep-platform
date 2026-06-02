// Committee voting wire types — mirror the backend handler response shapes
// (backend/src/handlers/committee/*). Kept separate from the generated/shared
// types so the Phase 2 surface is self-contained.
//
// Approval model (settled with the user 2026-05-31): a governance action is
// **Committee Approved** when at least `approvalThreshold` (X) of the
// `memberCount` (N) members vote **Agree** — the old supermajority-percentage /
// quorum-of-active-pool model is gone. New proposals and tallies carry X + N;
// the legacy `thresholdPct` / `quorum` fields are intentionally omitted here.

export type CommitteePosition = 'Yes' | 'No' | 'Abstain';
export type CommitteeCastVote = 'Agree' | 'Disagree' | 'Abstain';
export type CommitteeProposalStatus =
  | 'open'
  | 'passed'
  | 'failed'
  | 'withdrawn'
  | 'epoch_finalized';
export type RationaleMode = 'lead' | 'assigned' | 'collaborative';

/** Live tally from `GET /committee/{drepId}/votes/{actionId}` — the count-based
 *  X-of-N resolver (backend/src/lib/committeeVoteResolver.ts). */
export interface CommitteeTally {
  agreeCount: number;
  disagreeCount: number;
  abstainCount: number;
  /** X — Agree votes required for "Committee Approved". */
  approvalThreshold: number;
  /** N — committee size snapshotted onto the proposal at open time. */
  memberCount: number;
  /** Agree votes still needed to reach X (0 once approved). */
  agreeNeeded: number;
  /** agree / N as a percentage (informational; 0 when N === 0). */
  agreePct: number;
  /** True iff agreeCount >= approvalThreshold — i.e. "Committee Approved". */
  isApproved: boolean;
  /** Back-compat aliases the resolver also returns. */
  isPassing: boolean;
  canCloseAsPass: boolean;
}

/** Persisted snapshot stamped onto a closed proposal — what the count was the
 *  moment it transitioned out of `open`. */
export interface CommitteeTallySnapshot {
  agreeCount: number;
  disagreeCount: number;
  abstainCount: number;
  /** Sum of Agree + Disagree (informational). */
  activePool: number;
  agreePct: number;
  approvalThreshold: number;
  memberCount: number;
  approved: boolean;
}

export interface CommitteeProposal {
  drepId: string;
  actionId: string;
  proposedPosition: CommitteePosition;
  proposerWallet: string;
  status: CommitteeProposalStatus;
  /** X — number of Agree votes needed for Committee Approved. */
  approvalThreshold: number;
  /** N — committee size snapshotted at open time. */
  memberCount: number;
  epochDeadline: number;
  openedAt: string;
  closedAt?: string;
  closedByWallet?: string;
  closedReason?: string;
  finalTally?: CommitteeTallySnapshot;
}

export interface CommitteeCast {
  voterWallet: string;
  vote: CommitteeCastVote;
  votedAt: string;
  changeCount: number;
}

export interface CommitteeVoteRoomView {
  proposal: CommitteeProposal;
  casts: CommitteeCast[];
  tally: CommitteeTally;
  hasRationaleDraft: boolean;
}

export interface CommitteeVoteListView {
  proposals: CommitteeProposal[];
}

export interface RationaleDraft {
  rationaleStatement: string;
  summary?: string;
  precedentDiscussion?: string;
  counterargumentDiscussion?: string;
  conclusion?: string;
  references?: Array<{ '@type'?: string; label: string; uri: string }>;
  updatedAt: string;
}

export interface RationaleLockState {
  editorWallet: string;
  expiresAt: number;
  heldByMe: boolean;
}

export interface RationaleFinalState {
  anchorHash: string;
  ipfsUri?: string;
  finalizedBy: string;
  finalizedAt: string;
}

export interface RationaleView {
  mode: RationaleMode;
  assignedEditor?: string;
  draft: RationaleDraft | null;
  lock: RationaleLockState | null;
  final: RationaleFinalState | null;
}

/** Stored voting config — the rationale-mode side still lives here. The
 *  approval rule itself now lives on the committee row (`approvalThreshold`)
 *  and is restated on every membership change, so it's intentionally not on
 *  this config any more. */
export interface VotingConfig {
  rationaleMode: RationaleMode;
  assignedEditor?: string;
}

/** Result row from `POST /committee/check-members` — one entry per address the
 *  Chair typed into the formation/add-member flow. */
export interface CheckMemberResult {
  /** The raw input string (so the UI can keep its row keyed on what the user
   *  actually typed). */
  input: string;
  /** Whether the input parsed as a Cardano payment or stake address. */
  valid: boolean;
  /** Canonical stake address (the platform's identity for this person). */
  stakeAddress?: string;
  /** True when that stake address has ever signed in to the platform. */
  active: boolean;
  displayName?: string;
}

export interface CheckMembersResponse {
  results: CheckMemberResult[];
}
