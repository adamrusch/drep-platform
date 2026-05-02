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
  // ---- On-chain summary (built from governance_description) ----
  summary?: string;
  details?: GovernanceDetail[];
  // ---- On-chain misc ----
  proposerAddress?: string;
  // ---- On-chain vote tally (split by voter role) ----
  votes?: VoteTally;
}

/**
 * Aggregated vote counts for a governance action, bucketed by voter role.
 * Each bucket tracks the count of yes/no/abstain votes from that role.
 *
 * `cc` = constitutional committee. `drep` and `spo` are self-explanatory.
 */
export interface VoteTally {
  drep: { yes: number; no: number; abstain: number };
  spo: { yes: number; no: number; abstain: number };
  cc: { yes: number; no: number; abstain: number };
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
  // ---- On-chain summary ----
  summary?: string;
  details?: GovernanceDetail[];
  proposerAddress?: string;
  votes?: VoteTally;
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
