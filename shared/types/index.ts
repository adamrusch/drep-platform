// ============================================================
// Cross-layer shared TypeScript types
// Used by both backend Lambda handlers and frontend React app
// ============================================================

export type UserRole =
  | 'guest'
  | 'delegator'
  | 'committee_member'
  | 'lead_drep'
  | 'trusted_delegator'
  | 'platform_admin';

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

// ---- Governance ----

export interface GovernanceAction {
  actionId: string;
  actionType: GovernanceActionType;
  title: string;
  description: string;
  submittedAt: string; // ISO-8601
  epochDeadline: number;
  status: GovernanceActionStatus;
  sourceMetadata?: Record<string, string>;
  links?: string[];
  ingestedAt?: string;
  lastSyncedAt?: string;
  adminOverrideLabel?: string;
  editLog?: GovernanceActionEdit[];
}

export interface GovernanceActionEdit {
  editedAt: string;
  editorWallet: string;
  field: string;
  before: string;
  after: string;
}

// ---- DRep / Committee ----

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

// ---- User / Profile ----

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

// ---- Comments ----

export interface Comment {
  actionId: string;
  commentId: string; // ULID
  walletAddress: string;
  displayName?: string;
  body: string;
  isPublic: boolean;
  isDRep: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---- Clubhouse ----

export interface ClubhousePost {
  drepId: string;
  postId: string; // ULID
  authorWallet: string;
  authorDisplayName?: string;
  isDRepPost: boolean;
  body: string;
  comments: ClubhouseComment[];
  createdAt: string;
  updatedAt: string;
}

export interface ClubhouseComment {
  commentId: string; // ULID
  authorWallet: string;
  authorDisplayName?: string;
  body: string;
  createdAt: string;
}

// ---- Auth ----

export interface JWTPayload {
  sub: string; // walletAddress
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
  expiresAt: string; // 5 minutes
}

// ---- Audit ----

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

// ---- API Response shapes ----

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
