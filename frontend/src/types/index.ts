// Frontend type definitions — mirrors shared/types/index.ts
// Kept local to avoid cross-workspace import issues with Vite's bundler resolution

export type UserRole =
  | 'guest'
  | 'delegator'
  | 'committee_member'
  | 'lead_drep'
  | 'trusted_delegator';

export type GovernanceActionType =
  | 'ParameterChange'
  | 'HardForkInitiation'
  | 'TreasuryWithdrawals'
  | 'NoConfidence'
  | 'UpdateCommittee'
  | 'NewConstitution'
  | 'InfoAction';

export type GovernanceActionStatus = 'active' | 'expired' | 'enacted' | 'dropped';

export type SessionType = 'normal' | 'remember_me';

/** Where the off-chain metadata (title/abstract/...) on this action came
 *  from. `on-chain-anchor` = parsed CIP-108 anchor body. `proposal-pillar`
 *  = matched gov.tools forum draft (fallback when the on-chain anchor is
 *  missing or has no title). `none` = neither — the UI falls back to the
 *  synthesized on-chain summary only. */
export type GovernanceMetadataSource = 'on-chain-anchor' | 'proposal-pillar' | 'none';

export interface GovernanceAction {
  actionId: string;
  actionType: GovernanceActionType;
  /** Off-chain title — from the CIP-108 anchor body when present, else
   *  from a matched gov.tools forum draft. Undefined when neither source
   *  yields a title; `summary` is rendered as a subtitle in that case.
   *  See `metadataSource` to disambiguate. */
  title?: string;
  description: string;
  submittedAt: string;
  epochDeadline: number;
  status: GovernanceActionStatus;
  sourceMetadata?: Record<string, string>;
  links?: string[];
  ingestedAt?: string;
  lastSyncedAt?: string;
  adminOverrideLabel?: string;
  // ---- Anchor (CIP-100/108 off-chain metadata) ----
  anchorUrl?: string;
  anchorHash?: string;
  anchorVerified?: boolean;
  abstract?: string;
  motivation?: string;
  rationale?: string;
  references?: GovernanceReference[];
  // ---- Proposal-pillar (gov.tools forum draft) fallback metadata ----
  /** Public discussion-thread URL. Synthesized as
   *  `https://gov.tools/proposal_discussion/{id}`. Present only when this
   *  action was matched to a forum draft. */
  proposalPillarUrl?: string;
  /** Numeric forum proposal ID. Stored for traceability. */
  proposalPillarId?: number;
  /** Indicates which off-chain source produced the displayed metadata. */
  metadataSource?: GovernanceMetadataSource;
  // ---- On-chain summary (built from governance_description) ----
  summary?: string;
  details?: GovernanceDetail[];
  // ---- On-chain misc ----
  proposerAddress?: string;
  /** TreasuryWithdrawals only — sum of all withdrawal lovelace amounts on
   *  this action, stringified BigInt. Powers the "total ADA withdrawn"
   *  aggregation on the history page. Undefined for non-treasury types and
   *  on rows synced before enrichmentVersion 10. */
  treasuryWithdrawalLovelace?: string;
  // ---- On-chain vote tally (split by voter role) ----
  votes?: VoteTally;
  /** Per CIP-1694 §Ratification §Restrictions: which governance bodies are
   *  called to vote on this action type. Used by the UI to suppress entire
   *  role sections (donut + breakdown + abstain footnote) when a body is
   *  not applicable — e.g. SPOs on Treasury Withdrawals, CC on
   *  NoConfidence. Optional for backwards compat: actions written by an
   *  older sync (< v9) won't carry it; treat absence as "show all roles". */
  votingRoles?: VotingRoles;
}

/** Which governance bodies are called to vote on a given action type. */
export interface VotingRoles {
  cc: boolean;
  drep: boolean;
  spo: boolean;
}

/**
 * One slice of a per-role tally. `count` is the voter headcount; `power`
 * is the voting power they collectively represent, in lovelace, as a
 * stringified integer (DRep totals exceed 2^53 so JSON `number` would
 * lose precision). For the Constitutional Committee `power` mirrors
 * `count` — CC members vote one-each on mainnet today.
 */
export interface VoteSlice {
  count: number;
  power: string;
}

/**
 * Per-role tally with explicit ratification slices.
 *
 * CIP-1694 ratification math: yes/no/notVoted together sum to 100% of
 * totalActive (the "active voting stake" denominator). Auto-abstain
 * delegations are NOT in totalActive — per CIP-1694 they're explicitly
 * excluded from the active voting stake. `abstain` is informational and
 * sits OUTSIDE the ratification denominator. `totalRegistered` is the
 * bigger informational denominator that includes auto-abstain.
 *
 * Backend invariant (BigInt equality):
 *   yes.power + no.power + notVoted.power == totalActive.power
 */
export interface VoteRoleTally {
  /** Yes-vote slice. For NoConfidence actions, includes auto-no-confidence
   *  power (auto-no-confidence flips to Yes on NoConfidence actions). */
  yes: VoteSlice;
  /** No-vote slice. For non-NoConfidence actions, includes auto-no-
   *  confidence power (it counts as No on every other action). */
  no: VoteSlice;
  /** Stake in totalActive that hasn't voted yes/no — totalActive - yes - no. */
  notVoted: VoteSlice;
  /** Informational only — explicit abstain votes + auto-abstain power.
   *  NOT in the ratification denominator. */
  abstain: VoteSlice;
  /** Ratification denominator (excludes auto-abstain). */
  totalActive: VoteSlice;
  /** Informational total (INCLUDES auto-abstain). For SPO / CC, equals
   *  totalActive (no auto-abstain analog). */
  totalRegistered: VoteSlice;
  /** Informational breakout (DRep only). Stringified BigInt lovelace. */
  autoAbstainPower?: string;
  /** Informational breakout (DRep only). Stringified BigInt lovelace. */
  autoNoConfidencePower?: string;
}

/**
 * Aggregated votes for a governance action, bucketed by voter role.
 * `cc` = constitutional committee.
 */
export interface VoteTally {
  drep: VoteRoleTally;
  spo: VoteRoleTally;
  cc: VoteRoleTally;
}

/** Aggregated governance stats — payload of `GET /governance/stats`.
 *  Powers the history page summary panel and the dashboard "Governance
 *  History" widget. See `backend/src/handlers/governance/stats.ts` for
 *  the canonical shape. */
export interface GovernanceStats {
  total: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
  /** Sum of withdrawal lovelace on ENACTED TreasuryWithdrawals only,
   *  stringified BigInt. */
  treasuryWithdrawnLovelace: string;
  earliestSubmittedAt?: string;
  latestSubmittedAt?: string;
}

export interface EpochInfo {
  epoch: number;
  startTime: string;
  endTime: string;
  /** Seconds until this epoch ends. */
  endsInSeconds: number;
}

export interface GovernanceReference {
  label: string;
  uri: string;
}

export interface GovernanceDetail {
  label: string;
  value: string;
}

export interface DRepCommittee {
  drepId: string;
  leadWallet: string;
  committeeName: string;
  description: string;
  onChainMetadata?: Record<string, unknown>;
  members: CommitteeMember[];
  createdAt: string;
  updatedAt: string;
}

export interface CommitteeMember {
  walletAddress: string;
  displayName?: string;
  joinedAt: string;
  role: 'lead_drep' | 'committee_member' | 'trusted_delegator';
}

// ---- DRep directory (chain-state, /dreps endpoint) ----
//
// Distinct from `DRepCommittee` — that's a platform-internal coordination
// record. This is a chain-state snapshot of every registered DRep on
// mainnet, populated by a 5-min Koios sync.

export type DRepReferenceKind = 'Identity' | 'Link' | 'Other';

export interface DRepReference {
  kind: DRepReferenceKind;
  label: string;
  uri: string;
}

export interface DRepDirectoryEntry {
  drepId: string;
  hex: string | null;
  isActive: boolean;
  /** True when this DRep has filed a retirement certificate. Voting
   *  power is pinned to "0"; historical anchor metadata and vote
   *  activity are preserved. UI renders a distinct "Retired" badge.
   *  Optional for backwards compat with rows synced before this field
   *  was added — treat absence as `false`. */
  isRetired?: boolean;
  status: string;
  deposit: string | null;
  hasScript: boolean;
  /** Voting power in lovelace, stringified BigInt. */
  votingPower: string;
  expiresEpoch: number | null;
  delegatorCount?: number;
  /** ISO-8601 timestamp of this DRep's most recent vote. Undefined when
   *  the DRep has never voted. */
  lastVotedAt?: string;
  /** Total number of governance votes ever cast by this DRep. Explicitly
   *  `0` for never-voted; undefined only on rows from sync versions
   *  before this field was added. */
  voteCount?: number;
  anchorUrl: string | null;
  anchorHash: string | null;
  /** Tri-state: true / false / null (no anchor or not yet checked). */
  anchorVerified: boolean | null;
  // CIP-119 body fields:
  givenName?: string;
  image?: string;
  objectives?: string;
  motivations?: string;
  qualifications?: string;
  paymentAddress?: string;
  references?: DRepReference[];
  lastSyncedAt: string;
  enrichmentVersion: number;
}

export interface DRepRecentVote {
  proposalTxHash: string;
  proposalIndex: number;
  proposalType: string;
  /** Verbatim from Koios — "Yes" | "No" | "Abstain". */
  vote: string;
  votedAt: string;
}

export interface DRepDetail extends DRepDirectoryEntry {
  recentVotes?: DRepRecentVote[];
  delegatorCountLive?: number;
}

export interface UserProfile {
  walletAddress: string;
  displayName?: string;
  bio?: string;
  socialLinks?: SocialLinks;
  createdAt: string;
  updatedAt: string;
  roles: UserRole[];
  delegationHistory?: DelegationRecord[];
  drepId?: string;
}

export interface SocialLinks {
  twitter?: string;
  github?: string;
  website?: string;
  discord?: string;
}

export interface DelegationRecord {
  drepId: string;
  drepName?: string;
  delegatedAt: string;
  undelegatedAt?: string;
  epochStart: number;
  epochEnd?: number;
  lovelace: string;
}

export interface Comment {
  actionId: string;
  commentId: string;
  walletAddress: string;
  displayName?: string;
  body: string;
  isPublic: boolean;
  isDRep: boolean;
  createdAt: string;
  updatedAt: string;
  // ---- Optional display metadata (Day 2 groundwork — backend not yet
  // populated; types in place so the design pattern can render once the
  // sync layer fills these in). See `governance.jsx:294–305`. ----
  /** True when the author is recognized by the action's lead DRep
   *  (gold-star badge in design). */
  starred?: boolean;
  /** ADA stake amount, displayed as a "5.2M ₳ stake" pill. */
  stakeAda?: string;
  /** Display name of the DRep this commenter delegates to, shown as a pill. */
  drep?: string;
}

export type ClubhousePostType = 'discussion' | 'question' | 'poll';

export interface ClubhousePollOption {
  id: string;
  label: string;
  votes: number;
}

export interface ClubhousePost {
  drepId: string;
  postId: string;
  authorWallet: string;
  authorDisplayName?: string;
  isDRepPost: boolean;
  body: string;
  comments: ClubhouseComment[];
  createdAt: string;
  updatedAt: string;
  // ---- Day 3 additions: post type + (when type=poll) poll fields. ----
  type?: ClubhousePostType;
  title?: string;
  pollOptions?: ClubhousePollOption[];
  pollMultiple?: boolean;
  pollClosesAt?: string;
  /** wallet → option index. The current user can read their own choice
   *  by indexing into this with their walletAddress. */
  pollVotes?: Record<string, number>;
  /** Stake / DRep pills for the post header. Optional, populated
   *  best-effort by the backend. Mirrors the comment header pattern. */
  stakeAda?: string;
  drep?: string;
}

export interface ClubhouseComment {
  commentId: string;
  authorWallet: string;
  authorDisplayName?: string;
  body: string;
  createdAt: string;
}

export interface AuthState {
  walletAddress: string | null;
  roles: UserRole[];
  drepId?: string;
  sessionType: SessionType | null;
  expiresAt: string | null;
  isAuthenticated: boolean;
  profile: UserProfile | null;
}

export interface PaginatedResponse<T> {
  items: T[];
  /** Legacy DynamoDB cursor — kept for backwards compat with endpoints
   *  that still emit one. The directory listing has migrated to
   *  page-numbered pagination; new code should prefer `page` /
   *  `pageSize` / `totalPages`. */
  lastEvaluatedKey?: string;
  /** Absolute count of matching rows after filtering (not just the
   *  current page). Required for page-numbered pagination — a missing
   *  value indicates the endpoint hasn't migrated yet. */
  total?: number;
  /** 0-indexed current page. Present on page-numbered endpoints. */
  page?: number;
  /** Effective page size (the server may clamp to a max). */
  pageSize?: number;
  /** ceil(total / pageSize). At least 1, even when total === 0, so the
   *  UI can render a single empty page rather than zero pages. */
  totalPages?: number;
}

export interface ApiResponse<T> {
  data: T;
}

export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
}

export interface MutationNonceRequest {
  nonce: string;
  message: string;
  expiresAt: string;
}

export interface WalletConnectState {
  isConnecting: boolean;
  isConnected: boolean;
  walletName: string | null;
  stakeAddress: string | null;
  error: string | null;
}
