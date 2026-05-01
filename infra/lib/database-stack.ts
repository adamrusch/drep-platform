import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface DatabaseStackProps extends cdk.StackProps {
  stage: string;
}

export class DatabaseStack extends cdk.Stack {
  public readonly usersTable: dynamodb.Table;
  public readonly drepCommitteesTable: dynamodb.Table;
  public readonly governanceActionsTable: dynamodb.Table;
  public readonly commentsTable: dynamodb.Table;
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
    new cdk.CfnOutput(this, 'GovernanceActionsTableName', { value: this.governanceActionsTable.tableName, exportName: `${props.stage}-GovernanceActionsTableName` });
    new cdk.CfnOutput(this, 'CommentsTableName', { value: this.commentsTable.tableName, exportName: `${props.stage}-CommentsTableName` });
    new cdk.CfnOutput(this, 'ClubhousePostsTableName', { value: this.clubhousePostsTable.tableName, exportName: `${props.stage}-ClubhousePostsTableName` });
    new cdk.CfnOutput(this, 'AuditLogTableName', { value: this.auditLogTable.tableName, exportName: `${props.stage}-AuditLogTableName` });
    new cdk.CfnOutput(this, 'AuthNoncesTableName', { value: this.authNoncesTable.tableName, exportName: `${props.stage}-AuthNoncesTableName` });
  }
}
