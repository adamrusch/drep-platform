import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

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
  public readonly clubhousePostsTable: dynamodb.Table;
  public readonly auditLogTable: dynamodb.Table;
  public readonly authNoncesTable: dynamodb.Table;

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
      removalPolicy: props.stage === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
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
      removalPolicy: props.stage === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
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
      removalPolicy: props.stage === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // GSI: globally sort all DReps by voting power. Every row carries
    // `votingPowerPartition: 'ALL'` so a Query against this index with
    // a fixed partition key returns every DRep, sorted by the lexico-
    // graphically-comparable zero-padded `votingPowerSort` field.
    // Hot-partition risk: at ~2000 rows on PAY_PER_REQUEST with adaptive
    // capacity this is fine; revisit if the directory grows past ~10k.
    this.drepDirectoryTable.addGlobalSecondaryIndex({
      indexName: 'votingPower-index',
      partitionKey: { name: 'votingPowerPartition', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'votingPowerSort', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI: list every DRep profile in one Query.
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
    // **Sort key:** `votingPowerSort` (already populated on PROFILE rows
    // for the `votingPower-index` GSI). With `ScanIndexForward: false`
    // the read path gets rows pre-sorted by voting power desc — which is
    // the default sort the UI shows. Other sorts (name, recent,
    // delegators) still do in-memory sort on the full PROFILE set, same
    // pattern as before.
    //
    // **Backfill required:** existing 1623 PROFILE rows must have
    // `entityType: 'DREP_PROFILE'` set on them before this index becomes
    // usable. The backfill script is `backend/scripts/backfill-entity-type.ts`
    // — run it AFTER `cdk deploy DatabaseStack` (GSI is built) but BEFORE
    // deploying the new API code that reads from this GSI.
    this.drepDirectoryTable.addGlobalSecondaryIndex({
      indexName: 'entityType-votingPower-index',
      partitionKey: { name: 'entityType', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'votingPowerSort', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI: globally sort by delegator count. Same single-partition
    // pattern as votingPower-index. The detail handler updates this
    // sort key on-demand when it computes the live delegator count.
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
      removalPolicy: props.stage === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
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
      removalPolicy: props.stage === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
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
      removalPolicy: props.stage === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
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
      removalPolicy: props.stage === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ---- clubhouse_posts ----
    this.clubhousePostsTable = new dynamodb.Table(this, 'ClubhousePostsTable', {
      tableName: `${this.tablePrefix}clubhouse_posts`,
      partitionKey: { name: 'drepId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'postId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: props.stage === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
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

    // ---- audit_log ----
    this.auditLogTable = new dynamodb.Table(this, 'AuditLogTable', {
      tableName: `${this.tablePrefix}audit_log`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING }, // entityType#entityId
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING }, // timestamp#eventType
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'ttl',
      removalPolicy: props.stage === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
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
      removalPolicy: props.stage === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ---- Outputs ----
    new cdk.CfnOutput(this, 'UsersTableName', { value: this.usersTable.tableName, exportName: `${props.stage}-UsersTableName` });
    new cdk.CfnOutput(this, 'DRepCommitteesTableName', { value: this.drepCommitteesTable.tableName, exportName: `${props.stage}-DRepCommitteesTableName` });
    new cdk.CfnOutput(this, 'DRepDirectoryTableName', { value: this.drepDirectoryTable.tableName, exportName: `${props.stage}-DRepDirectoryTableName` });
    new cdk.CfnOutput(this, 'GovernanceActionsTableName', { value: this.governanceActionsTable.tableName, exportName: `${props.stage}-GovernanceActionsTableName` });
    new cdk.CfnOutput(this, 'GovernanceVotesTableName', { value: this.governanceVotesTable.tableName, exportName: `${props.stage}-GovernanceVotesTableName` });
    new cdk.CfnOutput(this, 'CommentsTableName', { value: this.commentsTable.tableName, exportName: `${props.stage}-CommentsTableName` });
    new cdk.CfnOutput(this, 'CommentVotesTableName', { value: this.commentVotesTable.tableName, exportName: `${props.stage}-CommentVotesTableName` });
    new cdk.CfnOutput(this, 'ClubhousePostsTableName', { value: this.clubhousePostsTable.tableName, exportName: `${props.stage}-ClubhousePostsTableName` });
    new cdk.CfnOutput(this, 'AuditLogTableName', { value: this.auditLogTable.tableName, exportName: `${props.stage}-AuditLogTableName` });
    new cdk.CfnOutput(this, 'AuthNoncesTableName', { value: this.authNoncesTable.tableName, exportName: `${props.stage}-AuthNoncesTableName` });
  }
}
