import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import { isPersistent } from './stage';

export interface DatabaseStackProps extends cdk.StackProps {
  stage: string;
}

export class DatabaseStack extends cdk.Stack {
  public readonly usersTable: dynamodb.Table;
  public readonly drepCommitteesTable: dynamodb.Table;
  public readonly drepDirectoryTable: dynamodb.Table;
  public readonly governanceActionsTable: dynamodb.Table;
  public readonly governanceVotesTable: dynamodb.Table;
  public readonly commentsTable: dynamodb.Table;
  public readonly commentVotesTable: dynamodb.Table;
  public readonly commentVotersTable: dynamodb.Table;
  public readonly clubhousePostsTable: dynamodb.Table;
  public readonly clubhouseCommentsTable: dynamodb.Table;
  public readonly poolMetadataTable: dynamodb.Table;
  public readonly ccMembersTable: dynamodb.Table;
  public readonly auditLogTable: dynamodb.Table;
  public readonly authNoncesTable: dynamodb.Table;
  // ---- Decision #1 (2026-06-10): dedicated per-session revocation store ----
  public readonly identitySessionsTable: dynamodb.Table;
  // ---- Decision #3 (2026-06-10): canonical person + identity-link model ----
  public readonly onchainUsersTable: dynamodb.Table;
  public readonly identityLinksTable: dynamodb.Table;
  // ---- Phase 2: committee voting ----
  public readonly committeeVotesTable: dynamodb.Table;
  public readonly committeeMembershipTable: dynamodb.Table;
  public readonly platformStateTable: dynamodb.Table;
  // ---- Sprint 4: community flagging primitive ----
  public readonly commentFlagsTable: dynamodb.Table;
  public readonly clubhousePostFlagsTable: dynamodb.Table;
  // ---- Sprint 4 follow-up: clubhouse-comment flagging (closes Sprint 4 gap) ----
  public readonly clubhouseCommentFlagsTable: dynamodb.Table;

  private readonly tablePrefix: string;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);

    this.tablePrefix = `drep-platform-${props.stage}-`;

    // ---- users ----
    this.usersTable = new dynamodb.Table(this, 'UsersTable', {
      tableName: `${this.tablePrefix}users`,
      partitionKey: { name: 'walletAddress', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: isPersistent(props.stage) ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    this.usersTable.addGlobalSecondaryIndex({
      indexName: 'displayName-index',
      partitionKey: { name: 'displayName', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ['walletAddress', 'bio', 'roles', 'createdAt'],
    });

    // ---- drep_committees ----
    this.drepCommitteesTable = new dynamodb.Table(this, 'DRepCommitteesTable', {
      tableName: `${this.tablePrefix}drep_committees`,
      partitionKey: { name: 'drepId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: isPersistent(props.stage) ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    this.drepCommitteesTable.addGlobalSecondaryIndex({
      indexName: 'leadWallet-index',
      partitionKey: { name: 'leadWallet', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Browse-all index: every committee item has SK='COMMITTEE', so this GSI
    // partitions all committees onto a single hash and sorts by createdAt for
    // chronological browsing. With PAY_PER_REQUEST + adaptive capacity this is
    // acceptable at this scale; revisit if committee count exceeds ~1000.
    this.drepCommitteesTable.addGlobalSecondaryIndex({
      indexName: 'SK-createdAt-index',
      partitionKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Sparse index of committee invitations keyed on the invitee.
    //
    // **Why this exists (Feature 1 — committee invitations):** the new
    // invitation rows live under `drep_committees` with
    // `SK='INVITE#<inviteeStakeAddress>'` (see backend `CommitteeInviteItem`).
    // The `/auth/me` and the in-app bell badge surface "every pending
    // invitation for THIS wallet" — without a wallet-keyed index that would
    // be a table-wide Scan with a FilterExpression on inviteeStake, paying
    // for reading every COMMITTEE row + every other committee's INVITEs.
    //
    // **Shape:** PK = `inviteeStake` (the canonical stake address of the
    // invitee, written only on INVITE rows — sparse). SK = `status`
    // (`'pending' | 'accepted' | 'rejected' | 'revoked'`) so a Query
    // narrowed by `status='pending'` returns exactly the actionable rows
    // for one wallet in a single partition Query. COMMITTEE rows have no
    // `inviteeStake` attribute and are excluded from the index automatically.
    //
    // **Heads-up for the deploy:** adding a GSI to a live table is an
    // async CFN update. The CloudFormation stack will sit on `IN_PROGRESS`
    // for several minutes while DynamoDB backfills the index across the
    // existing committee rows (which today have NO invitee-stake attribute,
    // so the backfill is trivial — but the wait is unavoidable). New write
    // paths (`/drep` formation, `addMember` invite, `respondInvitation`,
    // `revokeInvitation`) must be deployed AFTER the GSI reports `ACTIVE`.
    this.drepCommitteesTable.addGlobalSecondaryIndex({
      indexName: 'inviteeStake-status-index',
      partitionKey: { name: 'inviteeStake', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ---- drep_directory ----
    // Mainnet DRep registry — chain-state directory of every registered
    // DRep, populated by the `drep-directory` sync (every 5 min) from
    // Koios. Distinct from `drep_committees` (the platform's own
    // coordination committees, which are user-created records).
    //
    // PK=`drepId`, SK=`'PROFILE'` (room for future per-DRep sub-records
    // — vote-history snapshots, delegator caches — under different SKs
    // without colliding on the partition).
    // SPARSE TTL on the `ttl` attribute — only rows that carry the
    // attribute auto-expire. As of 2026-05-27 only POWER#NNNNNN rows
    // (written by `drep-voting-power-history` sync) set `ttl` (365 days
    // future). PROFILE rows MUST NOT carry `ttl` — they're the
    // canonical DRep directory entries; expiring them would silently
    // delete DReps from the listing. See
    // `backend/src/sync/drep-voting-power-history.ts` for the contract
    // and the "Sparse TTL" comment in its header.
    this.drepDirectoryTable = new dynamodb.Table(this, 'DRepDirectoryTable', {
      tableName: `${this.tablePrefix}drep_directory`,
      partitionKey: { name: 'drepId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'ttl',
      removalPolicy: isPersistent(props.stage) ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // GSI: list every DRep profile in one Query, pre-sorted by voting power.
    //
    // **Why this exists (2026-05-26):** the table is shared with the daily
    // `drep-voting-power-history` sync, which writes `SK='POWER#NNNNNN'`
    // rows under the same `drepId` partition. As those POWER rows
    // accumulate (~1623/day on mainnet) the directory list handler's
    // Scan-with-FilterExpression became O(table-size) — it pays for
    // reading every POWER row off disk just to FilterExpression them away.
    // Today the table is ~101k items (1623 PROFILE + ~100k POWER); the
    // Scan was hitting its 50k raw-item ceiling and returning only ~800
    // PROFILE rows out of 1623, so DReps were going missing from the
    // directory listing.
    //
    // **The shape:** sparse GSI partitioned on a constant `entityType`
    // attribute that the sync writes ONLY on PROFILE rows. POWER rows
    // don't carry the attribute, so DynamoDB omits them from the index
    // automatically — no extra write amplification on the daily history
    // sync. Query against `entityType='DREP_PROFILE'` returns all 1623
    // PROFILE rows in 2-3 Query round-trips (1MB pages × full ALL
    // projection), independent of how many POWER rows exist.
    //
    // **Sort key:** `votingPowerSort` is a zero-padded numeric string set
    // on every PROFILE row by `drep-directory.ts`. With `ScanIndexForward:
    // false` the read path gets rows pre-sorted by voting power desc —
    // which is the default sort the UI shows. Other sorts (name, recent,
    // delegators) still do in-memory sort on the full PROFILE set, same
    // pattern as before.
    //
    // **History (2026-05-28):** a previous `votingPower-index` GSI
    // (PK=`votingPowerPartition='ALL'`, SK=`votingPowerSort`) was dropped
    // as part of the perf/cost batch — it was functionally equivalent to
    // this sparse one (same single-partition + same `votingPowerSort`
    // sort key) and had zero callers in any handler, sync, or script.
    // Removing it eliminates ~half of the GSI write amplification on the
    // `drep-directory` sync (was 5 GSIs, now 4). The `votingPowerPartition`
    // attribute is still WRITTEN by the sync on PROFILE rows — left in
    // place for the moment as harmless orphan data; cleanup is out-of-
    // scope for the perf PR (it touches sync code reserved to a parallel
    // PR). When that PR ships, the attribute can be removed from
    // `buildPowerRow` / `buildDirectoryRow` and a one-shot REMOVE pass
    // can prune the historical values.
    //
    // **Backfill required (historical, 2026-05-26):** existing 1623
    // PROFILE rows must have `entityType: 'DREP_PROFILE'` set on them
    // before this index becomes usable. The backfill script is
    // `backend/scripts/backfill-entity-type.ts` — run it AFTER
    // `cdk deploy DatabaseStack` (GSI is built) but BEFORE deploying the
    // new API code that reads from this GSI.
    this.drepDirectoryTable.addGlobalSecondaryIndex({
      indexName: 'entityType-votingPower-index',
      partitionKey: { name: 'entityType', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'votingPowerSort', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI: globally sort by delegator count. Same single-partition
    // pattern as the historical `votingPower-index` (now removed —
    // see the surviving `entityType-votingPower-index` above). The
    // detail handler updates this sort key on-demand when it computes
    // the live delegator count.
    this.drepDirectoryTable.addGlobalSecondaryIndex({
      indexName: 'delegatorCount-index',
      partitionKey: { name: 'delegatorCountPartition', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'delegatorCountSort', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI: globally sort by most-recent vote. Single-partition pattern
    // again. ISO-8601 sorts lexicographically as chronological order
    // (UTC `Z` suffix is uniform), so the `lastVotedAt` value is the
    // sort key directly — no padding required. Never-voted DReps are
    // absent from this index (their `lastVotedSort` is unset, which
    // DynamoDB skips), placing them naturally at the bottom of any
    // recent-activity listing. The list handler queries this for
    // `?sort=recent`.
    this.drepDirectoryTable.addGlobalSecondaryIndex({
      indexName: 'lastVoted-index',
      partitionKey: { name: 'lastVotedPartition', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'lastVotedSort', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ---- governance_actions ----
    this.governanceActionsTable = new dynamodb.Table(this, 'GovernanceActionsTable', {
      tableName: `${this.tablePrefix}governance_actions`,
      partitionKey: { name: 'actionId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: isPersistent(props.stage) ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    this.governanceActionsTable.addGlobalSecondaryIndex({
      indexName: 'status-submittedAt-index',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'submittedAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.governanceActionsTable.addGlobalSecondaryIndex({
      indexName: 'epochDeadline-index',
      partitionKey: { name: 'epochDeadline', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ['actionId', 'title', 'status', 'actionType'],
    });

    // ---- governance_votes ----
    // Per-vote event log — one row per individual on-chain governance vote.
    // Populated by the `governance-intake` sync from Koios's `/vote_list`
    // (~24k rows on mainnet today, grows by ~50/day). Append-only:
    // conditional Put on `attribute_not_exists` prevents double-writes when
    // the sync re-runs.
    //
    // PK=`actionId` (`tx_hash#cert_index` — matches `governance_actions.actionId`).
    // SK=`voteKey` (`${voterRole}#${voterId}#${voteTxHash}` — unique per
    // individual vote certificate). The SK shape lets a single voter
    // recorded twice on the same action (vote-change scenarios) keep both
    // rows; the timeline preserves the full audit trail.
    //
    // Access patterns:
    //   - "Show me every vote on this action, oldest first" — `Query(actionId)`
    //   - "Show me every vote by this DRep, newest first" — `Query(voterId)`
    //     via the `voter-blockTime-index` GSI
    //
    // Expected size: ~24k rows × ~250B/row = ~6MB today. Growth: 50/day.
    // Cost: negligible (PAY_PER_REQUEST + ~50 WCU/day steady-state +
    //       one 24k-WCU backfill = pennies/month).
    this.governanceVotesTable = new dynamodb.Table(this, 'GovernanceVotesTable', {
      tableName: `${this.tablePrefix}governance_votes`,
      partitionKey: { name: 'actionId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'voteKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: isPersistent(props.stage) ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // GSI: query every vote by a single voter, sorted newest-first.
    // Used by future "DRep voting timeline" UX without needing a Koios
    // round-trip. `blockTime` (Unix seconds, NUMBER) sorts naturally as
    // chronological; `ScanIndexForward: false` gives newest-first.
    this.governanceVotesTable.addGlobalSecondaryIndex({
      indexName: 'voter-blockTime-index',
      partitionKey: { name: 'voterId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'blockTime', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ---- comments ----
    this.commentsTable = new dynamodb.Table(this, 'CommentsTable', {
      tableName: `${this.tablePrefix}comments`,
      partitionKey: { name: 'actionId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'commentId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: isPersistent(props.stage) ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    this.commentsTable.addGlobalSecondaryIndex({
      indexName: 'walletAddress-index',
      partitionKey: { name: 'walletAddress', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ---- comment_votes ----
    // Per-vote rows for the comment up/downvote feature. One row per
    // (commentId, stakeAddress) tuple — recasting overwrites the row.
    //
    // PK=`commentId` (ULID, globally unique across all actions).
    // SK=`stakeAddress`.
    //
    // Schema rationale: a denormalized `supportLovelace` counter on the
    // parent `comments` row is the canonical source for the displayed
    // support level — list reads do NOT fan out into per-comment queries
    // against this table. The vote handler writes both rows atomically via
    // `transactWrite` (Put vote row + Update comments counter), so the two
    // can never drift more than one in-flight transaction's worth.
    //
    // This table exists for: (a) reading the caller's prior vote in the
    // vote handler (single GetItem before the transact), (b) audit and
    // future moderation paths ("who upvoted X"), (c) future reconciliation
    // sweep that recomputes the counter from these rows if it ever drifts.
    //
    // No GSI — every access path is `GetItem(commentId, stakeAddress)` or
    // `Query(commentId)` for audit.
    this.commentVotesTable = new dynamodb.Table(this, 'CommentVotesTable', {
      tableName: `${this.tablePrefix}comment_votes`,
      partitionKey: { name: 'commentId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'stakeAddress', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: isPersistent(props.stage) ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // GSI: enumerate every vote belonging to one wallet across all comments.
    //
    // **Why this exists (2026-05-29, Batch REVAL):** the comment-vote stake
    // re-validation pass needs to read every active vote for one wallet
    // (so it can re-weight them when the wallet's current stake has
    // moved). The primary key is (commentId, stakeAddress) — Query on
    // commentId returns all voters for one comment, NOT all comments for
    // one voter. A Scan-with-FilterExpression would pay for reading
    // every vote row on the table to filter; a GSI partitioned on
    // stakeAddress turns it into a single-partition Query per wallet.
    //
    // **Sort key:** `commentId` lets the sweep iterate one wallet's
    // votes in any order — there's no time-ordering requirement for
    // re-weighting, but having `commentId` as the SK lets the GSI
    // double as a unique-key index (a wallet votes at most once per
    // comment, and the GSI key tuple matches the primary table's
    // (commentId, stakeAddress) reversed).
    //
    // **Projection:** only `vote` (up/down) and `lovelace` (the
    // snapshotted weight). The re-weight math needs both — `vote`
    // signs the delta, `lovelace` provides the old snapshot to
    // subtract from. We also project `actionId` because the re-weight
    // counter update keys the comment row on (actionId, commentId).
    // Everything else (`votedAt`, `voterDisplayName`) is omitted to
    // keep the index storage small (~50B/row × ~few thousand votes =
    // pennies/month).
    this.commentVotesTable.addGlobalSecondaryIndex({
      indexName: 'stakeAddress-commentId-index',
      partitionKey: { name: 'stakeAddress', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'commentId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ['vote', 'lovelace', 'actionId'],
    });

    // ---- comment_voters ----
    // Registry of every stake address that has ever voted on a comment,
    // with their last-known stake snapshot. Populated upsert-on-vote
    // from the create + vote handlers, and read by the 3-hourly
    // `revalidate-comment-stake` Lambda to enumerate every voter for a
    // cheap "did this wallet's stake change?" sweep.
    //
    // **Why this exists (2026-05-29, Batch REVAL):** the re-validation
    // pass needs to know "every wallet that has ever voted" so it can
    // re-check their current stake on Koios. Walking `comment_votes`
    // for this is wasteful — the table grows linearly in (comments ×
    // voters) but the distinct-voter set is much smaller. Materializing
    // the distinct set into a per-voter registry makes the sweep
    // O(voters) instead of O(votes). The `lastKnownStake` snapshot
    // lets the sweep cheap-skip wallets whose Koios `total_balance`
    // exactly matches the previous reading — only the changed wallets
    // pay for the per-vote re-weight transaction.
    //
    // **PK:** `stakeAddress` — the natural key for "one voter, all
    // their bookkeeping." No SK (one row per voter); the table is
    // effectively a key-value store.
    //
    // **Attributes:**
    //   - `lastKnownStake` (string, stringified BigInt lovelace) — the
    //     wallet's `total_balance` at the last sweep reading. Stored as
    //     string for back-compat with the existing vote-row snapshot
    //     shape (which is also a string); the sweep BigInt-compares it.
    //   - `lastCheckedAt` (ISO-8601) — when the sweep last reconciled
    //     this wallet. Informational; the sweep doesn't use it for
    //     ordering today but it surfaces for incident-debugging.
    //   - `voteCount` (number, monotonic) — atomically ADDed on every
    //     vote-write so the registry has a denormalized "this wallet
    //     has voted N times on the platform" count for future audit /
    //     leaderboard UI. Not used by the sweep math.
    //
    // **Capacity:** at mainnet steady-state we expect ~thousands of
    // distinct voters; the registry is one row per. ~100B/row × 10k =
    // 1MB. Sweep reads via paginated Scan (1MB pages, single-digit
    // pages typical). Cost is pennies/month.
    //
    // PITR on (consistent with every other DDB table). RETAIN on prod
    // — a registry-row loss would let a wallet's votes drift away from
    // their current stake until the next vote re-creates the registry
    // entry, which is a soft data-quality bug worth being recoverable
    // from PITR.
    this.commentVotersTable = new dynamodb.Table(this, 'CommentVotersTable', {
      tableName: `${this.tablePrefix}comment_voters`,
      partitionKey: { name: 'stakeAddress', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: isPersistent(props.stage) ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ---- clubhouse_posts ----
    this.clubhousePostsTable = new dynamodb.Table(this, 'ClubhousePostsTable', {
      tableName: `${this.tablePrefix}clubhouse_posts`,
      partitionKey: { name: 'drepId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'postId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: isPersistent(props.stage) ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    this.clubhousePostsTable.addGlobalSecondaryIndex({
      indexName: 'authorWallet-index',
      partitionKey: { name: 'authorWallet', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI: query every auto-generated `type='auto_ga'` post for a given
    // governance action. Used by the completion sweep in
    // `governance-intake.ts` — when a GA transitions to `executed` or
    // `expired`, the sweep needs to find every clubhouse's auto-post for
    // that action and flip `pinned=false` on it.
    //
    // **Why a GSI vs a Scan with FilterExpression:** the alternative is
    // a `Scan(clubhouse_posts, FilterExpression='linkedActionId=:x')`
    // that pays for reading every post in the table to filter out the
    // ones we want. At ~368 active DReps × ~50 active GAs = ~18k auto-
    // posts steady-state PLUS organic posts (discussion/question/poll),
    // every sweep would scan tens of thousands of rows just to find the
    // ~368 we care about. The sparse GSI is partitioned on
    // `linkedActionId` which is set ONLY on auto-posts (organic posts
    // omit the attribute), so DynamoDB excludes the ~10x organic
    // volume from the index automatically and the Query touches only
    // the ~368 rows we need to update. Cost: ~$0.25/GB-month × ~5MB
    // index storage = pennies.
    //
    // **Sort key:** `drepId` so the unpinning sweep can issue one
    // Update per row by (drepId, postId) without a follow-up read. The
    // GSI projection is ALL because the sweep also needs `postId` (the
    // primary table sort key) to construct the Update target.
    this.clubhousePostsTable.addGlobalSecondaryIndex({
      indexName: 'linkedActionId-index',
      partitionKey: { name: 'linkedActionId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'drepId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ---- clubhouse_comments ----
    // Per-comment rows for the Clubhouse threading surface — one row per
    // comment, replacing the inline `clubhouse_posts.comments[]` array.
    //
    // **Why this table exists (2026-05-28, P0-3 migration):** the legacy
    // shape stored every comment inline on the post row, then `createComment`
    // did a full read-modify-write of the post on each new comment. Two
    // failure modes:
    //   (1) Concurrent replies silently dropped comments — no version
    //       guard on the RMW, last writer wins.
    //   (2) DynamoDB's 400KB per-item cap was hit at ~80 × 5KB comments,
    //       at which point ALL further writes to the post (including
    //       pinning, edits, AND new comments) returned
    //       `ValidationException` and the post was effectively write-
    //       locked forever.
    //
    // **Shape:**
    //   PK=`postKey` (= `${drepId}#${postId}`) — co-locates every comment
    //     for one post in a single partition for a single `Query`.
    //   SK=`commentId` (ULID, monotonic on insertion ordering).
    // No GSIs at launch — the rail ranker reads via a per-post `Query`
    // (not a global "all recent comments" scan), and the listComments
    // handler is also a single-partition Query. Adding a GSI later is
    // additive and doesn't require any data migration.
    //
    // **Counters live on the post row, not here.** `commentCount` and
    // `lastReplyAt` are denormalized onto `clubhouse_posts` via atomic
    // `ADD` / `SET` from the `createComment` handler — no read-modify-
    // write of the comment set is ever required to render the badge or
    // rank the rail.
    //
    // **Capacity:** today's mainnet has ~5 active clubhouses × ~50 posts
    // × ~10 comments median = ~2500 rows steady-state. PAY_PER_REQUEST
    // is comfortable here; the per-`Query` cost when expanding a post
    // is ~1 RCU for a typical thread, ~50 RCU for a pathological 400-
    // comment legacy post — still pennies.
    //
    // PITR on (consistent with every other DDB table in this stack;
    // see PR #3 / Batch A). RETAIN on prod.
    this.clubhouseCommentsTable = new dynamodb.Table(this, 'ClubhouseCommentsTable', {
      tableName: `${this.tablePrefix}clubhouse_comments`,
      partitionKey: { name: 'postKey', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'commentId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: isPersistent(props.stage) ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ---- pool_metadata ----
    // SPO ticker / name / homepage cache populated daily by
    // `backend/src/sync/pool-metadata.ts` from Koios `/pool_list` +
    // `/pool_metadata`. Read on the per-action Votes tab to render
    // human-readable SPO voter identifiers instead of bech32 hashes.
    //
    // PK=`poolId` (bech32 `pool1...`). No SK (one row per pool).
    //
    // Expected size: ~6500 pools on mainnet today × ~250B/row =
    // ~1.6MB total. Steady-state growth tracks pool registration rate
    // (~dozens/day). Idempotent sync (compare-then-write) keeps
    // WCU near-zero on quiet cycles.
    this.poolMetadataTable = new dynamodb.Table(this, 'PoolMetadataTable', {
      tableName: `${this.tablePrefix}pool_metadata`,
      partitionKey: { name: 'poolId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: isPersistent(props.stage) ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ---- cc_members ----
    // Constitutional Committee member roster populated by
    // `backend/src/sync/cc-members.ts` from Koios `/committee_info`.
    // Refresh fires hourly but the sync skips the actual Koios call
    // when the current chain epoch matches the meta-row's
    // `lastSyncedEpoch` — membership only changes at epoch
    // boundaries (~5 days on mainnet).
    //
    // PK=`ccHotCred` (bech32 `cc_hot...`). No SK. A reserved row
    // `ccHotCred='META'` carries the `lastSyncedEpoch` cursor for
    // epoch-skip behavior; no collision with real bech32 IDs.
    //
    // Expected size: ~7 active members + 1 META row = 8 rows. Tiny.
    this.ccMembersTable = new dynamodb.Table(this, 'CCMembersTable', {
      tableName: `${this.tablePrefix}cc_members`,
      partitionKey: { name: 'ccHotCred', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: isPersistent(props.stage) ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ---- audit_log ----
    this.auditLogTable = new dynamodb.Table(this, 'AuditLogTable', {
      tableName: `${this.tablePrefix}audit_log`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING }, // entityType#entityId
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING }, // timestamp#eventType
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'ttl',
      removalPolicy: isPersistent(props.stage) ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ---- auth_nonces ----
    // Stores both auth challenge nonces and mutation nonces.
    // Item shape: { nonce, kind: 'challenge' | 'mutation', walletAddress, expiresAt (epoch seconds for TTL), message? }
    // DynamoDB TTL on expiresAt handles cleanup automatically.
    //
    // PITR enabled for uniformity even though the practical recovery
    // window here is small (rows live for minutes). The circuit-breaker
    // and Phase C vote-event high-water-mark markers also live in this
    // table — those rows have a 24-hour TTL and would be worth
    // recovering if an operator accidentally truncated the table.
    this.authNoncesTable = new dynamodb.Table(this, 'AuthNoncesTable', {
      tableName: `${this.tablePrefix}auth_nonces`,
      partitionKey: { name: 'nonce', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: isPersistent(props.stage) ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ---- identity_sessions (Decision #1, 2026-06-10) ----
    //
    // Per-session revocation store for the on-chain login JWTs (DRep /
    // SPO / CC / Proposer). Sprint 1 reused `authNonces` with a `kind`
    // discriminator to defer infra changes; Decision #1 splits sessions
    // off into a purpose-built table for two correctness wins and one
    // perf win.
    //
    // **Why a dedicated table:**
    //   1. A per-identity GSI makes `revokeAllSessionsForUser` and the
    //      daily role-revalidation cron's enumeration into single-
    //      partition Queries — no more filtered Scan of a shared
    //      multi-purpose table.
    //   2. One row per session (instead of separate tombstone +
    //      session-index rows kept in sync via best-effort writes)
    //      removes a race where a concurrent login could lose a hash
    //      and leave a session out of the revoke-all set.
    //   3. Decouples session-store cost from the high-churn
    //      auth-nonces traffic (challenges/mutations get burned within
    //      minutes) so a future migration of either subsystem moves
    //      independently.
    //
    // **Shape:** see `lib/sessionRevocation.ts` for the full row spec.
    //   PK = `sessionKey` (STRING) = SHA-256(jti) hex.
    //   Attributes: `identityId`, `onChainRoles[]`, `issuedAt`,
    //               `expiresAt`, `revoked?`.
    //   TTL: `expiresAt` (NUMBER, epoch seconds).
    //   GSI: `identityId-issuedAt-index`
    //        PK=`identityId`, SK=`issuedAt`, projection ALL so the cron
    //        + revoke-all path can read the full row in one Query
    //        without a second GetItem per session.
    //
    // **Capacity:** modest. At steady state, one row per active on-chain
    // session, expiring at the 30-day JWT max. Even a hypothetical
    // 10k-DAU surface stays under ~300k rows total. PAY_PER_REQUEST keeps
    // ops simple; the GSI is single-identity-partition so PPR's
    // adaptive-capacity behaviour is well-suited.
    //
    // **PITR ON / RETAIN on persistent stages** — session rows aren't
    // long-lived BUT a botched migration / accidental table truncation
    // would lock out every active on-chain session until a fresh login,
    // which we'd rather avoid. Consistent with the sibling auth tables.
    //
    // **Deploy order:** create the table FIRST (CDK DatabaseStack
    // deploy), THEN ship the backend code that reads from it. The
    // backend's `tableNames.identitySessions` is a string that resolves
    // at module-load — if the table doesn't yet exist, the first
    // authorizer / verify-handler invocation will get a
    // ResourceNotFoundException. The `isSessionRevoked` fail-OPEN
    // contract means the worst case during the brief deploy window is
    // "per-session revocation is a no-op" (legacy `tokenVersion` is
    // still authoritative); but the cleanest path is "database stack
    // ACTIVE → api/scheduler stacks deploy".
    this.identitySessionsTable = new dynamodb.Table(this, 'IdentitySessionsTable', {
      tableName: `${this.tablePrefix}identity_sessions`,
      partitionKey: { name: 'sessionKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: isPersistent(props.stage) ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // Per-identity GSI — single-partition Query target for
    // `revokeAllSessionsForUser` (logout `{"all":true}`) AND the daily
    // role-revalidation cron's identity enumeration. SK `issuedAt`
    // (epoch seconds) keeps the per-identity row set sortable so a
    // future "show me my recent sessions" surface gets it for free
    // without another GSI.
    this.identitySessionsTable.addGlobalSecondaryIndex({
      indexName: 'identityId-issuedAt-index',
      partitionKey: { name: 'identityId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'issuedAt', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ---- onchain_users (Decision #3, 2026-06-10) ----
    //
    // The canonical "person" table for the on-chain identity subsystem.
    // One row per recognised individual, keyed by an opaque `personId`
    // (ULID). Holds the editable profile (displayName, bio, links) plus
    // bookkeeping (createdAt / updatedAt). The on-chain credentials
    // (drep:<drepId>, pool:<poolId>, cc:<ccCred>, stake:<stakeAddr>)
    // that map to this person live in the sibling `identity_links`
    // table — Decision #3's "one individual is recognised whether they
    // log in via wallet (stake) or raw-key (SPO/CC) on-chain."
    //
    // **Why a separate table from the legacy `users` table:**
    //   - The legacy `users` table is keyed by `walletAddress` (stake
    //     address). On-chain-only identities (e.g. an SPO that signs
    //     with a raw Calidus key and has never connected a CIP-30
    //     wallet) have NO row there. The on-chain login flow today
    //     identifies a caller by the credential (drepId / poolId /
    //     ccCred / stake) without touching `users` at all — see the
    //     onchainVerify handler docblock and `lib/auth.ts`. To recognise
    //     "this is the same person across multiple on-chain credentials"
    //     we need a separate canonical-person layer.
    //   - The legacy `users` row carries platform-role bookkeeping
    //     (`tokenVersion`, legacy `roles[]`) that's bound to the CIP-30
    //     wallet session. Folding the on-chain person there would
    //     collide on the PK (stake address) for the wallet-stake case
    //     and break every existing read site. Decision #3 explicitly
    //     scopes the new model to a NEW table so the legacy CIP-30
    //     surface is unchanged.
    //
    // **Shape:**
    //   PK = `personId` (STRING) — ULID, opaque, never reused.
    //   Attributes:
    //     `displayName?`  — short string, optional.
    //     `bio?`          — longer string, optional.
    //     `socialLinks?`  — embedded {twitter?, github?, website?, discord?}.
    //     `createdAt`     — ISO-8601.
    //     `updatedAt`     — ISO-8601.
    //   No SK, no GSIs — every access pattern is `GetItem(personId)` or
    //   `PutItem(personId)`. Listing every recognised person would be a
    //   future Scan but isn't called for by Decision #3.
    //
    // **Capacity:** modest. One row per recognised individual; on-chain
    // login flow auto-provisions on first login for an unmapped
    // credential. Mainnet today: a few hundred to low-thousands of
    // unique on-chain identities.
    //
    // PITR ON + RETAIN on persistent stages — these rows are user-
    // editable profile content; an accidental table truncation should
    // be recoverable.
    //
    // **Deploy order:** create the table FIRST (CDK DatabaseStack
    // deploy), THEN ship the backend code that reads from it. The new
    // login reconciliation code in onchainVerify will not be deployed
    // until the API stack rolls — the same brief window as the
    // identity_sessions table.
    this.onchainUsersTable = new dynamodb.Table(this, 'OnchainUsersTable', {
      tableName: `${this.tablePrefix}onchain_users`,
      partitionKey: { name: 'personId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: isPersistent(props.stage) ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ---- identity_links (Decision #3, 2026-06-10) ----
    //
    // Maps each on-chain credential to a canonical `personId` in the
    // sibling `onchain_users` table. This is the "one person, many
    // credentials" join — the reconciliation layer Decision #3 exists
    // to build.
    //
    // **Shape:**
    //   PK = `identityKey` (STRING) — namespaced credential string:
    //     `drep:<drepId>` | `pool:<poolId>` | `cc:<ccCred>` |
    //     `stake:<stakeAddr>`. The namespace prefix is load-bearing —
    //     it prevents collision between a DRep id and a CC cold id that
    //     happen to share a bech32 prefix style, and makes the credential
    //     type self-describing on read.
    //   Attributes:
    //     `personId`         — ULID FK into `onchain_users`.
    //     `credentialType`   — 'drep' | 'pool' | 'cc' | 'stake'.
    //                          Denormalised from the PK prefix for cheap
    //                          read-side filtering.
    //     `verifiedAt`       — ISO-8601 timestamp the link was minted.
    //                          On a fresh login that auto-provisioned a
    //                          new person + link this is the login time;
    //                          on an explicit `link/verify` call it's
    //                          the moment the new credential signed the
    //                          stage-bound nonce.
    //     `verifiedVia`      — 'login' | 'link'. Audit breadcrumb: did
    //                          this link come from the login auto-
    //                          provision path, or from an explicit
    //                          `/auth/onchain/link/verify` call?
    //
    // **GSI `personId-verifiedAt-index`:**
    //   PK = `personId`, SK = `verifiedAt` (STRING — ISO-8601 sorts
    //   lexicographically as chronological). Projection ALL so the
    //   `/auth/onchain/me` aggregation handler can resolve the full
    //   credential set for a person in one Query without a follow-up
    //   batchGet. Sortable by `verifiedAt` so a UI can show "this
    //   credential was added on …".
    //
    // **Capacity:** ~1-5 credentials per person typical. Mainnet today
    // sits in the low-thousands of links total even with full adoption.
    // PAY_PER_REQUEST handles the burst on a busy login hour comfortably;
    // the GSI is single-personId-partition so PPR's adaptive-capacity
    // behaviour is well-suited.
    //
    // **Safety contract (critical, Decision #3):** the link/verify flow
    // does NOT silently merge two persons. If a credential is presented
    // for linking but is already mapped to a DIFFERENT personId than
    // the caller's session person, the link is REJECTED with a clear
    // "credential already linked to another account" error. Account-
    // merge is a future product decision; do not infer it from a
    // signature. See `handlers/auth/linkVerify.ts` for the gate.
    //
    // PITR ON + RETAIN on persistent stages — links are evidence of
    // verified cryptographic proofs and would be expensive to rebuild.
    this.identityLinksTable = new dynamodb.Table(this, 'IdentityLinksTable', {
      tableName: `${this.tablePrefix}identity_links`,
      partitionKey: { name: 'identityKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: isPersistent(props.stage) ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    this.identityLinksTable.addGlobalSecondaryIndex({
      indexName: 'personId-verifiedAt-index',
      partitionKey: { name: 'personId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'verifiedAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ---- committee_votes (Phase 2) ----
    // One partition per (committee, governance action): PK=`${drepId}#${actionId}`.
    // Co-locates the single proposal, every member's latest cast, the rationale
    // draft/lock/final, and the on-chain submission receipt under one voteScope,
    // so the vote-room read is a single Query. SK alphabet:
    //   'PROPOSAL'              — the one proposal (putItemIfAbsent → 409 = one-at-a-time)
    //   'CAST#<wallet>'         — latest cast per voter (carries the CIP-30 signature)
    //   'RATIONALE#DRAFT'       — collaborative draft
    //   'RATIONALE#LOCK'        — pessimistic edit lock {editorWallet, expiresAt}
    //   'RATIONALE#FINAL'       — locked rationale + canonical anchor hash + IPFS URI
    //   'SUBMISSION'            — on-chain receipt {txHash, broadcastStage}
    //   'COSIGN#<wallet>'       — reserved for future multisig (additive)
    this.committeeVotesTable = new dynamodb.Table(this, 'CommitteeVotesTable', {
      tableName: `${this.tablePrefix}committee_votes`,
      partitionKey: { name: 'voteScope', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'itemKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: isPersistent(props.stage) ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // Sparse index of OPEN proposals only. `statusPartition` ('OPEN') is set
    // exclusively on the PROPOSAL row while status==='open' and REMOVED on any
    // terminal transition, so the index naturally shrinks to live proposals.
    // Drives the "all open proposals" admin view and the hourly deadline sweep
    // (Query by statusPartition, range on epochDeadline). Mirrors the
    // lastVoted-index sparse pattern on drep_directory.
    this.committeeVotesTable.addGlobalSecondaryIndex({
      indexName: 'open-epochDeadline-index',
      partitionKey: { name: 'statusPartition', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'epochDeadline', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // List every proposal for one committee, newest-first. `openedAt` is set
    // ONLY on PROPOSAL rows, so this GSI is naturally sparse — CAST and
    // RATIONALE rows (which carry drepId but no openedAt) are not indexed.
    this.committeeVotesTable.addGlobalSecondaryIndex({
      indexName: 'drepId-openedAt-index',
      partitionKey: { name: 'drepId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'openedAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ---- committee_membership (Phase 2) ----
    // Enforces "one committee per wallet, total" (lead OR member). PK=walletAddress
    // with a conditional Put (attribute_not_exists) makes the uniqueness atomic
    // across register / add-member. drepId-index lists/cleans a committee's
    // membership rows on teardown.
    this.committeeMembershipTable = new dynamodb.Table(this, 'CommitteeMembershipTable', {
      tableName: `${this.tablePrefix}committee_membership`,
      partitionKey: { name: 'walletAddress', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: isPersistent(props.stage) ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    this.committeeMembershipTable.addGlobalSecondaryIndex({
      indexName: 'drepId-index',
      partitionKey: { name: 'drepId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ---- platform_state (Phase 2) ----
    // Tiny singleton-row table for platform-wide flags. Today: the Sybil
    // safety-mode latch (PK stateKey='SAFETY_MODE' → {active, triggeredAt,
    // expiresAt, clearedBy}). PITR on; no GSI.
    this.platformStateTable = new dynamodb.Table(this, 'PlatformStateTable', {
      tableName: `${this.tablePrefix}platform_state`,
      partitionKey: { name: 'stateKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: isPersistent(props.stage) ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ---- comment_flags (Sprint 4) ----
    // Community-flagging primitive for governance-action comments.
    //
    // **Threat model:** an on-chain-verified writer (a wallet that has
    // proven `drep` / `spo` / `cc` / `proposer` via the Sprint 1
    // `/auth/onchain/verify` flow) raises a flag against a comment.
    // Three DISTINCT such flags hide the comment from normal users.
    // `platform_admin`s still see the row (with a `hidden: true`
    // marker) so they can moderate. The per-flagger uniqueness
    // prevents one wallet from racking up the count alone.
    //
    // **Shape:**
    //   PK = `commentId`  — same ULID used as the SK on the comments
    //     table; co-locates every flag for one comment under one
    //     partition, so a future audit/moderation surface can
    //     `Query(commentId)` to enumerate the flaggers in one round-trip.
    //   SK = `flaggerId`  — the flagger's bech32 stake address.
    //
    // **Counter integrity:** the matching `flagCount` counter on the
    // parent `comments` row is mutated via a denormalised atomic ADD
    // gated by `putItemIfAbsent` on this table — see
    // `handlers/comments/flag.ts`. Only a FRESH insert (outcome
    // `'written'`) bumps the counter. A duplicate flag (outcome
    // `'skipped'`) leaves the counter alone, so the count tracks
    // distinct-flagger headcount even under retries.
    //
    // **Capacity:** modest. ~50 flags per high-traffic comment × small
    // number of high-traffic comments = pennies. PAY_PER_REQUEST. PITR
    // ON because flag rows are evidence — accidental table truncation
    // should be recoverable.
    //
    // No GSIs at launch — every access pattern is `GetItem(commentId,
    // flaggerId)` (idempotent insert) or `Query(commentId)` (audit).
    // A future "wallets that have flagged the most content" leaderboard
    // would need a GSI on `flaggerId`; that's out-of-scope for Sprint 4.
    this.commentFlagsTable = new dynamodb.Table(this, 'CommentFlagsTable', {
      tableName: `${this.tablePrefix}comment_flags`,
      partitionKey: { name: 'commentId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'flaggerId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: isPersistent(props.stage) ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ---- clubhouse_post_flags (Sprint 4) ----
    // Same primitive as `comment_flags`, but scoped to clubhouse posts.
    //
    // **PK shape (`postKey`):** intentionally MATCHES the partition-key
    // format already used by the `clubhouse_comments` table —
    // `${drepId}#${postId}`. The helper `clubhouseCommentPostKey` in
    // `lib/types.ts` is reused for compose; see `handlers/clubhouse/
    // flagPost.ts`. Reusing the format means a future moderation UI
    // can correlate flags on a post with flags on its threaded
    // comments without learning a second key shape.
    //
    // SK = `flaggerId` — bech32 stake address of the flagging wallet,
    // identical to the comment-flags semantics.
    //
    // **Counter integrity:** `clubhouse_posts.flagCount` atomic-ADDed
    // only when the per-flagger row is freshly inserted; conditional
    // `hidden` set when the count crosses the threshold. See
    // `handlers/clubhouse/flagPost.ts`.
    //
    // **Capacity / PITR:** same rationale as `comment_flags` above.
    this.clubhousePostFlagsTable = new dynamodb.Table(this, 'ClubhousePostFlagsTable', {
      tableName: `${this.tablePrefix}clubhouse_post_flags`,
      partitionKey: { name: 'postKey', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'flaggerId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: isPersistent(props.stage) ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ---- clubhouse_comment_flags (Sprint 4 follow-up) ----
    // Same primitive as `comment_flags` / `clubhouse_post_flags`, but
    // scoped to clubhouse COMMENTS. Sprint 4 added flagging for
    // governance-action comments + clubhouse posts; clubhouse-comments
    // were the missing leg of the trio. This table closes that gap.
    //
    // **PK shape (`postKey`):** intentionally MATCHES the partition-key
    // format already used by both the `clubhouse_comments` table AND
    // the `clubhouse_post_flags` table — `${drepId}#${postId}`. A
    // single comment is then keyed within that partition by `commentId`
    // composed into the SK. We reuse the helper
    // `clubhouseCommentPostKey(drepId, postId)` in `lib/types.ts`.
    //
    // **SK shape (`commentFlagKey`):** `${commentId}#${flaggerId}` —
    // the smallest tuple that keeps the (comment, flagger) tuple
    // unique while still letting a single `Query(postKey)` enumerate
    // every flag for every comment under one post (useful for a
    // future moderation surface). Doing PK=commentId would also be
    // valid but would scatter flags across as many partitions as the
    // post has flagged comments, fragmenting the access pattern
    // future moderation UIs are likely to want.
    //
    // **Counter integrity:** the matching `flagCount` counter on the
    // parent `clubhouse_comments` row is mutated via a denormalised
    // atomic ADD gated by `putItemIfAbsent` on this table — see
    // `handlers/clubhouse/flagComment.ts`. Only a FRESH insert
    // (outcome `'written'`) bumps the counter. A duplicate flag
    // (outcome `'skipped'`) leaves the counter alone, so the count
    // tracks distinct-flagger headcount even under retries.
    //
    // **Capacity / PITR:** same rationale as the two sibling flag
    // tables above. Modest volume; PITR ON because flag rows are
    // evidence — accidental table truncation should be recoverable.
    this.clubhouseCommentFlagsTable = new dynamodb.Table(this, 'ClubhouseCommentFlagsTable', {
      tableName: `${this.tablePrefix}clubhouse_comment_flags`,
      partitionKey: { name: 'postKey', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'commentFlagKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: isPersistent(props.stage) ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ---- Outputs ----
    new cdk.CfnOutput(this, 'UsersTableName', { value: this.usersTable.tableName, exportName: `${props.stage}-UsersTableName` });
    new cdk.CfnOutput(this, 'DRepCommitteesTableName', { value: this.drepCommitteesTable.tableName, exportName: `${props.stage}-DRepCommitteesTableName` });
    new cdk.CfnOutput(this, 'DRepDirectoryTableName', { value: this.drepDirectoryTable.tableName, exportName: `${props.stage}-DRepDirectoryTableName` });
    new cdk.CfnOutput(this, 'GovernanceActionsTableName', { value: this.governanceActionsTable.tableName, exportName: `${props.stage}-GovernanceActionsTableName` });
    new cdk.CfnOutput(this, 'GovernanceVotesTableName', { value: this.governanceVotesTable.tableName, exportName: `${props.stage}-GovernanceVotesTableName` });
    new cdk.CfnOutput(this, 'CommentsTableName', { value: this.commentsTable.tableName, exportName: `${props.stage}-CommentsTableName` });
    new cdk.CfnOutput(this, 'CommentVotesTableName', { value: this.commentVotesTable.tableName, exportName: `${props.stage}-CommentVotesTableName` });
    new cdk.CfnOutput(this, 'CommentVotersTableName', { value: this.commentVotersTable.tableName, exportName: `${props.stage}-CommentVotersTableName` });
    new cdk.CfnOutput(this, 'ClubhousePostsTableName', { value: this.clubhousePostsTable.tableName, exportName: `${props.stage}-ClubhousePostsTableName` });
    new cdk.CfnOutput(this, 'ClubhouseCommentsTableName', { value: this.clubhouseCommentsTable.tableName, exportName: `${props.stage}-ClubhouseCommentsTableName` });
    new cdk.CfnOutput(this, 'PoolMetadataTableName', { value: this.poolMetadataTable.tableName, exportName: `${props.stage}-PoolMetadataTableName` });
    new cdk.CfnOutput(this, 'CCMembersTableName', { value: this.ccMembersTable.tableName, exportName: `${props.stage}-CCMembersTableName` });
    new cdk.CfnOutput(this, 'AuditLogTableName', { value: this.auditLogTable.tableName, exportName: `${props.stage}-AuditLogTableName` });
    new cdk.CfnOutput(this, 'AuthNoncesTableName', { value: this.authNoncesTable.tableName, exportName: `${props.stage}-AuthNoncesTableName` });
    new cdk.CfnOutput(this, 'IdentitySessionsTableName', { value: this.identitySessionsTable.tableName, exportName: `${props.stage}-IdentitySessionsTableName` });
    new cdk.CfnOutput(this, 'OnchainUsersTableName', { value: this.onchainUsersTable.tableName, exportName: `${props.stage}-OnchainUsersTableName` });
    new cdk.CfnOutput(this, 'IdentityLinksTableName', { value: this.identityLinksTable.tableName, exportName: `${props.stage}-IdentityLinksTableName` });
    new cdk.CfnOutput(this, 'CommitteeVotesTableName', { value: this.committeeVotesTable.tableName, exportName: `${props.stage}-CommitteeVotesTableName` });
    new cdk.CfnOutput(this, 'CommitteeMembershipTableName', { value: this.committeeMembershipTable.tableName, exportName: `${props.stage}-CommitteeMembershipTableName` });
    new cdk.CfnOutput(this, 'PlatformStateTableName', { value: this.platformStateTable.tableName, exportName: `${props.stage}-PlatformStateTableName` });
    new cdk.CfnOutput(this, 'CommentFlagsTableName', { value: this.commentFlagsTable.tableName, exportName: `${props.stage}-CommentFlagsTableName` });
    new cdk.CfnOutput(this, 'ClubhousePostFlagsTableName', { value: this.clubhousePostFlagsTable.tableName, exportName: `${props.stage}-ClubhousePostFlagsTableName` });
    new cdk.CfnOutput(this, 'ClubhouseCommentFlagsTableName', { value: this.clubhouseCommentFlagsTable.tableName, exportName: `${props.stage}-ClubhouseCommentFlagsTableName` });
  }
}
