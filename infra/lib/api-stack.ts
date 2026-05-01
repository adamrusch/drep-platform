import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as apigwv2Authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
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

const ALLOWED_ORIGINS = [
  'https://d31k3mmkrkmdvl.cloudfront.net',
  'http://localhost:5173',
];

const PRIMARY_CORS_ORIGIN = 'https://d31k3mmkrkmdvl.cloudfront.net';

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
      CORS_ORIGIN: PRIMARY_CORS_ORIGIN,
    };

    // ---- Shared Lambda execution role ----
    const lambdaRole = new iam.Role(this, 'LambdaExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Grant DynamoDB access (including the new auth_nonces table)
    for (const table of [
      databaseStack.usersTable,
      databaseStack.drepCommitteesTable,
      databaseStack.governanceActionsTable,
      databaseStack.commentsTable,
      databaseStack.clubhousePostsTable,
      databaseStack.auditLogTable,
      databaseStack.authNoncesTable,
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
    const mutationNonceFn = fn('AuthMutationNonceFn', 'handlers/auth/mutationNonce.ts');

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
    const clubhouseCreateCommentFn = fn(
      'ClubhouseCreateCommentFn',
      'handlers/clubhouse/createComment.ts',
    );
    const clubhouseDeletePostFn = fn('ClubhouseDeletePostFn', 'handlers/clubhouse/deletePost.ts');

    // ---- Profile handlers ----
    const profileGetFn = fn('ProfileGetFn', 'handlers/profile/get.ts');
    const profileUpsertFn = fn('ProfileUpsertFn', 'handlers/profile/upsert.ts');
    const profileDelegationHistoryFn = fn(
      'ProfileDelegationHistoryFn',
      'handlers/profile/delegationHistory.ts',
    );

    // ---- JWT Authorizer Lambda ----
    const jwtAuthorizerFn = fn('JwtAuthorizerFn', 'middleware/jwt-authorizer.ts');

    // ---- HTTP API v2 ----
    const api = new apigwv2.HttpApi(this, 'DRepPlatformApi', {
      apiName: `drep-platform-${stage}`,
      description: 'DRep Coordination Platform API',
      corsPreflight: {
        allowOrigins: ALLOWED_ORIGINS,
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['Content-Type', 'Cookie', 'Authorization'],
        allowCredentials: true,
        maxAge: cdk.Duration.hours(1),
      },
      // Default stage `$default` auto-deploys; throttling is set on the stage.
      createDefaultStage: false,
    });

    new apigwv2.HttpStage(this, 'DefaultStage', {
      httpApi: api,
      stageName: '$default',
      autoDeploy: true,
      throttle: {
        rateLimit: 100,
        burstLimit: 200,
      },
    });

    // ---- Lambda authorizer ----
    // Identity sources include the Cookie header (where browsers send the auth
    // cookie) and the Authorization header (for non-browser clients / future
    // bearer-token use). Caching is disabled (TTL = 0) because the identity
    // value (cookie) is per-user and we want immediate revocation on logout.
    const lambdaAuthorizer = new apigwv2Authorizers.HttpLambdaAuthorizer(
      'JwtLambdaAuthorizer',
      jwtAuthorizerFn,
      {
        responseTypes: [apigwv2Authorizers.HttpLambdaResponseType.SIMPLE],
        identitySource: ['$request.header.Cookie', '$request.header.Authorization'],
        resultsCacheTtl: cdk.Duration.seconds(0),
      },
    );

    // ---- Route helpers ----
    const integ = (handler: lambda.IFunction, id: string): apigwv2Integrations.HttpLambdaIntegration =>
      new apigwv2Integrations.HttpLambdaIntegration(id, handler, {
        payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
      });

    const addRoute = (
      method: apigwv2.HttpMethod,
      route: string,
      handler: lambda.IFunction,
      idHint: string,
      authenticated = false,
    ): void => {
      api.addRoutes({
        path: route,
        methods: [method],
        integration: integ(handler, `${idHint}Integration`),
        ...(authenticated ? { authorizer: lambdaAuthorizer } : {}),
      });
    };

    // ---- Auth routes ----
    addRoute(apigwv2.HttpMethod.POST, '/auth/challenge', challengeFn, 'AuthChallenge');
    addRoute(apigwv2.HttpMethod.POST, '/auth/verify', verifyFn, 'AuthVerify');
    addRoute(apigwv2.HttpMethod.POST, '/auth/refresh', refreshFn, 'AuthRefresh', true);
    addRoute(apigwv2.HttpMethod.DELETE, '/auth/session', logoutFn, 'AuthLogout', true);
    addRoute(apigwv2.HttpMethod.GET, '/auth/me', meFn, 'AuthMe', true);
    addRoute(
      apigwv2.HttpMethod.POST,
      '/auth/mutation-nonce',
      mutationNonceFn,
      'AuthMutationNonce',
      true,
    );

    // ---- Governance routes ----
    addRoute(apigwv2.HttpMethod.GET, '/governance', govListFn, 'GovList');
    addRoute(apigwv2.HttpMethod.GET, '/governance/{actionId}', govGetFn, 'GovGet');
    addRoute(apigwv2.HttpMethod.POST, '/governance/sync', govSyncFn, 'GovSync', true);

    // ---- DRep routes ----
    addRoute(apigwv2.HttpMethod.GET, '/drep', drepListFn, 'DRepList');
    addRoute(apigwv2.HttpMethod.POST, '/drep', drepRegisterFn, 'DRepRegister', true);
    addRoute(apigwv2.HttpMethod.GET, '/drep/{drepId}', drepGetFn, 'DRepGet');
    addRoute(apigwv2.HttpMethod.PUT, '/drep/{drepId}', drepUpdateFn, 'DRepUpdate', true);

    // ---- Comments routes ----
    addRoute(apigwv2.HttpMethod.GET, '/comments/{actionId}', commentsListFn, 'CommentsList');
    addRoute(
      apigwv2.HttpMethod.POST,
      '/comments/{actionId}',
      commentsCreateFn,
      'CommentsCreate',
      true,
    );
    addRoute(
      apigwv2.HttpMethod.DELETE,
      '/comments/{actionId}/{commentId}',
      commentsDeleteFn,
      'CommentsDelete',
      true,
    );

    // ---- Clubhouse routes ----
    addRoute(apigwv2.HttpMethod.GET, '/clubhouse/{drepId}', clubhouseListFn, 'ClubhouseList');
    addRoute(
      apigwv2.HttpMethod.POST,
      '/clubhouse/{drepId}/post',
      clubhouseCreatePostFn,
      'ClubhouseCreatePost',
      true,
    );
    addRoute(
      apigwv2.HttpMethod.POST,
      '/clubhouse/{drepId}/post/{postId}/comment',
      clubhouseCreateCommentFn,
      'ClubhouseCreateComment',
      true,
    );
    addRoute(
      apigwv2.HttpMethod.DELETE,
      '/clubhouse/{drepId}/post/{postId}',
      clubhouseDeletePostFn,
      'ClubhouseDeletePost',
      true,
    );

    // ---- Profile routes ----
    addRoute(apigwv2.HttpMethod.GET, '/profile/{walletAddress}', profileGetFn, 'ProfileGet');
    addRoute(apigwv2.HttpMethod.POST, '/profile', profileUpsertFn, 'ProfileUpsert', true);
    // Authenticated: this endpoint hits Blockfrost on every call; auth-gating
    // it prevents anonymous attackers from amplifying our Blockfrost quota.
    addRoute(
      apigwv2.HttpMethod.GET,
      '/profile/{walletAddress}/delegation-history',
      profileDelegationHistoryFn,
      'ProfileDelegationHistory',
      true,
    );

    this.apiUrl = api.apiEndpoint;

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.apiEndpoint,
      exportName: `${stage}-ApiUrl`,
    });
  }
}
