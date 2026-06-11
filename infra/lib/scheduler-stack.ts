import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import * as path from 'path';
import type { DatabaseStack } from './database-stack';
import { type FreshnessSchedule, getFreshnessRow } from './freshness';

/**
 * Map a structured `FreshnessSchedule` (declared in `shared/freshness.ts`,
 * mirrored into `infra/lib/freshness.ts`) to the CDK `events.Schedule` the
 * EventBridge rule actually consumes. Single source of truth for cadences:
 * the help page and this stack both read from the same FRESHNESS table, so
 * a cadence change touches exactly one place and the documentation can
 * never drift from the schedule the stack synthesises.
 *
 * Exported so a future test (or another stack) can call it without
 * re-deriving the mapping by hand.
 */
export function scheduleFromFreshness(spec: FreshnessSchedule): events.Schedule {
  if (spec.kind === 'rate') {
    if ('minutes' in spec) return events.Schedule.rate(cdk.Duration.minutes(spec.minutes));
    return events.Schedule.rate(cdk.Duration.hours(spec.hours));
  }
  return events.Schedule.cron({ minute: spec.minute, hour: spec.hour });
}

export interface SchedulerStackProps extends cdk.StackProps {
  stage: string;
  databaseStack: DatabaseStack;
}

export class SchedulerStack extends cdk.Stack {
  public readonly governanceSyncFn: lambdaNodejs.NodejsFunction;
  public readonly directorySyncFn: lambdaNodejs.NodejsFunction;
  public readonly voteRationaleSyncFn: lambdaNodejs.NodejsFunction;
  public readonly powerHistorySyncFn: lambdaNodejs.NodejsFunction;
  public readonly poolMetadataSyncFn: lambdaNodejs.NodejsFunction;
  public readonly ccMembersSyncFn: lambdaNodejs.NodejsFunction;
  public readonly revalidateCommentStakeFn: lambdaNodejs.NodejsFunction;
  public readonly committeeEpochSweepFn: lambdaNodejs.NodejsFunction;
  public readonly revalidateOnChainRolesFn: lambdaNodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: SchedulerStackProps) {
    super(scope, id, props);

    const { stage, databaseStack } = props;
    const backendDir = path.join(__dirname, '../../backend');

    // ---- Secrets ----
    const blockfrostSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'BlockfrostSecret',
      `drep-platform/${stage}/blockfrost-api-key`,
    );

    // ---- Execution role ----
    const syncRole = new iam.Role(this, 'GovernanceSyncRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    databaseStack.governanceActionsTable.grantReadWriteData(syncRole);
    // Phase C: the sync also writes per-vote event rows to
    // `governance_votes`. Append-only via conditional Put; the actual
    // write volume is governed by a high-water-mark in `auth_nonces`
    // (see `persistVoteEvents` in `backend/src/sync/governance-intake.ts`).
    databaseStack.governanceVotesTable.grantReadWriteData(syncRole);
    // The sync writes a circuit-breaker marker to the auth_nonces table when
    // Blockfrost rate-limits us, so it can skip subsequent runs cleanly
    // (see backend/src/lib/circuitBreaker.ts). The Phase C vote-event
    // high-water-mark also lives here.
    databaseStack.authNoncesTable.grantReadWriteData(syncRole);
    blockfrostSecret.grantRead(syncRole);

    // ---- Directory sync role (separate, doesn't touch Blockfrost) ----
    // Koios is the only upstream for the DRep directory sync. Splitting
    // the role keeps the principle-of-least-privilege story clean — the
    // directory Lambda has no Secrets Manager grant at all.
    const directorySyncRole = new iam.Role(this, 'DirectorySyncRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    databaseStack.drepDirectoryTable.grantReadWriteData(directorySyncRole);
    // Auto-post backfill (clubhouseAutoPosts): the directory sync writes a
    // welcome post into each newly-active DRep's clubhouse. That path reads the
    // active governance actions (status-submittedAt-index) and writes
    // clubhouse_posts. Without these grants the backfill fails closed
    // (AccessDenied) — observed as postsErrored == newlyActiveDReps.
    databaseStack.governanceActionsTable.grantReadData(directorySyncRole);
    databaseStack.clubhousePostsTable.grantReadWriteData(directorySyncRole);

    // ---- Governance sync Lambda ----
    this.governanceSyncFn = new lambdaNodejs.NodejsFunction(this, 'GovernanceSyncFn', {
      functionName: `drep-platform-${stage}-governance-intake-sync`,
      entry: path.join(backendDir, 'src/sync/governance-intake.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024,
      // With Koios as primary metadata source the cold pass is one bulk
      // Koios call + ~110 Blockfrost vote calls; observed runtime is 5–10s.
      // Keep the timeout generous to absorb retries / rate-limit backoff
      // on either upstream.
      timeout: cdk.Duration.minutes(10),
      role: syncRole,
      environment: {
        DYNAMODB_TABLE_PREFIX: `drep-platform-${stage}-`,
        CARDANO_NETWORK: stage === 'staging' ? 'preprod' : 'mainnet',
        BLOCKFROST_BASE_URL:
          stage === 'staging'
            ? 'https://cardano-preprod.blockfrost.io/api/v0'
            : 'https://cardano-mainnet.blockfrost.io/api/v0',
        BLOCKFROST_SECRET_NAME: `drep-platform/${stage}/blockfrost-api-key`,
      },
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'es2022',
        externalModules: ['@aws-sdk/*'],
        // Keep cardano-serialization-lib-nodejs out of the esbuild bundle —
        // it ships a .wasm file that esbuild cannot inline. Listing it under
        // nodeModules causes CDK to npm-install it into the Lambda zip with
        // its WASM intact.
        // blake2b uses dynamic require() of blake2b-wasm at runtime which
        // also confuses esbuild — install it the same way.
        nodeModules: ['@emurgo/cardano-serialization-lib-nodejs', 'blake2b'],
        forceDockerBundling: false,
      },
      depsLockFilePath: path.join(backendDir, 'package-lock.json'),
    });

    // ---- EventBridge rule: every 1 minute (Phase A) ----
    // Phase A migrates the metadata-source primary to Koios `/proposal_list`
    // — one bulk call per cycle replaces 4 Blockfrost calls per action.
    // Per-cycle Blockfrost volume drops to ~110 vote-tally calls + 1
    // epochs-latest = ~111 requests, plus 1 Koios call.
    // At every-1-min that's ~160k Blockfrost calls/day on the sync path,
    // sharing budget with /epoch and /profile/*/delegation-history. The
    // Discovery tier (1M req/day) accommodates an expected ~316k/day total
    // with comfortable headroom. Sync cycle observed at 5-10s, so the
    // 1-min cadence has plenty of room for retries and rate-limit backoff.
    // The persistent circuit breaker (backend/src/lib/circuitBreaker.ts)
    // still guards against quota cascades — leave it in place.
    const syncRule = new events.Rule(this, 'GovernanceSyncRule', {
      ruleName: `drep-platform-${stage}-governance-sync`,
      description: 'Triggers governance intake sync (Koios primary, Blockfrost votes) every 1 minute',
      // Cadence comes from `shared/freshness.ts` via the infra mirror so the
      // help page and the scheduler can never disagree on how fresh a value is.
      schedule: scheduleFromFreshness(getFreshnessRow('governance-intake').schedule),
      enabled: true,
    });

    syncRule.addTarget(
      new eventsTargets.LambdaFunction(this.governanceSyncFn, {
        retryAttempts: 2,
        maxEventAge: cdk.Duration.minutes(10),
      }),
    );

    new cdk.CfnOutput(this, 'GovernanceSyncFnArn', {
      value: this.governanceSyncFn.functionArn,
      exportName: `${stage}-GovernanceSyncFnArn`,
    });

    // ---- DRep directory sync Lambda ----
    // Cadence: every 30 minutes. DRep registrations / retirements / vote
    // activity move slowly, so the lower frequency is fine — the
    // user-visible "Last Voted" timestamps come from the governance sync
    // (1 min cadence) anyway. Bumped from 5 min as part of an emergency
    // cost fix: at 5 min the Put-every-row hot path was burning ~38k
    // WCU/hour on `drep_directory` for ~zero changes per cycle. The hot
    // path now Batch-Gets and compares before writing, so quiet cycles
    // are near-free; combined with the 6× cadence drop the table's
    // steady-state WCU should fall by >95%.
    this.directorySyncFn = new lambdaNodejs.NodejsFunction(this, 'DirectorySyncFn', {
      functionName: `drep-platform-${stage}-drep-directory-sync`,
      entry: path.join(backendDir, 'src/sync/drep-directory.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024,
      // ~2000 DReps × ~40 batched Koios calls; observed run is well
      // under 60s but leave headroom for upstream rate-limit backoff
      // and pagination growth.
      timeout: cdk.Duration.minutes(5),
      role: directorySyncRole,
      environment: {
        DYNAMODB_TABLE_PREFIX: `drep-platform-${stage}-`,
        CARDANO_NETWORK: stage === 'staging' ? 'preprod' : 'mainnet',
      },
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'es2022',
        externalModules: ['@aws-sdk/*'],
        forceDockerBundling: false,
      },
      depsLockFilePath: path.join(backendDir, 'package-lock.json'),
    });

    const directorySyncRule = new events.Rule(this, 'DirectorySyncRule', {
      ruleName: `drep-platform-${stage}-drep-directory-sync`,
      description: 'Triggers DRep directory sync (Koios drep_list/info/metadata) every 30 minutes',
      schedule: scheduleFromFreshness(getFreshnessRow('drep-directory').schedule),
      enabled: true,
    });

    directorySyncRule.addTarget(
      new eventsTargets.LambdaFunction(this.directorySyncFn, {
        retryAttempts: 1,
        maxEventAge: cdk.Duration.minutes(10),
      }),
    );

    new cdk.CfnOutput(this, 'DirectorySyncFnArn', {
      value: this.directorySyncFn.functionArn,
      exportName: `${stage}-DirectorySyncFnArn`,
    });

    // ---- Vote-rationale sync Lambda ----
    // Downloads + caches each voter's CIP-100 rationale (the off-chain JSON
    // body referenced by a vote's anchor URL) for the currently ACTIVE
    // governance actions, so the platform can render rationales inline
    // instead of linking out to an IPFS gateway. Reads action ids from the
    // status GSI, reads/writes the `governance_votes` rows. Public IPFS
    // gateways + https anchors only — no Blockfrost/secret needed. Bounded
    // to ~200 fetches/run (see backend/src/sync/vote-rationale-sync.ts); a
    // backlog catches up over consecutive 30-min cycles.
    const voteRationaleRole = new iam.Role(this, 'VoteRationaleSyncRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    databaseStack.governanceActionsTable.grantReadData(voteRationaleRole);
    databaseStack.governanceVotesTable.grantReadWriteData(voteRationaleRole);

    this.voteRationaleSyncFn = new lambdaNodejs.NodejsFunction(this, 'VoteRationaleSyncFn', {
      functionName: `drep-platform-${stage}-vote-rationale-sync`,
      entry: path.join(backendDir, 'src/sync/vote-rationale-sync.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      // Bounded fetch count, but unreachable anchors walk several gateways —
      // give the run generous headroom; the per-run cap keeps it well under.
      timeout: cdk.Duration.minutes(10),
      role: voteRationaleRole,
      environment: {
        DYNAMODB_TABLE_PREFIX: `drep-platform-${stage}-`,
        CARDANO_NETWORK: stage === 'staging' ? 'preprod' : 'mainnet',
      },
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'es2022',
        externalModules: ['@aws-sdk/*'],
        // blake2b dynamically require()s blake2b-wasm at runtime — esbuild
        // can't inline it, so install it into the zip (same as the
        // governance-intake function).
        nodeModules: ['blake2b'],
        forceDockerBundling: false,
      },
      depsLockFilePath: path.join(backendDir, 'package-lock.json'),
    });

    const voteRationaleRule = new events.Rule(this, 'VoteRationaleSyncRule', {
      ruleName: `drep-platform-${stage}-vote-rationale-sync`,
      description: 'Caches voter rationale bodies for active governance actions every 30 minutes',
      schedule: scheduleFromFreshness(getFreshnessRow('vote-rationale').schedule),
      enabled: true,
    });

    voteRationaleRule.addTarget(
      new eventsTargets.LambdaFunction(this.voteRationaleSyncFn, {
        retryAttempts: 1,
        maxEventAge: cdk.Duration.minutes(15),
      }),
    );

    new cdk.CfnOutput(this, 'VoteRationaleSyncFnArn', {
      value: this.voteRationaleSyncFn.functionArn,
      exportName: `${stage}-VoteRationaleSyncFnArn`,
    });

    // ---- DRep voting-power history sync Lambda (Phase C) ----
    // Daily cadence — voting power only changes at epoch boundaries
    // (~every 5 days), so 24-hour granularity is plenty. Populates the
    // `POWER#${epoch_no}` rows on the `drep_directory` table; the
    // detail handler will surface them as `votingPowerHistory` on the
    // response so the frontend Sparkline can render real data.
    //
    // Per-DRep Koios call, paced at ~5 RPS to stay under the public-tier
    // 10 RPS ceiling. ~1500 active DReps → ~5 min wall-clock, well within
    // the 10-min Lambda timeout.
    const powerHistorySyncRole = new iam.Role(this, 'PowerHistorySyncRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    databaseStack.drepDirectoryTable.grantReadWriteData(powerHistorySyncRole);

    this.powerHistorySyncFn = new lambdaNodejs.NodejsFunction(this, 'PowerHistorySyncFn', {
      functionName: `drep-platform-${stage}-drep-power-history-sync`,
      entry: path.join(backendDir, 'src/sync/drep-voting-power-history.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      // Daily cadence; 5 min Koios call pacing → 10 min timeout buffers
      // for any slow-call retries without ever hitting the wall.
      timeout: cdk.Duration.minutes(10),
      role: powerHistorySyncRole,
      environment: {
        DYNAMODB_TABLE_PREFIX: `drep-platform-${stage}-`,
        CARDANO_NETWORK: stage === 'staging' ? 'preprod' : 'mainnet',
      },
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'es2022',
        externalModules: ['@aws-sdk/*'],
        forceDockerBundling: false,
      },
      depsLockFilePath: path.join(backendDir, 'package-lock.json'),
    });

    const powerHistorySyncRule = new events.Rule(this, 'PowerHistorySyncRule', {
      ruleName: `drep-platform-${stage}-drep-power-history-sync`,
      description: 'Triggers DRep voting-power history sync (Koios drep_voting_power_history) daily',
      // 02:00 UTC daily — outside US/EU prime-time so we don't compete
      // with the Koios anonymous-tier rate budget when users are active.
      schedule: scheduleFromFreshness(getFreshnessRow('drep-power-history').schedule),
      enabled: true,
    });

    powerHistorySyncRule.addTarget(
      new eventsTargets.LambdaFunction(this.powerHistorySyncFn, {
        retryAttempts: 1,
        maxEventAge: cdk.Duration.hours(2),
      }),
    );

    new cdk.CfnOutput(this, 'PowerHistorySyncFnArn', {
      value: this.powerHistorySyncFn.functionArn,
      exportName: `${stage}-PowerHistorySyncFnArn`,
    });

    // ---- Pool metadata sync Lambda (Batch D) ----
    // Populates `pool_metadata` from Koios `/pool_list` + `/pool_metadata`.
    // Daily cadence — pool ticker / name changes move very slowly. The
    // compare-then-write idempotency path keeps quiet-day WCU near zero.
    // ~6500 pools × ~140 batched calls ≈ 30s wall-clock; the 5-min
    // timeout is comfortable headroom for slow upstreams.
    const poolMetadataSyncRole = new iam.Role(this, 'PoolMetadataSyncRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    databaseStack.poolMetadataTable.grantReadWriteData(poolMetadataSyncRole);

    this.poolMetadataSyncFn = new lambdaNodejs.NodejsFunction(this, 'PoolMetadataSyncFn', {
      functionName: `drep-platform-${stage}-pool-metadata-sync`,
      entry: path.join(backendDir, 'src/sync/pool-metadata.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.minutes(5),
      role: poolMetadataSyncRole,
      environment: {
        DYNAMODB_TABLE_PREFIX: `drep-platform-${stage}-`,
        CARDANO_NETWORK: stage === 'staging' ? 'preprod' : 'mainnet',
      },
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'es2022',
        externalModules: ['@aws-sdk/*'],
        forceDockerBundling: false,
      },
      depsLockFilePath: path.join(backendDir, 'package-lock.json'),
    });

    const poolMetadataSyncRule = new events.Rule(this, 'PoolMetadataSyncRule', {
      ruleName: `drep-platform-${stage}-pool-metadata-sync`,
      description: 'Triggers pool metadata sync (Koios pool_list + pool_metadata) daily',
      // 03:00 UTC — offset from the power-history sync (02:00) so two
      // anonymous-tier Koios sync passes don't share their RPS budget
      // with each other.
      schedule: scheduleFromFreshness(getFreshnessRow('pool-metadata').schedule),
      enabled: true,
    });

    poolMetadataSyncRule.addTarget(
      new eventsTargets.LambdaFunction(this.poolMetadataSyncFn, {
        retryAttempts: 1,
        maxEventAge: cdk.Duration.hours(2),
      }),
    );

    new cdk.CfnOutput(this, 'PoolMetadataSyncFnArn', {
      value: this.poolMetadataSyncFn.functionArn,
      exportName: `${stage}-PoolMetadataSyncFnArn`,
    });

    // ---- CC members sync Lambda (Batch D) ----
    // Populates `cc_members` from Koios `/committee_info`. Hourly
    // cadence, but the Lambda's internal epoch-skip check means the
    // Koios call only fires on actual epoch transitions (~5 calls/epoch
    // ≈ 365 calls/year on mainnet). The hourly EventBridge schedule is
    // there so a "missed epoch transition" lag never exceeds one hour.
    const ccMembersSyncRole = new iam.Role(this, 'CCMembersSyncRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    databaseStack.ccMembersTable.grantReadWriteData(ccMembersSyncRole);

    this.ccMembersSyncFn = new lambdaNodejs.NodejsFunction(this, 'CCMembersSyncFn', {
      functionName: `drep-platform-${stage}-cc-members-sync`,
      entry: path.join(backendDir, 'src/sync/cc-members.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      // The Koios calls return in <1s typically. Tiny budget keeps cold-
      // start contention down on the ARM Lambda fleet.
      timeout: cdk.Duration.minutes(1),
      role: ccMembersSyncRole,
      environment: {
        DYNAMODB_TABLE_PREFIX: `drep-platform-${stage}-`,
        CARDANO_NETWORK: stage === 'staging' ? 'preprod' : 'mainnet',
      },
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'es2022',
        externalModules: ['@aws-sdk/*'],
        forceDockerBundling: false,
      },
      depsLockFilePath: path.join(backendDir, 'package-lock.json'),
    });

    const ccMembersSyncRule = new events.Rule(this, 'CCMembersSyncRule', {
      ruleName: `drep-platform-${stage}-cc-members-sync`,
      description: 'Triggers CC members sync (Koios committee_info) hourly with epoch-skip',
      schedule: scheduleFromFreshness(getFreshnessRow('cc-members').schedule),
      enabled: true,
    });

    ccMembersSyncRule.addTarget(
      new eventsTargets.LambdaFunction(this.ccMembersSyncFn, {
        retryAttempts: 1,
        maxEventAge: cdk.Duration.hours(2),
      }),
    );

    new cdk.CfnOutput(this, 'CCMembersSyncFnArn', {
      value: this.ccMembersSyncFn.functionArn,
      exportName: `${stage}-CCMembersSyncFnArn`,
    });

    // ---- Comment-vote stake re-validation Lambda (Batch REVAL, 2026-05-29) ----
    //
    // Sybil defense: every 3 hours, re-check each voting wallet's current
    // stake via Koios `/account_info_cached.total_balance` and re-weight
    // any votes whose snapshot no longer matches. Collapses the
    // "move-and-revote" inflation vector — see
    // `backend/src/sync/revalidate-comment-stake.ts` module header for
    // the full design + the critical "never zero on lookup failure"
    // correctness invariant.
    //
    // # Role
    //
    // Reads + writes both `comment_voters` (the registry that lets the
    // sweep enumerate distinct voters) and `comment_votes` (per-vote
    // snapshots that the sweep overwrites with the fresh stake reading)
    // and `comments` (the parent comment row whose `supportLovelace`
    // counter is atomically ADDed by the signed re-weight delta).
    // Also writes the `audit_log` table (best-effort per-pass + per-
    // wallet events).
    //
    // # Memory + timeout
    //
    // 1024MB / 5 min mirrors the directory sync's budget — the sweep is
    // O(voters) Koios calls × O(votes_per_voter) DDB transactWrites.
    // At today's scale (zero voters) the runtime is sub-second; at
    // steady state (~10k voters) it's ~30s wall-clock dominated by
    // Koios batch calls. 5 min absorbs Koios rate-limit backoff.
    const revalidateCommentStakeRole = new iam.Role(
      this,
      'RevalidateCommentStakeRole',
      {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName(
            'service-role/AWSLambdaBasicExecutionRole',
          ),
        ],
      },
    );
    databaseStack.commentVotersTable.grantReadWriteData(revalidateCommentStakeRole);
    databaseStack.commentVotesTable.grantReadWriteData(revalidateCommentStakeRole);
    databaseStack.commentsTable.grantReadWriteData(revalidateCommentStakeRole);
    databaseStack.auditLogTable.grantReadWriteData(revalidateCommentStakeRole);
    // ---- Batch CLUBHOUSE-DELEGATION-GATE (2026-05-30) ----
    // The same Lambda now also runs the clubhouse-delegation revoke+
    // badge phase on the same 3-hour cadence (see
    // `backend/src/sync/revalidate-comment-stake.ts` —
    // `runRevalidateClubhouseDelegations`). That phase:
    //   - Scans `clubhouse_posts` to harvest poll-voter participation,
    //     then UpdateItems each post to REMOVE the un-delegated wallet's
    //     pollVotes entry + ADD -1 to the affected pollOptions counter.
    //   - Scans `clubhouse_comments` to harvest comment authors, then
    //     UpdateItems each comment row to set
    //     `authorDelegationActive` (false → badge, true → unbadge).
    //   - Gets `drep_committees` rows (PK=drepId, SK='COMMITTEE') to
    //     check the role-holder bypass.
    // RW on clubhouse_posts + clubhouse_comments; read-only on
    // drep_committees (the role-holder check is a single GetItem; we
    // never write the committee row from this Lambda).
    databaseStack.clubhousePostsTable.grantReadWriteData(revalidateCommentStakeRole);
    databaseStack.clubhouseCommentsTable.grantReadWriteData(revalidateCommentStakeRole);
    databaseStack.drepCommitteesTable.grantReadData(revalidateCommentStakeRole);

    this.revalidateCommentStakeFn = new lambdaNodejs.NodejsFunction(
      this,
      'RevalidateCommentStakeFn',
      {
        functionName: `drep-platform-${stage}-revalidate-comment-stake-sync`,
        entry: path.join(backendDir, 'src/sync/revalidate-comment-stake.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 1024,
        timeout: cdk.Duration.minutes(5),
        role: revalidateCommentStakeRole,
        environment: {
          DYNAMODB_TABLE_PREFIX: `drep-platform-${stage}-`,
          CARDANO_NETWORK: stage === 'staging' ? 'preprod' : 'mainnet',
        },
        bundling: {
          minify: true,
          sourceMap: false,
          target: 'es2022',
          externalModules: ['@aws-sdk/*'],
          forceDockerBundling: false,
        },
        depsLockFilePath: path.join(backendDir, 'package-lock.json'),
      },
    );

    const revalidateCommentStakeRule = new events.Rule(
      this,
      'RevalidateCommentStakeRule',
      {
        ruleName: `drep-platform-${stage}-revalidate-comment-stake-sync`,
        description:
          'Triggers comment-vote stake re-validation sweep every 3 hours (Sybil defense)',
        schedule: scheduleFromFreshness(
          getFreshnessRow('revalidate-comment-stake').schedule,
        ),
        enabled: true,
      },
    );

    revalidateCommentStakeRule.addTarget(
      new eventsTargets.LambdaFunction(this.revalidateCommentStakeFn, {
        retryAttempts: 1,
        maxEventAge: cdk.Duration.hours(2),
      }),
    );

    new cdk.CfnOutput(this, 'RevalidateCommentStakeFnArn', {
      value: this.revalidateCommentStakeFn.functionArn,
      exportName: `${stage}-RevalidateCommentStakeFnArn`,
    });

    // ---- Committee epoch-deadline sweep (Phase 2) ----
    // Hourly finalize of open committee proposals whose action's voting window
    // has closed (epoch deadline passed or GA terminal). Koios `/tip` only —
    // no Blockfrost secret needed, but we grant it for the fallback path.
    const committeeEpochSweepRole = new iam.Role(this, 'CommitteeEpochSweepRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    databaseStack.committeeVotesTable.grantReadWriteData(committeeEpochSweepRole);
    databaseStack.governanceActionsTable.grantReadData(committeeEpochSweepRole);
    databaseStack.auditLogTable.grantReadWriteData(committeeEpochSweepRole);
    blockfrostSecret.grantRead(committeeEpochSweepRole);

    this.committeeEpochSweepFn = new lambdaNodejs.NodejsFunction(this, 'CommitteeEpochSweepFn', {
      functionName: `drep-platform-${stage}-committee-epoch-sweep`,
      entry: path.join(backendDir, 'src/sync/committee-epoch-sweep.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.minutes(2),
      role: committeeEpochSweepRole,
      environment: {
        DYNAMODB_TABLE_PREFIX: `drep-platform-${stage}-`,
        CARDANO_NETWORK: stage === 'staging' ? 'preprod' : 'mainnet',
        BLOCKFROST_BASE_URL:
          stage === 'staging'
            ? 'https://cardano-preprod.blockfrost.io/api/v0'
            : 'https://cardano-mainnet.blockfrost.io/api/v0',
        BLOCKFROST_SECRET_NAME: `drep-platform/${stage}/blockfrost-api-key`,
      },
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'es2022',
        externalModules: ['@aws-sdk/*'],
        nodeModules: ['@emurgo/cardano-serialization-lib-nodejs', 'blake2b'],
        forceDockerBundling: false,
      },
      depsLockFilePath: path.join(backendDir, 'package-lock.json'),
    });

    const committeeEpochSweepRule = new events.Rule(this, 'CommitteeEpochSweepRule', {
      ruleName: `drep-platform-${stage}-committee-epoch-sweep`,
      description: 'Finalizes open committee proposals past their voting deadline (hourly)',
      schedule: scheduleFromFreshness(getFreshnessRow('committee-epoch-sweep').schedule),
      enabled: true,
    });
    committeeEpochSweepRule.addTarget(
      new eventsTargets.LambdaFunction(this.committeeEpochSweepFn, {
        retryAttempts: 1,
        maxEventAge: cdk.Duration.hours(2),
      }),
    );

    new cdk.CfnOutput(this, 'CommitteeEpochSweepFnArn', {
      value: this.committeeEpochSweepFn.functionArn,
      exportName: `${stage}-CommitteeEpochSweepFnArn`,
    });

    // ---- On-chain role revalidation Lambda (Sprint 3, 2026-06-10) ----
    //
    // Daily, re-resolve each active on-chain identity's role via Koios
    // and revoke any whose role no longer holds. Closes the gap where
    // a deregistered DRep / retired SPO / revoked CC keeps an unexpired
    // JWT for up to 30 days post-event. See the long header in
    // `backend/src/sync/revalidate-onchain-roles.ts` for the full design
    // + the critical "fail-safe on Koios error" correctness invariant.
    //
    // # Role + grants
    //
    // The Lambda only needs the `authNonces` table (for enumerating
    // `kind='session_index'` rows + writing `kind='session'` tombstones).
    // No Koios secret needed — the adapter uses the public anonymous
    // tier. Mirrors the IAM posture of the on-chain verify Lambda for
    // consistency (which the API stack already grants for handler-side
    // calls into `recordSessionForUser`).
    //
    // # Memory + timeout
    //
    // 512MB / 5 min. At today's scale (handful of on-chain identities)
    // the run is sub-second. At steady state — assume the platform
    // attracts thousands of role-holders — the wall clock is dominated
    // by per-identity Koios calls. Each `resolveDRep` is one Koios
    // `/drep_info` call (~50ms); the CC role check uses a single
    // adapter-cached `/committee_info` for the whole pass. 5 minutes
    // absorbs ample retry headroom; the cron's correctness does not
    // depend on completing the pass in one Lambda invocation (an
    // unfinished pass simply picks up next day).
    const revalidateOnChainRolesRole = new iam.Role(
      this,
      'RevalidateOnChainRolesRole',
      {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName(
            'service-role/AWSLambdaBasicExecutionRole',
          ),
        ],
      },
    );
    // The Lambda reads `kind='session_index'` rows + writes
    // `kind='session'` tombstones + deletes per-user index rows after
    // a revoke-all. All three operations target the existing
    // `authNonces` table.
    databaseStack.authNoncesTable.grantReadWriteData(revalidateOnChainRolesRole);

    this.revalidateOnChainRolesFn = new lambdaNodejs.NodejsFunction(
      this,
      'RevalidateOnChainRolesFn',
      {
        functionName: `drep-platform-${stage}-revalidate-onchain-roles-sync`,
        entry: path.join(backendDir, 'src/sync/revalidate-onchain-roles.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        timeout: cdk.Duration.minutes(5),
        role: revalidateOnChainRolesRole,
        environment: {
          DYNAMODB_TABLE_PREFIX: `drep-platform-${stage}-`,
          CARDANO_NETWORK: stage === 'staging' ? 'preprod' : 'mainnet',
        },
        bundling: {
          minify: true,
          sourceMap: false,
          target: 'es2022',
          externalModules: ['@aws-sdk/*'],
          // The role re-validation uses `blake2b` indirectly via the
          // ported identity module's `crypto/blake.ts` (the resolvers
          // themselves don't hash, but the imported helpers do — keep
          // the install consistent with the other identity-consuming
          // Lambdas so the cold-start hot path doesn't surprise an
          // operator).
          nodeModules: ['blake2b'],
          forceDockerBundling: false,
        },
        depsLockFilePath: path.join(backendDir, 'package-lock.json'),
      },
    );

    const revalidateOnChainRolesRule = new events.Rule(
      this,
      'RevalidateOnChainRolesRule',
      {
        ruleName: `drep-platform-${stage}-revalidate-onchain-roles-sync`,
        description:
          'Triggers daily on-chain role re-validation (DRep / SPO / CC / proposer deregistration sweep)',
        // 02:30 UTC daily — slotted between the existing power-history
        // sync (02:00) and pool-metadata sync (03:00) so the three
        // anonymous-tier Koios consumers don't share an RPS budget.
        schedule: scheduleFromFreshness(
          getFreshnessRow('revalidate-onchain-roles').schedule,
        ),
        enabled: true,
      },
    );

    revalidateOnChainRolesRule.addTarget(
      new eventsTargets.LambdaFunction(this.revalidateOnChainRolesFn, {
        retryAttempts: 1,
        maxEventAge: cdk.Duration.hours(2),
      }),
    );

    new cdk.CfnOutput(this, 'RevalidateOnChainRolesFnArn', {
      value: this.revalidateOnChainRolesFn.functionArn,
      exportName: `${stage}-RevalidateOnChainRolesFnArn`,
    });

    // ---- CloudWatch alarms on sync Lambda errors (Batch F #20, 2026-05-27) ----
    //
    // One alarm per sync Lambda. Today if `governance-intake` or
    // `drep-directory` fails for 24 hours, the only signal is a user
    // reporting it — by which point the directory is hours stale or
    // votes are missing from the per-action page. The alarm fires when
    // the Lambda's auto-emitted `Errors` metric exceeds 0 for 5
    // consecutive 1-minute periods, which is tight enough to catch a
    // stuck failure mode but loose enough that a single 500 doesn't
    // page (governance-intake runs every 1 min on mainnet; one
    // transient Koios 5xx is normal noise).
    //
    // # Why on the SchedulerStack and not a new alarms-stack
    //
    // The alarms reference the Lambda functions defined in this stack.
    // Putting them here keeps the related infra colocated and avoids a
    // cross-stack dependency on the function ARN exports. A future
    // "platform observability" stack could absorb them if/when the
    // alarm count grows past ~20.
    //
    // # First deploy
    //
    // The SNS subscription requires email confirmation. After the
    // first deploy, AWS sends a "Confirm subscription" email to the
    // target address; the operator must click the link before any
    // alarm notifications will actually reach them. This is a one-time
    // step per subscriber address.

    const alarmTopic = new sns.Topic(this, 'SyncFailureAlarmTopic', {
      topicName: `drep-platform-${stage}-sync-failures`,
      displayName: `drep.tools ${stage} sync failures`,
    });

    // Subscribe the operator's email. The first deploy will send a
    // confirmation email that must be clicked through; subsequent
    // deploys reuse the confirmed subscription.
    alarmTopic.addSubscription(
      new snsSubscriptions.EmailSubscription('claude@rusch.me'),
    );

    new cdk.CfnOutput(this, 'SyncFailureAlarmTopicArn', {
      value: alarmTopic.topicArn,
      exportName: `${stage}-SyncFailureAlarmTopicArn`,
    });

    /**
     * Build one alarm against the given Lambda's `Errors` metric.
     * Threshold > 0 means "any error count above zero." Evaluation
     * over 5 consecutive 1-minute periods means a single failure
     * within a 5-min window does not page, but a sustained error
     * (e.g. broken sync code, upstream outage, IAM denial) does.
     *
     * `treatMissingData: NOT_BREACHING` is critical for the daily
     * Lambdas (`pool-metadata-sync`, `drep-power-history-sync`) which
     * don't emit any metric outside their once-per-day window —
     * without this flag, the alarm would page every 5 minutes for the
     * other 23h59m of the day. NOT_BREACHING explicitly says "no data
     * is OK, only emit when there's a real positive `Errors` count."
     */
    const buildErrorsAlarm = (
      id: string,
      fn: lambdaNodejs.NodejsFunction,
      friendlyName: string,
    ): cloudwatch.Alarm => {
      const alarm = new cloudwatch.Alarm(this, id, {
        alarmName: `drep-platform-${stage}-${friendlyName}-errors`,
        alarmDescription: `${friendlyName} Lambda emitted >0 errors for 5 consecutive minutes`,
        metric: fn.metricErrors({
          period: cdk.Duration.minutes(1),
          statistic: cloudwatch.Stats.SUM,
        }),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 5,
        datapointsToAlarm: 5,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));
      return alarm;
    };

    buildErrorsAlarm('GovernanceSyncErrorsAlarm', this.governanceSyncFn, 'governance-intake');
    buildErrorsAlarm('DirectorySyncErrorsAlarm', this.directorySyncFn, 'drep-directory');
    buildErrorsAlarm('PowerHistorySyncErrorsAlarm', this.powerHistorySyncFn, 'drep-power-history');
    buildErrorsAlarm('PoolMetadataSyncErrorsAlarm', this.poolMetadataSyncFn, 'pool-metadata');
    buildErrorsAlarm('CCMembersSyncErrorsAlarm', this.ccMembersSyncFn, 'cc-members');
    buildErrorsAlarm(
      'RevalidateCommentStakeErrorsAlarm',
      this.revalidateCommentStakeFn,
      'revalidate-comment-stake',
    );
    buildErrorsAlarm('CommitteeEpochSweepErrorsAlarm', this.committeeEpochSweepFn, 'committee-epoch-sweep');
    buildErrorsAlarm(
      'RevalidateOnChainRolesErrorsAlarm',
      this.revalidateOnChainRolesFn,
      'revalidate-onchain-roles',
    );
  }
}
