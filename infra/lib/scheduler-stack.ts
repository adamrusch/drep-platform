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
    blockfrostSecret.grantRead(syncRole);

    // ---- Governance sync Lambda ----
    this.governanceSyncFn = new lambdaNodejs.NodejsFunction(this, 'GovernanceSyncFn', {
      functionName: `drep-platform-${stage}-governance-intake-sync`,
      entry: path.join(backendDir, 'src/sync/governance-intake.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024,
      // Cold first-time enrichment passes ~3 Blockfrost calls per action; a
      // mainnet sync of ~110 actions takes ~30s with concurrency, but we
      // keep generous headroom for retries / rate-limit backoff.
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

    // ---- EventBridge rule: every 2 minutes ----
    const syncRule = new events.Rule(this, 'GovernanceSyncRule', {
      ruleName: `drep-platform-${stage}-governance-sync`,
      description: 'Triggers governance intake sync from Blockfrost every 2 minutes',
      schedule: events.Schedule.rate(cdk.Duration.minutes(2)),
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
  }
}
