// Committee voting wire types — mirror the backend handler response shapes
// (backend/src/handlers/committee/*). Kept separate from the generated/shared
// types so the Phase 2 surface is self-contained.

export type CommitteePosition = 'Yes' | 'No' | 'Abstain';
export type CommitteeCastVote = 'Agree' | 'Disagree' | 'Abstain';
export type CommitteeProposalStatus =
  | 'open'
  | 'passed'
  | 'failed'
  | 'withdrawn'
  | 'epoch_finalized';
export type RationaleMode = 'lead' | 'assigned' | 'collaborative';

export interface CommitteeTally {
  agreeCount: number;
  disagreeCount: number;
  abstainCount: number;
  activePool: number;
  quorumMet: boolean;
  agreePct: number;
  isPassing: boolean;
  canCloseAsPass: boolean;
}

export interface CommitteeTallySnapshot {
  agreeCount: number;
  disagreeCount: number;
  abstainCount: number;
  activePool: number;
  agreePct: number;
}

export interface CommitteeProposal {
  drepId: string;
  actionId: string;
  proposedPosition: CommitteePosition;
  proposerWallet: string;
  status: CommitteeProposalStatus;
  thresholdPct: number;
  quorum: number;
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

export interface VotingConfig {
  thresholdPct: number;
  quorum: number;
  rationaleMode: RationaleMode;
  assignedEditor?: string;
}
