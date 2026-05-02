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

export interface GovernanceAction {
  actionId: string;
  actionType: GovernanceActionType;
  title: string;
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
  // ---- On-chain summary (built from governance_description) ----
  summary?: string;
  details?: GovernanceDetail[];
  // ---- On-chain misc ----
  proposerAddress?: string;
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
  title: string;
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
  // ---- On-chain summary ----
  summary?: string;
  details?: GovernanceDetail[];
  proposerAddress?: string;
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
  [key: string]: unknown;
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
