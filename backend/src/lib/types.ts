// ============================================================
// Backend TypeScript types — includes all shared types inline
// to avoid rootDir boundary issues with the shared/ workspace
// ============================================================

// ---- Shared types (duplicated from shared/types/index.ts) ----

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

/** Where the human-readable metadata (title/abstract/...) on this action
 *  came from. `on-chain-anchor` = the CIP-100/108 anchor body that was
 *  fetched and parsed. `proposal-pillar` = a fallback draft from the
 *  gov.tools proposal-discussion forum (used when the on-chain anchor
 *  is missing or had no usable title). `none` = neither source produced
 *  metadata; the UI shows the synthesized on-chain summary only. */
export type GovernanceMetadataSource = 'on-chain-anchor' | 'proposal-pillar' | 'none';

export interface GovernanceAction {
  actionId: string;
  actionType: GovernanceActionType;
  /** Title comes from the off-chain CIP-108 anchor body or, as a fallback,
   *  from a matched proposal-pillar (gov.tools) draft. Undefined when
   *  neither source yields a title. The frontend uses the synthesized
   *  on-chain `summary` as a subtitle in that case. See `metadataSource`
   *  to disambiguate. */
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
  editLog?: GovernanceActionEdit[];
  // ---- Anchor (CIP-100/108 off-chain metadata) ----
  anchorUrl?: string;
  anchorHash?: string;
  anchorVerified?: boolean;
  abstract?: string;
  motivation?: string;
  rationale?: string;
  references?: GovernanceReference[];
  // ---- Proposal-pillar (gov.tools forum draft) fallback metadata ----
  /** Public discussion URL. Synthesized as
   *  `https://gov.tools/proposal_discussion/{id}`. Present only when this
   *  action was matched to a forum draft. */
  proposalPillarUrl?: string;
  /** Numeric forum proposal ID. Stored for traceability. */
  proposalPillarId?: number;
  /** Indicates which off-chain source produced the displayed metadata.
   *  Useful for the UI to render a "Discussion forum" pill when a
   *  proposal-pillar fallback was used. */
  metadataSource?: GovernanceMetadataSource;
  /** Public IPFS gateway URL (e.g. `https://ipfs.io/ipfs/Qm…`) that served
   *  the hash-verified anchor body when Koios's internal gateway couldn't
   *  retrieve it. Undefined on the happy path (Koios sufficed) and on rows
   *  where every gateway failed. Informational/debug only. */
  metadataGateway?: string;
  /** ISO-8601 timestamp of the sync cycle that successfully recovered this
   *  anchor body via the IPFS multi-gateway fallback. Undefined for rows
   *  that never needed the fallback. */
  metadataRecoveredAt?: string;
  // ---- On-chain summary (built from governance_description) ----
  summary?: string;
  details?: GovernanceDetail[];
  // ---- On-chain misc ----
  proposerAddress?: string;
  /** For TreasuryWithdrawals only: sum of all `withdrawal[i][1]` lovelace
   *  amounts on this action, as a stringified BigInt. The ratification
   *  sentinel: "how much ADA does this action move out of the treasury?"
   *  Persisted at sync time so the `/governance/stats` aggregation can sum
   *  it across all enacted treasury actions without re-parsing the on-chain
   *  description. Undefined for non-TreasuryWithdrawals action types. */
  treasuryWithdrawalLovelace?: string;
  // ---- On-chain vote tally (split by voter role) ----
  votes?: VoteTally;
  /** Per CIP-1694 §Ratification §Restrictions, which governance bodies are
   *  called to vote on this action type. Frontend uses this to hide entire
   *  role sections (donut + breakdown + abstain footnote) for non-applicable
   *  roles. Optional for backwards compat — older items written before v9
   *  won't carry it; the frontend should fall back to a "show all" default
   *  in that case. */
  votingRoles?: VotingRoles;
}

/**
 * One slice of a per-role tally — `count` is the headcount of voters in
 * this slice; `power` is the voting power they collectively represent,
 * in lovelace. `power` is a stringified integer because total active DRep
 * power is on the order of 30B+ ADA = 3×10^16 lovelace, well past 2^53;
 * keeping it as a string lets it round-trip through DynamoDB and JSON
 * without precision loss. For Constitutional Committee voters there is
 * no per-voter weighting on mainnet today, so `power` mirrors `count`
 * (1 lovelace per member, conceptually).
 */
export interface VoteSlice {
  count: number;
  power: string;
}

/**
 * Per-role tally with explicit ratification slices.
 *
 * CIP-1694 ratification math: `yes`, `no`, `notVoted` together sum to
 * 100% of `totalActive` — the "active voting stake" denominator. Auto-
 * abstain delegations (drep_always_abstain) are explicitly NOT in
 * totalActive: per CIP-1694, they're "actively marked as not participating
 * in governance" and therefore excluded from the ratification denominator.
 * `abstain` is informational — it carries explicit on-chain abstain votes
 * plus auto-abstain (for DReps), and lives outside the ratification math.
 *
 * Identity that must hold exactly (BigInt):
 *   yes.power + no.power + notVoted.power == totalActive.power
 *
 * The bigger denominator (`totalRegistered`) includes auto-abstain stake
 * and is provided so the UI can express "abstain as % of registered
 * voting stake" if it wants.
 */
export interface VoteRoleTally {
  /** Yes-vote slice. For NoConfidence actions, includes auto-no-confidence
   *  power (since stake delegated to drep_always_no_confidence counts as
   *  Yes on every NoConfidence action). */
  yes: VoteSlice;
  /** No-vote slice. For non-NoConfidence actions, includes auto-no-
   *  confidence power (stake delegated to drep_always_no_confidence counts
   *  as No on every other action). */
  no: VoteSlice;
  /** "Not voted" — totalActive minus yes minus no. The remaining stake in
   *  the ratification denominator that hasn't expressed Yes or No. */
  notVoted: VoteSlice;
  /** Informational only — explicit on-chain abstain votes + auto-abstain
   *  power (for DReps). NOT in the ratification denominator; do NOT subtract
   *  this from totalActive when computing notVoted. */
  abstain: VoteSlice;
  /** The ratification denominator. For DReps: active DRep voting power +
   *  auto-no-confidence power (NOT auto-abstain). For SPOs: sum of active
   *  pool live_stake. For CC: count of authorized members. */
  totalActive: VoteSlice;
  /** Informational denominator that INCLUDES auto-abstain. For DReps this
   *  equals totalActive + autoAbstainPower. For roles without an auto-
   *  abstain analog (SPO, CC) this equals totalActive. Lets the UI compute
   *  "abstain as % of total registered voting stake" without confusion. */
  totalRegistered: VoteSlice;
  /** Informational breakout — auto-abstain power (DRep only). Stringified
   *  BigInt in lovelace. Undefined when not applicable (SPO, CC) or unknown. */
  autoAbstainPower?: string;
  /** Informational breakout — auto-no-confidence power (DRep only).
   *  Stringified BigInt in lovelace. Undefined when not applicable. */
  autoNoConfidencePower?: string;
}

/**
 * Aggregated votes for a governance action, bucketed by voter role.
 * `cc` = constitutional committee. Each role carries its own
 * yes/no/abstain/notVoted slices and the total active voting power
 * available to that role at sync time.
 */
export interface VoteTally {
  drep: VoteRoleTally;
  spo: VoteRoleTally;
  cc: VoteRoleTally;
}

/**
 * Which governance bodies are called to vote on a given action type per
 * CIP-1694 §Ratification §Restrictions. Stored alongside the action so the
 * frontend can suppress role sections for non-applicable roles (e.g. SPOs
 * are NOT called to vote on Treasury Withdrawals; CC is NOT called to vote
 * on NoConfidence). Computed by `applicableRoles(actionType)` in voteTally.ts.
 */
export interface VotingRoles {
  cc: boolean;
  drep: boolean;
  spo: boolean;
}

export interface GovernanceReference {
  label: string;
  uri: string;
}

export interface GovernanceDetail {
  label: string;
  value: string;
}

export interface GovernanceActionEdit {
  editedAt: string;
  editorWallet: string;
  field: string;
  before: string;
  after: string;
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

/** One reference entry from the CIP-119 anchor body. `kind` mirrors the
 *  upstream `@type`: `Identity` is a social-handle reference (Twitter,
 *  GitHub, etc.) and the UI surfaces it under "Social handles"; `Link`
 *  / `Other` are general references rendered under "References". */
export type DRepReferenceKind = 'Identity' | 'Link' | 'Other';

export interface DRepReference {
  kind: DRepReferenceKind;
  label: string;
  uri: string;
}

/**
 * One row of the DRep directory — synthesized from `drep_list` (lifecycle
 * flags) + `drep_info` (voting power, deposit, expiration epoch) +
 * `drep_metadata` (CIP-119 anchor body, where the bio lives). Stored in
 * the `drep_directory` table and surfaced verbatim by the `/dreps`
 * listing endpoint.
 *
 * Fields are intentionally flat (not nested under `body`) so DynamoDB
 * GSIs can sort/filter on them without document-projection workarounds.
 * Anything optional may be absent on rows where the upstream had no
 * data — DReps without an anchor have no `givenName`, no `image`, etc.
 */
export interface DRepDirectoryEntry {
  drepId: string;
  hex: string | null;
  /** From `drep_info.active` — registered AND not expired. Inactive DReps
   *  still appear in the directory (with the "Inactive" pill) until they
   *  formally retire. Retired DReps are forced to `false` regardless of
   *  what `drep_info` reports. */
  isActive: boolean;
  /** True when `drep_list.registered === false` OR `drep_status === 'retired'`.
   *  Retired DReps have filed a retirement certificate and their voting
   *  power is forced to `"0"`. Historical anchor metadata + vote activity
   *  are still populated so the row remains browsable. Frontend shows a
   *  distinct "Retired" badge. */
  isRetired: boolean;
  /** From `drep_info.drep_status` — "registered" | "retired" | unknown. */
  status: string;
  /** Registration deposit in lovelace, stringified. Null when unknown. */
  deposit: string | null;
  hasScript: boolean;
  /** Voting power in lovelace, stringified BigInt. Mirrors `drep_info.amount`. */
  votingPower: string;
  /** Epoch at which this DRep expires unless re-registered. */
  expiresEpoch: number | null;
  /** Total delegator count. Populated on-demand by the detail handler;
   *  the directory sync skips this to avoid one Koios call per DRep. */
  delegatorCount?: number;
  // ---- Voting activity (computed from /vote_list at sync time) ----
  /** ISO-8601 timestamp of this DRep's most recent vote. Undefined when
   *  the DRep has never voted. Used by the frontend to render
   *  "Voted 3d ago" / "Never voted" badges and by the `recent` sort. */
  lastVotedAt?: string;
  /** Total number of governance votes ever cast by this DRep. Undefined
   *  before the first sync that computed it; explicitly `0` for never-
   *  voted DReps so the frontend can distinguish "no data" from "no votes". */
  voteCount?: number;
  // ---- Anchor (CIP-119 metadata) ----
  anchorUrl: string | null;
  anchorHash: string | null;
  /** Indexer's verdict on whether the anchor body matches its declared
   *  hash. Tri-state: true / false / null (not yet checked or no anchor). */
  anchorVerified: boolean | null;
  // ---- CIP-119 body fields ----
  givenName?: string;
  image?: string;
  objectives?: string;
  motivations?: string;
  qualifications?: string;
  paymentAddress?: string;
  references?: DRepReference[];
  // ---- Sync bookkeeping ----
  lastSyncedAt: string;
  enrichmentVersion: number;
}

export interface CommitteeMember {
  walletAddress: string;
  displayName?: string;
  joinedAt: string;
  role: 'lead_drep' | 'committee_member' | 'trusted_delegator';
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
}

export interface ClubhouseComment {
  commentId: string;
  authorWallet: string;
  authorDisplayName?: string;
  body: string;
  createdAt: string;
}

export interface JWTPayload {
  sub: string;
  roles: UserRole[];
  drepId?: string;
  sessionType: SessionType;
  iat: number;
  exp: number;
}

export interface AuthChallenge {
  nonce: string;
  message: string;
  expiresAt: string;
}

export interface AuthToken {
  accessToken: string;
  expiresAt: string;
  sessionType: SessionType;
}

export interface MutationNonce {
  nonce: string;
  expiresAt: string;
}

export interface AuditLogEntry {
  entityType: string;
  entityId: string;
  eventType: string;
  actorWallet: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  timestamp: string;
  ipAddressHash?: string;
  ttl?: number;
}

export interface ApiResponse<T> {
  data: T;
  meta?: ResponseMeta;
}

export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
}

export interface ResponseMeta {
  total?: number;
  page?: number;
  pageSize?: number;
  lastEvaluatedKey?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  lastEvaluatedKey?: string;
  total?: number;
}

// ---- DynamoDB Item shapes ----

export interface UserItem {
  walletAddress: string;
  SK: 'PROFILE';
  displayName?: string;
  bio?: string;
  socialLinks?: SocialLinks;
  createdAt: string;
  updatedAt: string;
  sessionTokenHash?: string | null;
  sessionExpiry?: string | null;
  roles: string[];
  drepId?: string;
  delegationHistory?: DelegationRecordItem[];
  [key: string]: unknown;
}

export interface DelegationRecordItem {
  drepId: string;
  drepName?: string;
  delegatedAt: string;
  undelegatedAt?: string;
  epochStart: number;
  epochEnd?: number;
  lovelace: string;
}

export interface DRepCommitteeItem {
  drepId: string;
  SK: 'COMMITTEE';
  leadWallet: string;
  committeeName: string;
  description: string;
  onChainMetadata?: Record<string, unknown>;
  members: CommitteeMemberItem[];
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

/**
 * DynamoDB item shape for the `drep_directory` table. PK=`drepId`,
 * SK=`'PROFILE'`. Mirrors `DRepDirectoryEntry` plus a few sortable
 * GSI keys (`votingPowerSort`, `delegatorCountSort`) — these duplicate
 * the data fields with constant partition keys so a Query can scan them
 * sorted, since DynamoDB cannot sort an entire table by a non-key field
 * without a GSI.
 */
export interface DRepDirectoryItem {
  drepId: string;
  SK: 'PROFILE';
  hex: string | null;
  isActive: boolean;
  /** True when this DRep has filed a retirement certificate
   *  (`drep_list.registered === false`). Voting power is pinned to "0".
   *  Optional on the Item shape for backwards compat with rows written
   *  before enrichmentVersion 3 — those rows had `registered === true`
   *  for every entry by definition (the old sync filtered the rest out)
   *  so the absence of the flag means `false`. */
  isRetired?: boolean;
  status: string;
  deposit: string | null;
  hasScript: boolean;
  votingPower: string;
  /** `'ALL'` — constant value used as the partition key on the
   *  `votingPower-index` GSI so we can globally sort all DReps by power. */
  votingPowerPartition: 'ALL';
  /** Voting power as a fixed-width zero-padded numeric string for
   *  lexicographic-sortable GSI sort key (DynamoDB sort keys are
   *  byte-compared). 24 digits is plenty: 10^24 lovelace = 10^18 ADA,
   *  far past total supply (45×10^9 ADA = 4.5×10^16 lovelace). */
  votingPowerSort: string;
  expiresEpoch: number | null;
  delegatorCount?: number;
  /** Constant `'ALL'` partition for the `delegatorCount-index` GSI. */
  delegatorCountPartition?: 'ALL';
  /** Same fixed-width trick for delegator count sorting — 12 digits
   *  covers any plausible delegator count (mainnet has ~1.2M total
   *  stake addresses; this fits 9999...). */
  delegatorCountSort?: string;
  /** Mirrors `DRepDirectoryEntry.lastVotedAt` — ISO-8601, undefined when
   *  the DRep has never voted. */
  lastVotedAt?: string;
  /** Constant `'ALL'` partition for the `lastVoted-index` GSI. Set on
   *  every row that has a `lastVotedAt` so a Query against the index
   *  returns voters sorted by recency. Never-voted DReps are absent
   *  from the index (which is intentional — they sort to the bottom
   *  of "Recent activity" naturally). */
  lastVotedPartition?: 'ALL';
  /** ISO-8601 lastVotedAt copied verbatim as the GSI sort key. ISO-8601
   *  is lexicographically equivalent to chronological order (provided
   *  every value uses the same UTC `Z` suffix), so no padding tricks
   *  are needed — `scanIndexForward: false` gives newest-first. */
  lastVotedSort?: string;
  /** Total number of votes ever cast by this DRep. */
  voteCount?: number;
  anchorUrl: string | null;
  anchorHash: string | null;
  anchorVerified: boolean | null;
  givenName?: string;
  /** Lowercased `givenName` for case-insensitive search filtering on
   *  the listing handler. Set when `givenName` is set. */
  givenNameLower?: string;
  image?: string;
  objectives?: string;
  motivations?: string;
  qualifications?: string;
  paymentAddress?: string;
  references?: DRepReference[];
  lastSyncedAt: string;
  enrichmentVersion: number;
  [key: string]: unknown;
}

/**
 * Detail-page shape returned by `GET /dreps/{drepId}`. Wraps the cached
 * directory item with on-demand fields (recent votes, full delegator list)
 * fetched from Koios at request time.
 */
export interface DRepDetail extends DRepDirectoryEntry {
  /** Recent votes — last ~10 actions this DRep voted on, newest first.
   *  Populated from `/drep_voters` at request time; undefined if Koios
   *  was unreachable. */
  recentVotes?: DRepRecentVote[];
  /** Total count of stake addresses delegating to this DRep. Populated
   *  from `/drep_delegators` length at request time; undefined if Koios
   *  was unreachable. */
  delegatorCountLive?: number;
}

export interface DRepRecentVote {
  proposalTxHash: string;
  proposalIndex: number;
  proposalType: string;
  /** Vote verbatim from Koios — "Yes" | "No" | "Abstain". */
  vote: string;
  /** Block time as ISO-8601 string (Koios returns Unix seconds). */
  votedAt: string;
}

export interface CommitteeMemberItem {
  walletAddress: string;
  displayName?: string;
  joinedAt: string;
  role: 'lead_drep' | 'committee_member' | 'trusted_delegator';
}

export interface GovernanceActionItem {
  actionId: string;
  SK: 'ACTION';
  actionType: string;
  /** Off-chain title — from the CIP-108 anchor body when present, else
   *  from a matched gov.tools forum draft (see `metadataSource`).
   *  Undefined when neither source yields a title. */
  title?: string;
  description: string;
  submittedAt: string;
  epochDeadline: number;
  status: string;
  sourceMetadata?: Record<string, string>;
  links?: string[];
  ingestedAt?: string;
  lastSyncedAt?: string;
  adminOverrideLabel?: string;
  editLog?: GovernanceEditItem[];
  // ---- Anchor (CIP-100/108 off-chain metadata) ----
  anchorUrl?: string;
  anchorHash?: string;
  anchorVerified?: boolean;
  abstract?: string;
  motivation?: string;
  rationale?: string;
  references?: GovernanceReference[];
  // ---- Proposal-pillar (gov.tools forum draft) fallback metadata ----
  proposalPillarUrl?: string;
  proposalPillarId?: number;
  metadataSource?: GovernanceMetadataSource;
  /** Gateway URL of the IPFS fallback hit that produced this row's body.
   *  See `GovernanceAction.metadataGateway`. */
  metadataGateway?: string;
  /** ISO timestamp of the IPFS fallback recovery. See
   *  `GovernanceAction.metadataRecoveredAt`. */
  metadataRecoveredAt?: string;
  // ---- On-chain summary ----
  summary?: string;
  details?: GovernanceDetail[];
  proposerAddress?: string;
  /** Sum of all withdrawal lovelace on this action, stringified BigInt.
   *  Persisted only for TreasuryWithdrawals (else undefined). See
   *  `GovernanceAction.treasuryWithdrawalLovelace`. */
  treasuryWithdrawalLovelace?: string;
  votes?: VoteTally;
  /** See `GovernanceAction.votingRoles` — duplicated on the DDB item shape
   *  so the persisted row carries the canonical CIP-1694 applicability map.
   *  Written by the sync at v9+. */
  votingRoles?: VotingRoles;
  [key: string]: unknown;
}

export interface GovernanceEditItem {
  editedAt: string;
  editorWallet: string;
  field: string;
  before: string;
  after: string;
}

export interface CommentItem {
  actionId: string;
  commentId: string;
  walletAddress: string;
  displayName?: string;
  body: string;
  isPublic: boolean;
  isDRep: boolean;
  createdAt: string;
  updatedAt: string;
  /** True when the action's lead DRep has marked this commenter as
   *  "recognized" (gold-star badge). Set via a future moderation action,
   *  unused at write time today. */
  starred?: boolean;
  /** ADA stake amount as a pre-formatted display string ("5.2M ₳").
   *  Populated best-effort from Blockfrost at comment-create time. */
  stakeAda?: string;
  /** Display name (or DRep ID prefix) of the DRep this commenter
   *  delegates to, populated at comment-create time. */
  drep?: string;
  [key: string]: unknown;
}

/** A clubhouse post may be a free-form discussion, an explicit question,
 *  or a poll. Polls carry the option list + the multi-choice flag. */
export type ClubhousePostType = 'discussion' | 'question' | 'poll';

export interface ClubhousePollOption {
  /** Stable identifier for the option ("a", "b", …). Used as the
   *  composite vote key. */
  id: string;
  label: string;
  /** Raw vote count. Update path is `vote.handler` — this is the
   *  authoritative tally, recomputed from individual vote records. */
  votes: number;
}

export interface ClubhousePostItem {
  drepId: string;
  postId: string;
  authorWallet: string;
  authorDisplayName?: string;
  isDRepPost: boolean;
  body: string;
  comments: ClubhouseCommentItem[];
  createdAt: string;
  updatedAt: string;
  /** Day-3 additions — optional, rolled-out post-deploy. */
  type?: ClubhousePostType;
  /** Title is optional and primarily used by polls (poll question). */
  title?: string;
  pollOptions?: ClubhousePollOption[];
  pollMultiple?: boolean;
  pollClosesAt?: string;
  /** Wallet → option-index map of votes. Stored alongside the post item;
   *  votes are low-stakes, so we trade query efficiency for atomicity. */
  pollVotes?: Record<string, number>;
  /** Display-only stake/DRep info for the post author, mirroring the
   *  comment header pill stack. Populated best-effort at create time. */
  stakeAda?: string;
  drep?: string;
  [key: string]: unknown;
}

export interface ClubhouseCommentItem {
  commentId: string;
  authorWallet: string;
  authorDisplayName?: string;
  body: string;
  createdAt: string;
}

export interface AuditLogItem {
  pk: string;
  sk: string;
  entityType: string;
  entityId: string;
  eventType: string;
  actorWallet: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  timestamp: string;
  ipAddressHash?: string;
  ttl: number;
  [key: string]: unknown;
}

export interface ChallengeRecord {
  nonce: string;
  walletAddress: string;
  message: string;
  expiresAt: string;
  createdAt: string;
}

export interface AuthContext {
  walletAddress: string;
  roles: UserRole[];
  drepId?: string;
}

export interface LambdaResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  cookies?: string[];
}
