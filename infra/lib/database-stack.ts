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
      pointInTimeRecovery: true,
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
      pointInTimeRecovery: true,
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
    this.drepDirectoryTable = new dynamodb.Table(this, 'DRepDirectoryTable', {
      tableName: `${this.tablePrefix}drep_directory`,
      partitionKey: { name: 'drepId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
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
      pointInTimeRecovery: true,
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
      pointInTimeRecovery: true,
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
      pointInTimeRecovery: true,
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
      pointInTimeRecovery: true,
      removalPolicy: props.stage === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ---- clubhouse_posts ----
    this.clubhousePostsTable = new dynamodb.Table(this, 'ClubhousePostsTable', {
      tableName: `${this.tablePrefix}clubhouse_posts`,
      partitionKey: { name: 'drepId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'postId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: props.stage === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    this.clubhousePostsTable.addGlobalSecondaryIndex({
      indexName: 'authorWallet-index',
      partitionKey: { name: 'authorWallet', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ---- audit_log ----
    this.auditLogTable = new dynamodb.Table(this, 'AuditLogTable', {
      tableName: `${this.tablePrefix}audit_log`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING }, // entityType#entityId
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING }, // timestamp#eventType
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: props.stage === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ---- auth_nonces ----
    // Stores both auth challenge nonces and mutation nonces.
    // Item shape: { nonce, kind: 'challenge' | 'mutation', walletAddress, expiresAt (epoch seconds for TTL), message? }
    // DynamoDB TTL on expiresAt handles cleanup automatically.
    this.authNoncesTable = new dynamodb.Table(this, 'AuthNoncesTable', {
      tableName: `${this.tablePrefix}auth_nonces`,
      partitionKey: { name: 'nonce', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
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
