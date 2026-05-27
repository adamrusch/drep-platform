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

export interface SchedulerStackProps extends cdk.StackProps {
  stage: string;
  databaseStack: DatabaseStack;
}

export class SchedulerStack extends cdk.Stack {
  public readonly governanceSyncFn: lambdaNodejs.NodejsFunction;
  public readonly directorySyncFn: lambdaNodejs.NodejsFunction;
  public readonly powerHistorySyncFn: lambdaNodejs.NodejsFunction;
  public readonly poolMetadataSyncFn: lambdaNodejs.NodejsFunction;
  public readonly ccMembersSyncFn: lambdaNodejs.NodejsFunction;

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
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
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
      schedule: events.Schedule.rate(cdk.Duration.minutes(30)),
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
      schedule: events.Schedule.cron({ minute: '0', hour: '2' }),
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
      schedule: events.Schedule.cron({ minute: '0', hour: '3' }),
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
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
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
  }
}
