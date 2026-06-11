// Frontend type definitions — mirrors shared/types/index.ts
// Kept local to avoid cross-workspace import issues with Vite's bundler resolution

export type UserRole =
  | 'guest'
  | 'delegator'
  | 'committee_member'
  | 'lead_drep'
  | 'trusted_delegator'
  | 'platform_admin';

/**
 * On-chain proven roles (Sprint 1 — mirror of the backend `OnChainRole`).
 *
 * Travel as a parallel `onChainRoles[]` JWT claim alongside `UserRole`-
 * shaped `roles`. The two surfaces are intentionally distinct: `UserRole`
 * is the platform-internal role assignment (delegator / lead_drep / etc.);
 * `OnChainRole` is a credential that was just proven on-chain via a
 * fresh signature. A user might hold both (e.g. a `delegator` who is also
 * a `drep` on-chain), or only one (a wallet-less SPO that proved its
 * pool's Calidus key but has no `lead_drep` row).
 */
export type OnChainRole = 'drep' | 'spo' | 'cc' | 'proposer';

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
  /** Public IPFS gateway URL (e.g. `https://ipfs.io/ipfs/Qm…`) that served
   *  the hash-verified anchor body when Koios's internal gateway couldn't
   *  retrieve it. Undefined on the happy path (Koios sufficed) and on rows
   *  where every public gateway also failed. */
  metadataGateway?: string;
  /** ISO timestamp of the sync cycle that recovered the anchor body via
   *  the IPFS multi-gateway fallback. Undefined for rows that didn't need
   *  the fallback. */
  metadataRecoveredAt?: string;
  /** True when IPFS served body content but its blake2b-256 hash did NOT
   *  match the on-chain `anchorHash`. The body is surfaced for the user but
   *  cryptographically unverifiable. `anchorVerified` is forced to false on
   *  these rows. UI renders a distinct "Hash mismatch" warning (vs the
   *  green "Anchor verified" badge). */
  anchorHashMismatch?: boolean;
  /** Short git SHA (10 hex chars) of the historical commit from which the
   *  anchor body was recovered. Set only when the `raw.githubusercontent.com`
   *  history-walk fallback ran — the current branch ref served the wrong
   *  bytes (file moved/deleted/edited) but a prior commit hash-matched.
   *  `anchorVerified` stays true because we verified the historical bytes. */
  anchorRecoveredFromCommit?: string;
  /** ISO-8601 commit date of the historical commit identified by
   *  `anchorRecoveredFromCommit`. The UI surfaces it so the user can see
   *  when the bytes they're reading were committed. */
  anchorRecoveredFromCommitDate?: string;
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
  /** Every individual vote cast on this action, newest-first, with the
   *  supersede / strikethrough dedupe rule applied. Returned by
   *  `GET /governance/{actionId}`. Older clients that ignore this field
   *  keep working. */
  voteList?: ActionVoteRecord[];
}

/** Voter role tag — matches the Koios surface. */
export type VoteVoterRole = 'DRep' | 'SPO' | 'ConstitutionalCommittee';

/**
 * One vote row on a governance action — the unit rendered by the Votes
 * tab on the action detail page. Mirrors `backend/src/lib/votes.ts`.
 *
 * `superseded === true` rows are votes that the same voter later recast;
 * the UI renders them with `line-through` styling so the full audit trail
 * is visible without misleading the reader about which vote is "live".
 *
 * `votingPowerLovelace` is the voter's power AT THE TIME OF THE VOTE
 * when the historical `POWER#{epoch}` snapshot is available in the
 * `drep_directory` cache; otherwise it's their CURRENT power and
 * `votingPowerIsApprox === true` flags that the row should render with
 * an asterisk and a "historical snapshot unavailable" tooltip.
 */
export interface ActionVoteRecord {
  voterRole: VoteVoterRole;
  voterId: string;
  voterDisplayName?: string;
  votingPowerLovelace?: string;
  /** When true, `votingPowerLovelace` is the voter's CURRENT power
   *  (the historical snapshot for the vote's epoch was unavailable).
   *  Absent / undefined when the power is the genuine historical
   *  snapshot. */
  votingPowerIsApprox?: boolean;
  /** SPO voter only — registered pool ticker (e.g. "ADA") from the
   *  `pool_metadata` cache. The frontend renders
   *  `${ticker} — ${name}` when both are present. */
  poolTicker?: string;
  /** SPO voter only — registered pool name from the `pool_metadata`
   *  cache. */
  poolName?: string;
  /** Constitutional Committee voter only — display name from the
   *  `cc_members` cache. When absent the frontend renders
   *  `CC Member ({hotCred truncated})` so individuals stay
   *  distinguishable. */
  ccName?: string;
  vote: 'Yes' | 'No' | 'Abstain';
  votedAt: string;
  blockTime: number;
  voteTxHash: string;
  /** CIP-100 anchor URL the voter posted with this vote (their rationale).
   *  Open in a new tab with `rel="noopener noreferrer"`. */
  rationaleUrl?: string;
  /** Cached rationale TEXT, downloaded from the anchor (IPFS/https) and
   *  hash-verified server-side. When present, render it inline (expandable)
   *  instead of just linking out to the IPFS gateway. */
  rationaleText?: string;
  /** Cached CIP-108 title for the rationale, when the body had one. */
  rationaleTitle?: string;
  /** Fetch outcome: `cached` | `hash_mismatch` | `empty` | `unreachable` |
   *  `unsupported`. Absent until the background sync has fetched it. */
  rationaleStatus?: string;
  /** True when `rationaleText` was truncated to the storage cap — show a
   *  "read full on source" affordance. */
  rationaleTruncated?: boolean;
  /** false → the fetched body did NOT match the on-chain hash; render a
   *  caveat. true / absent → verified or nothing to verify. */
  rationaleHashMatch?: boolean;
  superseded: boolean;
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
  /** X — number of Agree votes required for "Committee Approved". Decision B
   *  ("Chair's full X stands"): the Chair's intended threshold over their
   *  intended roster — it does NOT shrink as invitations are pending. */
  approvalThreshold: number;
  /** N — current ACCEPTED committee size (`members.length`). */
  memberCount: number;
  /** The Chair's INTENDED committee size: 1 (Chair) + every invited member,
   *  regardless of accept/decline status. UI surfaces "X of N — currently
   *  {memberCount} accepted" against this denominator. Optional for back-
   *  compat with rows synced before the invitation feature. */
  intendedMemberCount?: number;
  /** Every invitation belonging to this committee (any status). Returned
   *  on `GET /drep/{drepId}` so the Chair-side settings UI can render the
   *  pending list with a Revoke button. Empty when no invites have ever
   *  been issued. */
  invitations?: CommitteeInvitation[];
  createdAt: string;
  updatedAt: string;
}

/** One INVITE row from the platform's invitation surface. The platform
 *  promotes accepted invitees into `DRepCommittee.members[]`; this shape
 *  carries the audit trail of every invitation (pending, accepted,
 *  rejected, revoked). */
export interface CommitteeInvitation {
  drepId: string;
  inviteeStake: string;
  status: 'pending' | 'accepted' | 'rejected' | 'revoked';
  role: 'committee_member' | 'trusted_delegator';
  displayName?: string;
  invitedBy: string;
  invitedAt: string;
  respondedAt?: string;
}

/** Slim per-invitation view returned on `/auth/me` for the bell badge and
 *  Accept-Reject dashboard card. Mirrors the backend's PendingInvitationView. */
export interface PendingInvitationSummary {
  drepId: string;
  committeeName: string;
  role: 'committee_member' | 'trusted_delegator';
  invitedAt: string;
}

export interface CommitteeMember {
  walletAddress: string;
  displayName?: string;
  joinedAt: string;
  role: 'lead_drep' | 'committee_member' | 'trusted_delegator';
  /** True when this member's stake address has ever signed in to the platform.
   *  Optional for backwards compat with legacy committee rows synced before the
   *  active flag existed — treat absence as `false`. */
  active?: boolean;
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
  /** True for the two Cardano predefined DReps (`drep_always_abstain`,
   *  `drep_always_no_confidence`). These hold the largest voting power
   *  on mainnet (~9B ADA between them) but have no CIP-119 anchor
   *  metadata — no name, no image, no objectives. The sync hard-codes
   *  display names ("Always Abstain" / "Always No-Confidence"). UI uses
   *  this flag to render a distinct "Predefined" badge and skip avatar
   *  image fallback logic. Optional for backwards compat with rows
   *  synced before this flag existed. */
  isPredefined?: boolean;
  /** Sprint 5 — sha256-hex of the self-hosted avatar bytes living at
   *  `/api/avatar/<hash>`. Set once the avatar-store sync has
   *  downloaded and validated the upstream `image` URL. Absent / null
   *  means "no self-hosted avatar yet — render the cardenticon
   *  identicon as fallback." See `lib/drepAvatar.ts`. */
  imageContentHash?: string | null;
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
  /** Live delegator count from Koios `/drep_delegators` pagination walk
   *  at request time. Capped at `MAX_DELEGATORS_WALK` (default 1000,
   *  env-overridable backend-side) — when `delegatorCountIsApprox` is
   *  true the actual count is `>= delegatorCountLive` and the UI should
   *  render "{n}+" rather than the precise count. */
  delegatorCountLive?: number;
  /** True when the backend walk hit its cap or returned a partial
   *  result. Real count is `>= delegatorCountLive`. Renamed from
   *  `delegatorCountTruncated` on 2026-05-27. */
  delegatorCountIsApprox?: boolean;
  /** Per-epoch voting-power history, oldest-first. Populated by the
   *  daily `drep-voting-power-history` sync. Undefined on rows that have
   *  not yet been captured (typical first 24h after a new DRep registers
   *  or before the Phase C sync deploy has run its first cycle). The
   *  Sparkline component on the DRep detail page reads this directly. */
  votingPowerHistory?: DRepVotingPowerSnapshot[];
}

/**
 * One epoch-snapshot of a DRep's voting power, sourced from Koios
 * `/drep_voting_power_history` via the daily sync and surfaced on
 * `DRepDetail.votingPowerHistory`.
 */
export interface DRepVotingPowerSnapshot {
  epochNo: number;
  /** Voting power in lovelace, stringified BigInt. */
  amount: string;
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
  /**
   * REGISTERED-DRep id (this wallet IS a DRep). Set when the user ran
   * `/drep/register`. Used for role-gating their own DRep committee.
   *
   * NOT to be confused with `delegatedToDrepId` — those are different
   * concepts on-chain. If you're trying to answer "which DRep does
   * this wallet back?" use `delegatedToDrepId`, NOT this field.
   */
  drepId?: string;
  /** True when this wallet is a registered DRep (leads a committee). */
  isDRep?: boolean;
  /** The DRep's on-chain name, when isDRep. */
  drepName?: string;
  /** Effective display name (profile name → DRep name) computed server-side. */
  resolvedDisplayName?: string;
  /**
   * Live on-chain delegation: the DRep this wallet's stake currently
   * delegates voting power to. Read live by `/auth/me` from Koios
   * (Blockfrost fallback) and cached for 60s per Lambda container.
   *
   *   - `string` → wallet is delegated to this DRep (bech32 `drep1...`
   *     or a predefined ID like `drep_always_abstain`).
   *   - `null` → wallet is NOT delegated (confirmed by the upstream).
   *   - `undefined` (field absent) → could not determine. Most common
   *     causes: payment-address auth, both Koios + Blockfrost down,
   *     or this is a brand-new stake account.
   */
  delegatedToDrepId?: string | null;
  /** Every committee invitation the wallet currently has pending. Empty
   *  array when there are none. Set by the `/auth/me` handler via a single
   *  Query against the sparse `inviteeStake-status-index` GSI. The bell
   *  badge in the topbar surfaces the count; the dashboard Invitation card
   *  renders one row per entry with Accept/Reject buttons. */
  pendingInvitations?: PendingInvitationSummary[];
  /** When true, any NEW committee invitation issued to this wallet is
   *  auto-rejected at creation (no membership slot claimed). Existing
   *  pending invitations are NOT touched by flipping this toggle — use the
   *  "Decline all pending" button (POST /me/invitations/decline-all) for
   *  that. Absent / false → invitations land as pending normally. */
  autoDeclineInvites?: boolean;
  /**
   * The user's JOINED committee (role 'lead' or 'member'), or null when
   * they belong to no committee. Set by `/auth/me` from the
   * committee_membership table.
   *
   * This is the source of truth for granting committee-space access — in
   * particular to a non-lead MEMBER, who has NO `drepId` of their own (the
   * committee's drepId belongs to the lead). UI must gate the committee
   * landing/room off THIS field for members, not `drepId` (always absent
   * for members) or a JWT role (stale until the member re-logs in).
   */
  committeeMembership?: {
    drepId: string;
    role: 'lead' | 'member';
    committeeName: string;
  } | null;
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
  /** When present, this comment is a reply to the named top-level
   *  comment. Replies are restricted to one level deep — the backend
   *  rejects a reply whose parent is itself a reply. */
  parentCommentId?: string;
  /** Stake-weighted support level: signed BigInt (as string) of
   *  `sum(up.lovelace) - sum(down.lovelace)` across all active votes
   *  on this comment (including the author's seed upvote). Used to
   *  render "Support Level: ±X ADA." */
  supportLovelace?: string;
  upvoteCount?: number;
  downvoteCount?: number;
  /** Sprint 4 — community-flag counter. Distinct on-chain-verified
   *  flaggers tracked by `comment_flags`; the backend reaches the
   *  hide threshold at 3. Optional for back-compat with rows written
   *  before the field landed. */
  flagCount?: number;
  /** Sprint 4 — true when the row reached the hide threshold. Normal
   *  users never see hidden rows on the wire (the backend filters
   *  them); `platform_admin`s see them with this marker so the
   *  moderation UI can render a "FLAGGED — HIDDEN" treatment. */
  hidden?: boolean;
}

/** Map of `commentId → user's vote` returned by
 *  `GET /comments/{actionId}/my-votes`. */
export type MyCommentVotes = Record<string, 'up' | 'down'>;

export type ClubhousePostType = 'discussion' | 'question' | 'poll' | 'auto_ga';

export interface ClubhousePollOption {
  id: string;
  label: string;
  votes: number;
}

/** Provenance metadata for an `auto_ga` clubhouse post. Mirrors the
 *  backend's `AutoPostSource` shape. `abstractFrozenAt` is the moment
 *  this row's body was captured — the UI renders a small
 *  "frozen at sync time" annotation referencing this timestamp. */
export interface AutoPostSource {
  kind: 'governance_action';
  actionId: string;
  abstractFrozenAt: string;
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
  // ---- Batch B additions (2026-05-26): auto_ga rows. ----
  /** Pinned-at-top flag. Auto-posts default to `true` on creation
   *  and flip to `false` when the linked GA transitions to a
   *  completed state. Frontend bubbles pinned posts above chronological
   *  posts in the listing. Absent on non-auto rows. */
  pinned?: boolean;
  /** Present only when `type === 'auto_ga'`. Carries the linked
   *  governance action's id + the `abstractFrozenAt` timestamp the UI
   *  renders as "frozen at sync time." */
  autoSource?: AutoPostSource;
  /** Convenience denormalization of `autoSource.actionId` lifted to the
   *  top-level field name used by the GSI partition key on the backend.
   *  Frontend can use either field; both reference the same value. */
  linkedActionId?: string;
  // ---- P0-3 de-inline migration (2026-05-28) ----
  /** Denormalized counter on the post row — number of comments in the
   *  `clubhouse_comments` table for this post. Present on all new
   *  writes; absent only on rows synced before the migration's backfill
   *  ran. The frontend renders the badge as
   *  `commentCount ?? comments?.length ?? 0`. */
  commentCount?: number;
  /** ISO-8601 timestamp of the most recent comment on this post. Used
   *  by the right-rail's "active in last 24h" filter. Absent on posts
   *  with zero comments. */
  lastReplyAt?: string;
  /** Sprint 4 — community-flag counter on the post row. See the
   *  `Comment.flagCount` doc for the threshold semantic. */
  flagCount?: number;
  /** Sprint 4 — true when the post reached the hide threshold. Filtered
   *  out by the backend for normal users; surfaced to `platform_admin`
   *  for moderation. */
  hidden?: boolean;
}

export interface ClubhouseComment {
  commentId: string;
  authorWallet: string;
  authorDisplayName?: string;
  body: string;
  createdAt: string;
  /** Optional — when present, this comment is a reply to the named
   *  comment. The Clubhouse surface allows 2 levels of nesting
   *  (top-level → reply → sub-reply), one deeper than the Public
   *  Comments surface. */
  parentCommentId?: string;
  /** Batch CLUBHOUSE-DELEGATION-GATE (2026-05-30).
   *
   *  False when the 3-hour clubhouse-delegation revalidation sweep
   *  confirmed (via Koios `account_info_cached.delegated_drep`) that
   *  the author's wallet is no longer delegated to THIS clubhouse's
   *  DRep AND the author is not a committee role-holder. Renders a
   *  subtle "no longer delegated to this DRep" badge next to the
   *  author header; the comment body stays fully visible (flag, not
   *  hide — per owner decision).
   *
   *  Absent / undefined / `true` means "active" — the comment renders
   *  with no badge. The sweep is self-healing: a previously-badged
   *  author who re-delegates to this DRep has the flag cleared back
   *  to `true` on the next pass. */
  authorDelegationActive?: boolean;
}

/**
 * One entry returned by `GET /clubhouse/{drepId}/rail/active-threads`.
 * Powers the "Active threads" card on `ClubhouseRail.tsx`. Ranked
 * server-side by reply count in the last 24 hours; we render at most
 * `limit` (default 5) entries.
 */
export interface ClubhouseActiveThread {
  postId: string;
  /** Short title for the rail. Server-side ranker prefers `post.title`
   *  then falls back to a truncation of `post.body`. Capped at 80 chars
   *  for fit. */
  title: string;
  /** Reply count over the last 24 hours. The primary ranking metric. */
  replyCount24h: number;
  /** ISO-8601 timestamp of the most recent reply on this post. Powers
   *  the relative-time hint in the rail. Undefined when the post has
   *  no replies at all (shouldn't normally happen — entries with zero
   *  recent replies are excluded server-side). */
  lastReplyAt?: string;
}

/**
 * One entry returned by `GET /clubhouse/{drepId}/rail/top-contributors`.
 * Powers the "Top contributors" card on `ClubhouseRail.tsx`. Ranked
 * by clubhouse-internal participation (posts + replies authored).
 * See the handler's `_rail.ts` module header for the metric-choice
 * rationale.
 */
export interface ClubhouseTopContributor {
  walletAddress: string;
  /** Server-resolved from the `users` table; undefined when the wallet
   *  has no profile (the rail formats a truncated bech32 in that case). */
  displayName?: string;
  /** Number of posts AND replies by this wallet in this clubhouse. */
  contributionCount: number;
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
