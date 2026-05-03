import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
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
    // The sync writes a circuit-breaker marker to the auth_nonces table when
    // Blockfrost rate-limits us, so it can skip subsequent runs cleanly
    // (see backend/src/lib/circuitBreaker.ts).
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
  }
}
