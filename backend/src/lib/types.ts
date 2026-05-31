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
  | 'trusted_delegator'
  // Platform operator. Not self-serve: seeded via the admin-bootstrap secret on
  // first auth, then granted/revoked by existing platform_admins. Gates
  // safety-mode clears and future moderation. See handlers/admin/.
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
  /** True when the IPFS body was reachable but its blake2b-256 did NOT
   *  match the on-chain `meta_hash`. The content is still surfaced (so the
   *  user sees the proposer's actual published copy), but `anchorVerified`
   *  is forced to false and the UI renders a "Hash mismatch" warning. Only
   *  set on rows where every reachable gateway returned the same wrong-
   *  hash body — i.e. the body is presumed authoritative-but-mismatched
   *  (proposer published mismatched content) rather than tampered-with. */
  anchorHashMismatch?: boolean;
  /** Short git SHA (10 hex chars) of the historical commit from which we
   *  recovered this anchor body via the `raw.githubusercontent.com`
   *  history walk. Set only when the current branch ref no longer serves
   *  the right bytes (file was moved/deleted/edited) but a prior commit
   *  does. Hash IS verified on the historical bytes — `anchorVerified`
   *  stays true on these rows. */
  anchorRecoveredFromCommit?: string;
  /** ISO-8601 commit date of the historical commit identified by
   *  `anchorRecoveredFromCommit`. Surfaces the audit trail: the user sees
   *  when the bytes they're reading were committed. */
  anchorRecoveredFromCommitDate?: string;
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
  // ---- Predefined DRep flag ----
  /** True for the two predefined Cardano auto-vote pseudo-identities
   *  (`drep_always_abstain` and `drep_always_no_confidence`). These hold
   *  enormous voting power (9B+ ADA on Abstain today) but have no CIP-119
   *  anchor body, no givenName, no image. The directory sync synthesizes
   *  rows for them with hard-coded display names so they surface in the
   *  listing alongside registered DReps. The frontend uses this flag to
   *  render a distinct "Predefined" pill and skip the avatar lookup. */
  isPredefined?: boolean;
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
  type?: ClubhousePostType;
  pinned?: boolean;
  autoSource?: AutoPostSource;
  linkedActionId?: string;
}

export interface ClubhouseComment {
  commentId: string;
  authorWallet: string;
  authorDisplayName?: string;
  body: string;
  createdAt: string;
  /** See `ClubhouseCommentItem.parentCommentId`. */
  parentCommentId?: string;
}

export interface JWTPayload {
  sub: string;
  roles: UserRole[];
  /** The wallet's REGISTERED-DRep id — set when this wallet ran the
   *  `/drep/register` flow and became a DRep themselves. NOT the DRep
   *  this wallet delegates to (that's a separate concept; see
   *  `lookupCurrentDrep` and `/auth/me`'s `delegatedToDrepId`). Used
   *  by handler code for role gating ("is the caller the lead DRep of
   *  their own committee").
   *
   *  Renamed from `drepId` on 2026-05-27. Old tokens still in
   *  circulation carry the legacy `drepId` field; `verifyJWT` accepts
   *  both during the 7-day rotation window. */
  registeredDrepId?: string;
  sessionType: SessionType;
  /** Monotonic session-revocation counter. The authorizer rejects a token
   *  whose `tokenVersion` is below the user row's current value — logout
   *  increments the row, invalidating every outstanding token at once.
   *  Absent on legacy tokens → treated as 0. */
  tokenVersion?: number;
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
  /** Session-revocation counter — incremented on logout to invalidate every
   *  outstanding JWT for this wallet. Absent → treated as 0. */
  tokenVersion?: number;
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
  /** Constant `'DREP_PROFILE'` written on every PROFILE row by the
   *  directory sync. Partition key for the `entityType-votingPower-index`
   *  GSI — a sparse-index pattern that lets the list handler do a single
   *  Query for all PROFILE rows instead of a table-wide Scan that pays
   *  for reading every `SK='POWER#NNNNNN'` history sub-row. See
   *  `infra/lib/database-stack.ts` for the GSI definition and the
   *  2026-05-26 root-cause story. Optional on the Item shape because
   *  pre-backfill rows synced before this field was introduced won't
   *  carry it; the backfill script in `backend/scripts/` populates them
   *  before the new read path is deployed. */
  entityType?: 'DREP_PROFILE';
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
  /** `'ALL'` — was the partition key for the now-removed
   *  `votingPower-index` GSI (2026-05-28). The sparse
   *  `entityType-votingPower-index` replaces the same access pattern
   *  more efficiently (sparse on PROFILE rows only). Field is still
   *  written by the directory sync to avoid touching that code from the
   *  perf PR; cleanup tracked as a follow-up. */
  votingPowerPartition: 'ALL';
  /** Voting power as a fixed-width zero-padded numeric string for
   *  lexicographic-sortable GSI sort key (DynamoDB sort keys are
   *  byte-compared). Used as the sort key on the surviving
   *  `entityType-votingPower-index` GSI. 24 digits is plenty: 10^24
   *  lovelace = 10^18 ADA, far past total supply (45×10^9 ADA =
   *  4.5×10^16 lovelace). */
  votingPowerSort: string;
  expiresEpoch: number | null;
  delegatorCount?: number;
  /** When `delegatorCount` was resolved via the `Prefer: count=exact`
   *  PostgREST path (predefined DReps as of 2026-05-28), this is set
   *  to `false` to positively signal "the count is precise." Absence
   *  means "we don't know" (legacy rows, or rows whose count was
   *  resolved via a walk-with-cap path that hit the cap). The detail
   *  handler propagates this onto the response so the frontend can
   *  render "{n}" vs "{n}+" appropriately.
   *
   *  History: predefined DReps used to be counted by a 100-page walk
   *  that timed out the directory sync, persisted a partial count
   *  (typically 5000 — the old `MAX_DELEGATORS_WALK` ceiling), and
   *  never surfaced that the value was an underestimate. The
   *  single-request `count=exact` path replaced that walk so the count
   *  is now always exact for predefined DReps. */
  delegatorCountIsApprox?: boolean;
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
  /** True for `drep_always_abstain` / `drep_always_no_confidence`. See
   *  the `DRepDirectoryEntry.isPredefined` doc for the user-visible
   *  contract; on the Item shape it's the same value persisted to
   *  DynamoDB. */
  isPredefined?: boolean;
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
   *  from `/drep_delegators` pagination walk at request time; undefined
   *  if Koios was unreachable. May be capped at `MAX_DELEGATORS_WALK`
   *  (default 1000, env-overridable) — see `delegatorCountIsApprox`. */
  delegatorCountLive?: number;
  /** True when the live count walk hit the `MAX_DELEGATORS_WALK` cap
   *  (default 1000, env-overridable) or returned a partial result from
   *  a mid-walk failure. The exact total is `>= delegatorCountLive`.
   *  UI should render "{delegatorCountLive}+" when this is true. Absent
   *  / false means the count is exact.
   *
   *  Renamed from `delegatorCountTruncated` on 2026-05-27 — "approx"
   *  better describes the contract ("≥ count") than "truncated" did. */
  delegatorCountIsApprox?: boolean;
  /** Per-epoch voting-power history, oldest-first. Populated by the
   *  daily `drep-voting-power-history` sync; undefined on rows that
   *  have not yet been captured (typically the first 24h after a new
   *  DRep registers). The frontend Sparkline reads this directly. */
  votingPowerHistory?: DRepVotingPowerSnapshot[];
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

/**
 * One epoch-snapshot of a DRep's voting power, written by the
 * `drep-voting-power-history` sync (daily). Stored under `drep_directory`
 * with `SK='POWER#${zero-padded epoch_no}'`. Surfaced on the detail
 * response as `votingPowerHistory[]` for the Sparkline component.
 *
 * `amount` is the stringified BigInt lovelace, matching the convention
 * used for `votingPower` on the live PROFILE row.
 */
export interface DRepVotingPowerSnapshot {
  epochNo: number;
  amount: string;
}

/**
 * Persisted row shape for the `POWER#`-prefixed history items. Same PK
 * (`drepId`) as the PROFILE row; SK shape is `POWER#${zero-padded epoch}`.
 * Frontend never sees this shape directly — the detail handler converts
 * to `DRepVotingPowerSnapshot[]` before serving.
 */
export interface DRepPowerHistoryItem {
  drepId: string;
  SK: string;
  epochNo: number;
  amount: string;
  capturedAt: string;
  [key: string]: unknown;
}

export interface CommitteeMemberItem {
  walletAddress: string;
  displayName?: string;
  joinedAt: string;
  role: 'lead_drep' | 'committee_member' | 'trusted_delegator';
}

// ============================================================
// Phase 2 — committee voting
// ============================================================

/** The DRep's official position a proposal asks the committee to adopt. */
export type CommitteePosition = 'Yes' | 'No' | 'Abstain';
/** How a committee member votes on a proposal. */
export type CommitteeCastVote = 'Agree' | 'Disagree' | 'Abstain';
export type CommitteeProposalStatus =
  | 'open'
  | 'passed'
  | 'failed'
  | 'withdrawn'
  | 'epoch_finalized';
/** Who may author a committee's rationale (lead chooses per committee). */
export type RationaleMode = 'lead' | 'assigned' | 'collaborative';

/** A fresh CIP-30 (CIP-8 COSE_Sign1) signature captured for a mutation.
 *  `signedMessage` is the exact plaintext signed so a reviewer can
 *  independently re-verify. Stage is embedded in the message (not here). */
export interface CommitteeSignature {
  mutationNonce: string;
  mutationSignature: string;
  mutationKey: string;
  signedMessage: string;
}

/** SK='PROPOSAL' — the single proposal per (committee, action). */
export interface CommitteeVoteProposalItem {
  voteScope: string; // `${drepId}#${actionId}`
  itemKey: 'PROPOSAL';
  drepId: string;
  actionId: string;
  proposedPosition: CommitteePosition;
  proposerWallet: string;
  proposerSignature: CommitteeSignature;
  status: CommitteeProposalStatus;
  /** Snapshotted from VOTING_CONFIG at open time — a mid-vote config change
   *  does NOT retroactively re-threshold an in-flight proposal. */
  thresholdPct: number;
  quorum: number;
  /** Copied from governance_actions so the deadline sweep needs no join.
   *  Also the sparse-GSI sort key. */
  epochDeadline: number;
  /** Sparse GSI partition: 'OPEN' while open, REMOVED on any terminal state. */
  statusPartition?: 'OPEN';
  openedAt: string;
  closedAt?: string;
  closedByWallet?: string;
  closedReason?: 'manual_pass' | 'manual_fail' | 'withdrawn' | 'epoch_deadline';
  /** Tally snapshot stamped at close/finalize for historical display. */
  finalTally?: CommitteeTallySnapshot;
  [key: string]: unknown;
}

export interface CommitteeTallySnapshot {
  agreeCount: number;
  disagreeCount: number;
  abstainCount: number;
  activePool: number;
  agreePct: number;
}

/** SK='CAST#<wallet>' — latest cast per voter (overwritten on re-vote). */
export interface CommitteeVoteCastItem {
  voteScope: string;
  itemKey: string; // `CAST#${walletAddress}`
  drepId: string;
  actionId: string;
  voterWallet: string;
  vote: CommitteeCastVote;
  votedAt: string;
  changeCount: number;
  signature: CommitteeSignature;
  [key: string]: unknown;
}

/** SK='RATIONALE#DRAFT' — collaborative working draft (CIP-100/108 fields). */
export interface CommitteeRationaleDraftItem {
  voteScope: string;
  itemKey: 'RATIONALE#DRAFT';
  drepId: string;
  actionId: string;
  rationaleStatement: string;
  summary?: string;
  precedentDiscussion?: string;
  counterargumentDiscussion?: string;
  conclusion?: string;
  internalVote?: {
    constitutional?: number;
    unconstitutional?: number;
    abstain?: number;
    didNotVote?: number;
  };
  references?: Array<{ '@type'?: string; label: string; uri: string }>;
  authors?: Array<{ name: string; witness?: Record<string, unknown> }>;
  /** Optimistic-concurrency token (If-Match). */
  updatedAt: string;
  editorTimeline?: Array<{ wallet: string; editedAt: string }>;
  [key: string]: unknown;
}

/** SK='RATIONALE#LOCK' — pessimistic edit lock for collaborative mode. */
export interface CommitteeRationaleLockItem {
  voteScope: string;
  itemKey: 'RATIONALE#LOCK';
  editorWallet: string;
  acquiredAt: string;
  lastHeartbeat: string;
  /** Epoch seconds; lock auto-expires after 20 min of no heartbeat. */
  expiresAt: number;
  [key: string]: unknown;
}

/** SK='RATIONALE#FINAL' — locked rationale + canonical anchor + IPFS URI. */
export interface CommitteeRationaleFinalItem {
  voteScope: string;
  itemKey: 'RATIONALE#FINAL';
  drepId: string;
  actionId: string;
  /** Canonical CIP-100/108 JSON (sorted keys) that was hashed + pinned. */
  canonicalJson: string;
  anchorHash: string; // blake2b-256 hex of canonicalJson bytes
  hashAlgorithm: 'blake2b-256';
  ipfsUri?: string; // ipfs://<cid> once pinned
  ipfsCid?: string;
  finalizedBy: string;
  finalizedAt: string;
  [key: string]: unknown;
}

/** SK='SUBMISSION' — on-chain vote receipt. */
export interface CommitteeSubmissionItem {
  voteScope: string;
  itemKey: 'SUBMISSION';
  drepId: string;
  actionId: string;
  position: CommitteePosition;
  anchorHash?: string;
  anchorUrl?: string;
  /** Snapshot of the finalized canonical CIP-100/108 bytes that hash to
   *  `anchorHash`. Frozen here so the submission record verifies against the
   *  on-chain anchor independently of the (now-locked) RATIONALE#FINAL row. */
  canonicalJson?: string;
  txHash: string;
  broadcastStage: string; // 'prod' — test never broadcasts
  submittedBy: string;
  submittedAt: string;
  rationaleOverridden?: boolean; // submitted without a rationale via override
  [key: string]: unknown;
}

/** SK='VOTING_CONFIG' on drep_committees — lead-configured voting rules. */
export interface VotingConfigItem {
  drepId: string;
  SK: 'VOTING_CONFIG';
  /** Supermajority threshold applied to the non-abstaining pool. 51..100. */
  thresholdPct: number;
  /** Minimum non-abstaining voters before a proposal can resolve. */
  quorum: number;
  rationaleMode: RationaleMode;
  /** Wallet of the assigned author when rationaleMode==='assigned'. */
  assignedEditor?: string;
  setBy: string;
  setAt: string;
  history?: Array<{ thresholdPct: number; rationaleMode: RationaleMode; wallet: string; at: string }>;
  [key: string]: unknown;
}

/** committee_membership table — one row per wallet, total. */
export interface CommitteeMembershipItem {
  walletAddress: string;
  drepId: string;
  role: 'lead' | 'member';
  joinedAt: string;
  [key: string]: unknown;
}

/** platform_state table — PK stateKey='SAFETY_MODE'. */
export interface PlatformSafetyModeItem {
  stateKey: 'SAFETY_MODE';
  active: boolean;
  triggeredAt?: string;
  /** Epoch seconds; the latch auto-clears after 72h unless an admin clears it. */
  expiresAt?: number;
  triggeredByCount?: number;
  clearedBy?: string;
  clearedAt?: string;
  [key: string]: unknown;
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
  /** True when IPFS served content whose hash didn't match the on-chain
   *  anchor hash. See `GovernanceAction.anchorHashMismatch`. */
  anchorHashMismatch?: boolean;
  /** Short git SHA (10 hex chars) of the historical commit identified by
   *  the GitHub history-walk fallback. See
   *  `GovernanceAction.anchorRecoveredFromCommit`. */
  anchorRecoveredFromCommit?: string;
  /** ISO-8601 date of that historical commit. */
  anchorRecoveredFromCommitDate?: string;
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
  /** Top-level comment id this comment is a reply to. Undefined for
   *  top-level comments. Replies are restricted to one level — the create
   *  handler rejects with 400 if `parentCommentId` itself points to a
   *  comment that already has a `parentCommentId`. */
  parentCommentId?: string;
  /** Denormalized running support level — sum of (lovelace × ±1) across
   *  every active vote on this comment. Seeded with the author's stake
   *  at create time (implicit upvote). Mutated by `handlers/comments/
   *  vote.ts` via `transactWrite` so it stays consistent with the per-
   *  vote rows in the `comment_votes` table.
   *
   *  # Wire shape (post 2026-05-28 P0-2 fix)
   *
   *  Stored as a DDB Number (`N`) so the vote handler's atomic `ADD :delta`
   *  works. The doc client's `smartUnwrapNumber` returns this field as:
   *    - `number` when its magnitude fits in `Number.MAX_SAFE_INTEGER`
   *      (~9.0×10^15 lovelace ≈ 9 trillion ADA), or
   *    - `bigint` when it exceeds that ceiling (a popular comment whose
   *      summed support crosses the safe-int boundary).
   *  Legacy rows written before the P0-2 fix may still surface as
   *  `string` (DDB `S`) until the lazy migration in the vote handler
   *  flips them to `N` on first vote, OR until the broadened
   *  `backfill-legacy-comment-seeds.ts` script processes them. Read
   *  paths feed this through `safeBigInt` which accepts all three. */
  supportLovelace?: string | number | bigint;
  /** Headcount of active upvotes (including author seed). Optional only
   *  for backwards compat with rows written before this field landed —
   *  treat absence as zero. */
  upvoteCount?: number;
  /** Headcount of active downvotes. */
  downvoteCount?: number;
  [key: string]: unknown;
}

/**
 * One row of `comment_votes` — PK=`commentId`, SK=`stakeAddress`. Author
 * seed votes are written here too with no special flag; the author can't
 * delete their seed vote because the API checks `existing.walletAddress
 * === voter` and rejects (delete the whole comment instead).
 *
 * `lovelace` is a SNAPSHOT taken at vote time. Re-reading would let the
 * total drift silently as wallets gain/lose balance — we deliberately
 * fix it on the row so the displayed support level is reproducible.
 */
export interface CommentVoteItem {
  commentId: string;
  stakeAddress: string;
  /** Foreign key — same value as the parent comment's `actionId`. We carry
   *  it on the vote row purely so a future cleanup job can find every
   *  vote belonging to a deleted action's comments without joining
   *  through the `comments` table. Not used on the hot read path. */
  actionId: string;
  vote: 'up' | 'down';
  /** Snapshot of the voter's wallet stake in lovelace at vote time,
   *  stringified BigInt. Signed by the `vote` field — sum-on-read is
   *  `vote === 'up' ? +lovelace : -lovelace`.
   *
   *  Mutable: re-weighted by the 3-hourly `revalidate-comment-stake`
   *  sync (Batch REVAL, 2026-05-29) when the voter's wallet stake has
   *  changed since the prior reading. The sweep overwrites this field
   *  with the new `total_balance` and paired-atomically mutates the
   *  parent comment's `supportLovelace` by the delta. See the sync's
   *  module header for the full re-weight formula and the "never zero
   *  on lookup failure" guard. */
  lovelace: string;
  votedAt: string;
  /** Optional cache of voter display name, populated best-effort at vote
   *  time. The frontend doesn't render the vote list, so this is purely
   *  for a future audit / leaderboard UI. */
  voterDisplayName?: string;
  [key: string]: unknown;
}

/**
 * One row of `comment_voters` — the registry that lets the 3-hourly
 * `revalidate-comment-stake` sweep enumerate every distinct voting
 * wallet in O(voters) rather than walking the full `comment_votes`
 * table.
 *
 * PK=`stakeAddress`, no SK. Maintained by the vote-write paths
 * (`comments/vote.ts` + `comments/create.ts`'s seed-upvote) via atomic
 * `ADD voteCount :one SET lastKnownStake = :s, lastCheckedAt = :now`
 * — best-effort (a registry-upsert failure must NEVER fail the
 * underlying vote write). Re-validated by the sync's `lastKnownStake`
 * compare against the live `total_balance`.
 *
 * # Why `lastKnownStake` is stringified
 *
 * Same reason as `CommentVoteItem.lovelace` — lovelace can exceed
 * `Number.MAX_SAFE_INTEGER` (45×10^9 ADA = 4.5×10^16 lovelace), so we
 * carry the string and convert to `bigint` at use-time. Comparing
 * "did this wallet's stake change?" is a BigInt equality check; the
 * string form survives DynamoDB round-trip without `wrapNumbers`
 * special-casing.
 */
export interface CommentVoterItem {
  /** PK — bech32 `stake1...` (the voter wallet). */
  stakeAddress: string;
  /** Snapshot of the wallet's `total_balance` (lovelace, stringified
   *  BigInt) from the last successful upstream reading. The sweep
   *  compares the live Koios `total_balance` to this value; equal =
   *  cheap-skip (no re-weight needed). Updated AFTER a successful
   *  re-weight transaction, OR on every vote-write (the vote handler
   *  already has a fresh snapshot in hand).
   *
   *  Stringified BigInt for the same precision-preservation reason as
   *  `CommentVoteItem.lovelace`. Defaults to `'0'` on first-write when
   *  the upstream returned null (unregistered wallet). */
  lastKnownStake: string;
  /** ISO-8601 of the most recent upsert. Informational. */
  lastCheckedAt: string;
  /** Monotonic counter of votes this wallet has cast on the platform.
   *  Atomically incremented via `ADD :one` on every vote-write (cast +
   *  recast — NOT decremented on a `vote: 'none'` remove, since the
   *  voter is still "active" in the registry). Useful for future audit
   *  / leaderboard surfaces; the sweep itself doesn't consume it. */
  voteCount: number;
  [key: string]: unknown;
}

/** A clubhouse post may be a free-form discussion, an explicit question,
 *  a poll, or an auto-generated governance-action feed post. `auto_ga` is
 *  written by the `governance-intake` sync — one per active DRep per
 *  active GA — so every clubhouse surfaces every live action with a
 *  predictable layout (pinned at top, "drep.tools governance feed" author
 *  label, link to the GA, body frozen at first-sync time). */
export type ClubhousePostType = 'discussion' | 'question' | 'poll' | 'auto_ga';

/** Provenance + frozen-at metadata for an `auto_ga` clubhouse post. The
 *  `abstractFrozenAt` timestamp marks when this specific row captured its
 *  body — by design that's "first sync into THIS clubhouse" (not "first
 *  time the GA was ever seen by the platform"). A DRep that becomes
 *  active a week after a GA goes live gets a post whose abstract reflects
 *  what was current at THEIR activation; subsequent GA-metadata changes
 *  do not update the post. See `governance-intake.ts` /
 *  `drep-directory.ts` for the write paths. */
export interface AutoPostSource {
  kind: 'governance_action';
  actionId: string;
  abstractFrozenAt: string;
}

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
  /** @deprecated Inline `comments[]` was REMOVED in P0-3 Phase 6
   *  (2026-05-28). New writes (`createPost.ts`, `clubhouseAutoPosts.ts`,
   *  `backfill-ga-auto-posts.ts`) no longer set this field; the source
   *  of truth is the `clubhouse_comments` table. Kept optional only
   *  for back-compat reads of pre-Phase-6 rows (effectively empty in
   *  prod — the feature was never used pre-migration). The Phase 7
   *  cleanup script (`backend/scripts/cleanup-inline-comments.ts`)
   *  strips this attribute from existing rows. */
  comments?: ClubhouseCommentItem[];
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
  /** ---- auto_ga additions (Batch B, 2026-05-26) ---- */
  /** Pinned-at-top flag. Auto-posts default to `true` on creation and
   *  flip to `false` when the linked GA transitions to `executed` /
   *  `expired` (the daily completion sweep does the flip). Frontend
   *  reads this to bubble pinned posts above chronological ones. Absent
   *  on non-auto rows; treat absence as `false`. */
  pinned?: boolean;
  /** Provenance for auto-generated posts. Present only when
   *  `type === 'auto_ga'`. `abstractFrozenAt` is the ISO timestamp that
   *  this row's body was captured at — used by the UI to render the
   *  "frozen at sync time" annotation. Subsequent GA-anchor metadata
   *  changes do NOT update the body. */
  autoSource?: AutoPostSource;
  /** Convenience denormalization of `autoSource.actionId` lifted to the
   *  top level so DynamoDB GSIs can partition on it. Used as the GSI
   *  partition key on `linkedActionId-index` (see database-stack.ts).
   *  Present only when `type === 'auto_ga'`. */
  linkedActionId?: string;
  /** ---- P0-3 de-inline migration (2026-05-28) ---- */
  /** Number of per-row comments in the new `clubhouse_comments` table
   *  for this post. Denormalized counter — incremented atomically via
   *  DynamoDB `ADD :one` on every `createComment`. Replaces the
   *  cardinality read off `comments.length` for the collapsed-card "{n}
   *  replies" badge and the rail ranker.
   *
   *  Frontend renders `commentCount ?? comments?.length ?? 0` during
   *  rotation — older rows that pre-date the backfill may still have
   *  the inline array AND no counter. Once the backfill completes,
   *  every post row carries `commentCount`. */
  commentCount?: number;
  /** ISO-8601 timestamp of the most recent comment in `clubhouse_comments`
   *  for this post. Denormalized via `SET lastReplyAt = :now` on every
   *  `createComment`. Powers the rail ranker's "active in last 24h"
   *  filter without scanning the comment set. Absent on posts with zero
   *  comments. */
  lastReplyAt?: string;
  [key: string]: unknown;
}

/** A clubhouse comment can be top-level OR a reply to a top-level
 *  comment OR a reply to a reply (Clubhouse rules: 2 levels deep — one
 *  deeper than the Public Comments surface, which is 1-level). The
 *  `parentCommentId` field marks the immediate parent in the thread.
 *  Top-level comments have no `parentCommentId`. The depth guard in
 *  `clubhouse/createComment.ts` enforces the 2-level rule by
 *  rejecting any reply whose parent is itself a reply AND whose
 *  parent's parent is also a reply (i.e. depth would become 3).
 *
 *  This shape mirrors the legacy inline rows stored on
 *  `ClubhousePostItem.comments[]`. The same shape is also returned by
 *  the new `listComments.ts` handler that reads from the
 *  `clubhouse_comments` table (see `ClubhouseCommentRowItem` for the
 *  full persisted shape). */
export interface ClubhouseCommentItem {
  commentId: string;
  authorWallet: string;
  authorDisplayName?: string;
  body: string;
  createdAt: string;
  /** Optional — when present, this comment is a reply to the named
   *  comment. The Clubhouse surface allows 2 levels of nesting
   *  (top-level → reply → sub-reply), so a reply may itself have a
   *  parent that is also a reply. 3-deep is rejected at the API
   *  layer. */
  parentCommentId?: string;
}

/**
 * Persisted row shape for the `clubhouse_comments` table. PK=`postKey`
 * (= `${drepId}#${postId}`), SK=`commentId` (ULID).
 *
 * One row per comment — replaces the legacy inline
 * `clubhouse_posts.comments[]` array (P0-3 migration, 2026-05-28).
 *
 * `depth` is persisted on the row so the create handler does NOT need
 * to walk the entire thread to decide whether a new reply would exceed
 * the 2-level cap. A new reply only needs one `GetItem` on its parent
 * — `newDepth = parent.depth + 1`, reject if `parent.depth >= 2`.
 *
 * `drepId` + `postId` are denormalized onto every row even though they
 * can be derived from `postKey`. This keeps the row trivially usable as
 * a `ClubhouseCommentItem` after the projected fields are stripped, and
 * avoids the FE/BE having to parse out a composite key. The marginal
 * storage cost is ~0.1KB/row × ~2500 rows = pennies.
 */
export interface ClubhouseCommentRowItem {
  /** `${drepId}#${postId}` — the partition key. Single Query returns
   *  every comment for one post in ULID-ascending order. */
  postKey: string;
  /** ULID — monotonic on insertion timestamp; sort key. */
  commentId: string;
  /** Denormalized — same as the parent post's drepId. */
  drepId: string;
  /** Denormalized — same as the parent post's postId. */
  postId: string;
  authorWallet: string;
  authorDisplayName?: string;
  body: string;
  createdAt: string;
  /** Set when this row is a reply. Top-level rows omit the field. */
  parentCommentId?: string;
  /** Nesting depth — 0 = top-level, 1 = reply, 2 = sub-reply. Persisted
   *  on the row so `createComment` doesn't have to walk the whole
   *  thread to enforce the 2-level cap. */
  depth: 0 | 1 | 2;
  /** Batch CLUBHOUSE-DELEGATION-GATE (2026-05-30).
   *
   *  Set to `false` by the 3-hour clubhouse-delegation revalidation
   *  sweep (`backend/src/sync/revalidate-comment-stake.ts` —
   *  `runRevalidateClubhouseDelegations`) when the author's wallet is
   *  confirmed (via Koios `delegated_drep`) to no longer delegate to
   *  this clubhouse's DRep AND the author is not a committee role-
   *  holder. The sweep clears it back to `true` if the author re-
   *  delegates to this DRep (self-healing).
   *
   *  Absent / undefined / true all mean "active" — the frontend
   *  renders the badge strictly on `=== false`. Defaulting to absent
   *  on first-write avoids a migration; the sweep populates the
   *  attribute only when it flips. */
  authorDelegationActive?: boolean;
  [key: string]: unknown;
}

/**
 * Compose the PK used by the `clubhouse_comments` table. Exported so
 * every read/write site uses the same shape — the format is part of
 * the table contract.
 */
export function clubhouseCommentPostKey(drepId: string, postId: string): string {
  return `${drepId}#${postId}`;
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
