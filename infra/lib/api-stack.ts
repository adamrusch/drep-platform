import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import * as path from 'path';
import type { DatabaseStack } from './database-stack';

export interface ApiStackProps extends cdk.StackProps {
  stage: string;
  databaseStack: DatabaseStack;
}

export class ApiStack extends cdk.Stack {
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { stage, databaseStack } = props;
    const backendDir = path.join(__dirname, '../../backend');

    // ---- Secrets ----
    const jwtSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'JwtSecret',
      `drep-platform/${stage}/jwt-secret`,
    );
    const blockfrostSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'BlockfrostSecret',
      `drep-platform/${stage}/blockfrost-api-key`,
    );

    // ---- Shared Lambda environment ----
    const sharedEnv: Record<string, string> = {
      DYNAMODB_TABLE_PREFIX: `drep-platform-${stage}-`,
      CARDANO_NETWORK: stage === 'staging' ? 'preprod' : 'mainnet',
      BLOCKFROST_BASE_URL:
        stage === 'staging'
          ? 'https://cardano-preprod.blockfrost.io/api/v0'
          : 'https://cardano-mainnet.blockfrost.io/api/v0',
      SES_FROM_ADDRESS: 'notifications@drep-platform.io',
      SES_REGION: 'us-east-1',
      JWT_SECRET_NAME: `drep-platform/${stage}/jwt-secret`,
      BLOCKFROST_SECRET_NAME: `drep-platform/${stage}/blockfrost-api-key`,
    };

    // ---- Shared Lambda execution role ----
    const lambdaRole = new iam.Role(this, 'LambdaExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Grant DynamoDB access
    for (const table of [
      databaseStack.usersTable,
      databaseStack.drepCommitteesTable,
      databaseStack.governanceActionsTable,
      databaseStack.commentsTable,
      databaseStack.clubhousePostsTable,
      databaseStack.auditLogTable,
    ]) {
      table.grantReadWriteData(lambdaRole);
    }

    // Grant Secrets Manager read
    jwtSecret.grantRead(lambdaRole);
    blockfrostSecret.grantRead(lambdaRole);

    // ---- Common Lambda props ----
    const commonLambdaProps: Omit<lambdaNodejs.NodejsFunctionProps, 'entry'> = {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      role: lambdaRole,
      environment: sharedEnv,
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'es2022',
        externalModules: ['@aws-sdk/*'],
        forceDockerBundling: false,
      },
      depsLockFilePath: path.join(backendDir, 'package-lock.json'),
    };

    // ---- Lambda helper ----
    const fn = (id: string, handlerPath: string): lambdaNodejs.NodejsFunction => {
      return new lambdaNodejs.NodejsFunction(this, id, {
        ...commonLambdaProps,
        entry: path.join(backendDir, 'src', handlerPath),
        handler: 'handler',
      });
    };

    // ---- Auth handlers ----
    const challengeFn = fn('AuthChallengeFn', 'handlers/auth/challenge.ts');
    const verifyFn = fn('AuthVerifyFn', 'handlers/auth/verify.ts');
    const refreshFn = fn('AuthRefreshFn', 'handlers/auth/refresh.ts');
    const logoutFn = fn('AuthLogoutFn', 'handlers/auth/logout.ts');
    const meFn = fn('AuthMeFn', 'handlers/auth/me.ts');

    // ---- Governance handlers ----
    const govListFn = fn('GovListFn', 'handlers/governance/list.ts');
    const govGetFn = fn('GovGetFn', 'handlers/governance/get.ts');
    const govSyncFn = fn('GovSyncFn', 'handlers/governance/sync.ts');

    // ---- DRep handlers ----
    const drepListFn = fn('DRepListFn', 'handlers/drep/list.ts');
    const drepGetFn = fn('DRepGetFn', 'handlers/drep/get.ts');
    const drepRegisterFn = fn('DRepRegisterFn', 'handlers/drep/register.ts');
    const drepUpdateFn = fn('DRepUpdateFn', 'handlers/drep/update.ts');

    // ---- Comments handlers ----
    const commentsListFn = fn('CommentsListFn', 'handlers/comments/list.ts');
    const commentsCreateFn = fn('CommentsCreateFn', 'handlers/comments/create.ts');
    const commentsDeleteFn = fn('CommentsDeleteFn', 'handlers/comments/delete.ts');

    // ---- Clubhouse handlers ----
    const clubhouseListFn = fn('ClubhouseListFn', 'handlers/clubhouse/list.ts');
    const clubhouseCreatePostFn = fn('ClubhouseCreatePostFn', 'handlers/clubhouse/createPost.ts');
    const clubhouseCreateCommentFn = fn('ClubhouseCreateCommentFn', 'handlers/clubhouse/createComment.ts');
    const clubhouseDeletePostFn = fn('ClubhouseDeletePostFn', 'handlers/clubhouse/deletePost.ts');

    // ---- Profile handlers ----
    const profileGetFn = fn('ProfileGetFn', 'handlers/profile/get.ts');
    const profileUpsertFn = fn('ProfileUpsertFn', 'handlers/profile/upsert.ts');
    const profileDelegationHistoryFn = fn('ProfileDelegationHistoryFn', 'handlers/profile/delegationHistory.ts');

    // ---- JWT Authorizer Lambda ----
    const jwtAuthorizerFn = fn('JwtAuthorizerFn', 'middleware/jwt-authorizer.ts');

    // ---- API Gateway (REST) ----
    const api = new apigateway.RestApi(this, 'DRepPlatformApi', {
      restApiName: `drep-platform-${stage}`,
      description: 'DRep Coordination Platform API',
      deployOptions: {
        stageName: stage,
        throttlingRateLimit: 100,
        throttlingBurstLimit: 200,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization'],
        allowCredentials: true,
      },
    });

    // ---- Token authorizer ----
    const tokenAuthorizer = new apigateway.TokenAuthorizer(this, 'JwtTokenAuthorizer', {
      handler: jwtAuthorizerFn,
      identitySource: 'method.request.header.Authorization',
      resultsCacheTtl: cdk.Duration.minutes(5),
    });

    const authOptions: apigateway.MethodOptions = { authorizer: tokenAuthorizer };

    // ---- Route helpers ----
    const r = (path: string): apigateway.Resource => api.root.resourceForPath(path);
    const integ = (fn: lambda.IFunction): apigateway.LambdaIntegration =>
      new apigateway.LambdaIntegration(fn, { proxy: true });

    // ---- Auth routes ----
    r('/auth/challenge').addMethod('POST', integ(challengeFn));
    r('/auth/verify').addMethod('POST', integ(verifyFn));
    r('/auth/refresh').addMethod('POST', integ(refreshFn), authOptions);
    r('/auth/session').addMethod('DELETE', integ(logoutFn), authOptions);
    r('/auth/me').addMethod('GET', integ(meFn), authOptions);

    // ---- Governance routes ----
    r('/governance').addMethod('GET', integ(govListFn));
    r('/governance/{actionId}').addMethod('GET', integ(govGetFn));
    r('/governance/sync').addMethod('POST', integ(govSyncFn), authOptions);

    // ---- DRep routes ----
    r('/drep').addMethod('GET', integ(drepListFn));
    r('/drep').addMethod('POST', integ(drepRegisterFn), authOptions);
    r('/drep/{drepId}').addMethod('GET', integ(drepGetFn));
    r('/drep/{drepId}').addMethod('PUT', integ(drepUpdateFn), authOptions);

    // ---- Comments routes ----
    r('/comments/{actionId}').addMethod('GET', integ(commentsListFn));
    r('/comments/{actionId}').addMethod('POST', integ(commentsCreateFn), authOptions);
    r('/comments/{actionId}/{commentId}').addMethod('DELETE', integ(commentsDeleteFn), authOptions);

    // ---- Clubhouse routes ----
    r('/clubhouse/{drepId}').addMethod('GET', integ(clubhouseListFn));
    r('/clubhouse/{drepId}/post').addMethod('POST', integ(clubhouseCreatePostFn), authOptions);
    r('/clubhouse/{drepId}/post/{postId}/comment').addMethod('POST', integ(clubhouseCreateCommentFn), authOptions);
    r('/clubhouse/{drepId}/post/{postId}').addMethod('DELETE', integ(clubhouseDeletePostFn), authOptions);

    // ---- Profile routes ----
    r('/profile/{walletAddress}').addMethod('GET', integ(profileGetFn));
    r('/profile').addMethod('POST', integ(profileUpsertFn), authOptions);
    r('/profile/{walletAddress}/delegation-history').addMethod('GET', integ(profileDelegationHistoryFn));

    this.apiUrl = api.url;

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      exportName: `${stage}-ApiUrl`,
    });
  }
}
