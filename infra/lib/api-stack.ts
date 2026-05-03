import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as apigwv2Authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudfrontOrigins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import { Construct } from 'constructs';
import * as path from 'path';
import type { DatabaseStack } from './database-stack';
import type { CustomDomainConfig } from './frontend-stack';

export interface ApiStackProps extends cdk.StackProps {
  stage: string;
  databaseStack: DatabaseStack;
  customDomain?: CustomDomainConfig;
}

const FALLBACK_ALLOWED_ORIGINS = [
  'https://dbq4k0wz4ik0v.cloudfront.net',
  'http://localhost:5173',
];

export class ApiStack extends cdk.Stack {
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { stage, databaseStack, customDomain } = props;
    const backendDir = path.join(__dirname, '../../backend');

    // Compute the CORS allow-list. When a custom domain is configured the
    // browser will load the SPA from https://drep.tools / https://www.drep.tools,
    // so those origins must be allowlisted in addition to the CloudFront
    // default domain (kept for fallback / debugging).
    const allowedOrigins = customDomain
      ? [
          `https://${customDomain.apexDomain}`,
          `https://${customDomain.wwwDomain}`,
          ...FALLBACK_ALLOWED_ORIGINS,
        ]
      : FALLBACK_ALLOWED_ORIGINS;
    const primaryCorsOrigin = customDomain
      ? `https://${customDomain.apexDomain}`
      : FALLBACK_ALLOWED_ORIGINS[0];

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
      CORS_ORIGIN: primaryCorsOrigin,
      CORS_ALLOWED_ORIGINS: allowedOrigins.join(','),
      ...(customDomain ? { COOKIE_DOMAIN: `.${customDomain.zoneName}` } : {}),
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
      databaseStack.drepDirectoryTable,
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
        // See scheduler-stack.ts for rationale — CSL ships a .wasm file
        // that esbuild can't inline. nodeModules causes npm-install at
        // bundle time so the WASM lands in the Lambda zip intact.
        // blake2b dynamically require()s blake2b-wasm; same treatment.
        nodeModules: ['@emurgo/cardano-serialization-lib-nodejs', 'blake2b'],
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
    const govStatsFn = fn('GovStatsFn', 'handlers/governance/stats.ts');

    // ---- Epoch handler ----
    const epochGetFn = fn('EpochGetFn', 'handlers/epoch/get.ts');

    // ---- DRep committee handlers (existing /drep routes) ----
    const drepListFn = fn('DRepListFn', 'handlers/drep/list.ts');
    const drepGetFn = fn('DRepGetFn', 'handlers/drep/get.ts');
    const drepRegisterFn = fn('DRepRegisterFn', 'handlers/drep/register.ts');
    const drepUpdateFn = fn('DRepUpdateFn', 'handlers/drep/update.ts');

    // ---- DRep directory handlers (chain-state read; /dreps routes) ----
    // The directory is the global registry of mainnet DReps with their
    // CIP-119 anchor metadata. It's separate from /drep (committees) on
    // purpose — committees are platform-internal coordination records,
    // while this is a chain-state read of every registered DRep.
    const drepDirectoryListFn = fn('DRepDirectoryListFn', 'handlers/directory/list.ts');
    const drepDirectoryGetFn = fn('DRepDirectoryGetFn', 'handlers/directory/get.ts');

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
    const clubhouseVotePollFn = fn('ClubhouseVotePollFn', 'handlers/clubhouse/votePoll.ts');

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
        allowOrigins: allowedOrigins,
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

    const defaultStage = new apigwv2.HttpStage(this, 'DefaultStage', {
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
        // HTTP API v2 requires ALL listed identity sources to be present in the
        // request before invoking the authorizer Lambda. The browser SPA only
        // sends `Cookie`, so listing `Authorization` here would silently 401
        // every browser request. The authorizer Lambda itself reads both
        // `Cookie` and `Authorization` headers internally — non-browser bearer
        // clients still work, they just bypass the cache key for now.
        identitySource: ['$request.header.Cookie'],
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
    // NOTE: register `/governance/stats` BEFORE `/governance/{actionId}`.
    // HTTP API v2 always prefers static segments over path parameters
    // regardless of declaration order, but listing the literal route first
    // also avoids confusing the local reader.
    addRoute(apigwv2.HttpMethod.GET, '/governance', govListFn, 'GovList');
    addRoute(apigwv2.HttpMethod.GET, '/governance/stats', govStatsFn, 'GovStats');
    addRoute(apigwv2.HttpMethod.GET, '/governance/{actionId}', govGetFn, 'GovGet');
    addRoute(apigwv2.HttpMethod.POST, '/governance/sync', govSyncFn, 'GovSync', true);

    // ---- Epoch route (public, hits Blockfrost on every call) ----
    addRoute(apigwv2.HttpMethod.GET, '/epoch', epochGetFn, 'EpochGet');

    // ---- DRep committee routes (existing) ----
    addRoute(apigwv2.HttpMethod.GET, '/drep', drepListFn, 'DRepList');
    addRoute(apigwv2.HttpMethod.POST, '/drep', drepRegisterFn, 'DRepRegister', true);
    addRoute(apigwv2.HttpMethod.GET, '/drep/{drepId}', drepGetFn, 'DRepGet');
    addRoute(apigwv2.HttpMethod.PUT, '/drep/{drepId}', drepUpdateFn, 'DRepUpdate', true);

    // ---- DRep directory routes (chain-state) ----
    addRoute(apigwv2.HttpMethod.GET, '/dreps', drepDirectoryListFn, 'DRepDirectoryList');
    addRoute(apigwv2.HttpMethod.GET, '/dreps/{drepId}', drepDirectoryGetFn, 'DRepDirectoryGet');

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
    // Poll vote — JWT-only (no mutation-nonce). Trade-off documented in
    // handlers/clubhouse/votePoll.ts.
    addRoute(
      apigwv2.HttpMethod.POST,
      '/clubhouse/{drepId}/post/{postId}/vote',
      clubhouseVotePollFn,
      'ClubhouseVotePoll',
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

    // ---- Custom domain + CloudFront in front of the API ----
    //
    // Architecture (top → bottom):
    //   Browser → api.drep.tools (Route 53 alias)
    //          → CloudFront distribution (cache layer + WAF rate-limit)
    //          → API Gateway HTTP API regional endpoint (origin)
    //          → Lambda handlers
    //
    // Why CloudFront in front of API Gateway:
    //   - 95%+ reduction in worst-case attack cost: the heavy read endpoints
    //     (`/dreps`, `/governance`) are cacheable — a botnet pounding them
    //     at 10 req/s/IP gets served by the edge with one Lambda invocation
    //     per 30s window per cache key, instead of one invocation per
    //     request.
    //   - WAF rate-based rules attach to CloudFront and inspect there, well
    //     before traffic reaches API Gateway.
    //   - Cache headers (Cache-Control: public, s-maxage=30) are emitted by
    //     each handler; CloudFront honors them.
    //
    // CRITICAL: cache key for the cached behaviors must NOT include the
    // `Cookie` header. If it did, every authenticated user would have their
    // own edge entry (no benefit) AND a misconfiguration could serve one
    // user's cookied response to another. The cached endpoints here are
    // public reads — auth state lives entirely on `/auth/*` (no-cache) and
    // never appears in cacheable response bodies.
    if (customDomain) {
      const apiCert = acm.Certificate.fromCertificateArn(
        this,
        'ApiCert',
        customDomain.certificateArn,
      );

      // We still need the API Gateway custom domain mapping so CloudFront
      // can use a stable origin DNS name (`d-xxx.execute-api...`). Without
      // the custom domain mapping, we'd point CloudFront at the raw
      // `<api-id>.execute-api...` host, which works but emits a Host
      // header that some HTTP API integrations dislike.
      //
      // NOTE: the API Gateway custom domain is NOT what end users hit
      // anymore — Route 53 will point `api.drep.tools` at the CloudFront
      // distribution below. We keep the API Gateway domain object purely
      // as a convenient origin handle.
      const apiCustomDomain = new apigwv2.DomainName(this, 'ApiDomainName', {
        domainName: customDomain.apiDomain,
        certificate: apiCert,
        endpointType: apigwv2.EndpointType.REGIONAL,
        securityPolicy: apigwv2.SecurityPolicy.TLS_1_2,
      });

      new apigwv2.ApiMapping(this, 'ApiMapping', {
        api,
        domainName: apiCustomDomain,
        stage: defaultStage,
      });

      // ---- CloudFront cache + origin policies ----
      //
      // Cached behavior cache key:
      //   - Method (GET only — POST/PUT/DELETE go through the no-cache
      //     default behavior)
      //   - Path
      //   - All query strings (includes `?sort=...&page=...&search=...`
      //     for /dreps; sorting differs by query, so varying matters)
      //   - NO cookies, NO headers other than Origin (CORS)
      //
      // Origin request policy for cached behavior:
      //   - Forward Origin header (CORS preflight) and the query strings.
      //   - Do NOT forward Cookie or Authorization — these are cached
      //     responses, the origin is a public read.
      const cachedQueryStrings = cloudfront.OriginRequestQueryStringBehavior.all();
      const cachedKeyPolicy = new cloudfront.CachePolicy(this, 'ApiCachedKeyPolicy', {
        cachePolicyName: `drep-platform-${stage}-api-cached`,
        comment: 'Cache GET reads with method+path+query only — no cookies in key.',
        defaultTtl: cdk.Duration.seconds(30),
        minTtl: cdk.Duration.seconds(0),
        maxTtl: cdk.Duration.seconds(300),
        cookieBehavior: cloudfront.CacheCookieBehavior.none(),
        headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Origin'),
        queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
        enableAcceptEncodingGzip: true,
        enableAcceptEncodingBrotli: true,
      });
      const cachedOriginPolicy = new cloudfront.OriginRequestPolicy(
        this,
        'ApiCachedOriginPolicy',
        {
          originRequestPolicyName: `drep-platform-${stage}-api-cached-origin`,
          comment: 'Forward Origin header + query strings to API Gateway. No cookies.',
          cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
          headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList('Origin'),
          queryStringBehavior: cachedQueryStrings,
        },
      );

      // No-cache (passthrough) for /auth/* and mutation routes. Use the
      // AWS-managed `CachingDisabled` policy — CloudFront rejects custom
      // cache policies with TTL=0 that also set HeaderBehavior, since
      // header inclusion in the cache key is meaningless when nothing is
      // cached. The managed CachingDisabled policy correctly omits cache-
      // key fields entirely. Origin behavior (what gets forwarded) is
      // controlled separately by the origin request policy below.
      const passthroughCachePolicy = cloudfront.CachePolicy.CACHING_DISABLED;
      // ALL_VIEWER_EXCEPT_HOST_HEADER is a CloudFront-managed origin
      // request policy that forwards every header / cookie / query string
      // from the viewer EXCEPT Host (which CloudFront overwrites with the
      // origin's hostname automatically). Exactly what the auth /
      // mutation pass-through path needs.
      const passthroughOriginPolicy = cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER;

      // Origin: API Gateway HTTP API regional domain. We use the API GW
      // custom-domain regional name (set up above) so the Host header that
      // CloudFront sends matches what API Gateway expects.
      const origin = new cloudfrontOrigins.HttpOrigin(
        apiCustomDomain.regionalDomainName,
        {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          // Sensible timeouts. Lambda timeout is 30s on most handlers; allow
          // the full origin response window to avoid CloudFront 502s on
          // slow but legitimate requests (e.g. /dreps directory scan with
          // a cold Lambda).
          readTimeout: cdk.Duration.seconds(30),
          connectionTimeout: cdk.Duration.seconds(10),
        },
      );

      // ---- CloudFront distribution ----
      //
      // Default behavior = pass-through (no caching). This is the safe
      // default — anything we don't explicitly mark cacheable goes
      // straight to origin with all headers + cookies forwarded.
      // Cacheable GET routes are added as additionalBehaviors below.
      const apiDistribution = new cloudfront.Distribution(this, 'ApiDistribution', {
        comment: `drep-platform ${stage} API edge cache + WAF`,
        domainNames: [customDomain.apiDomain],
        certificate: apiCert,
        defaultBehavior: {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
          cachePolicy: passthroughCachePolicy,
          originRequestPolicy: passthroughOriginPolicy,
          // No response headers policy on the default behavior — the
          // origin's CORS headers pass through verbatim.
          compress: true,
        },
        additionalBehaviors: {
          // Cacheable GET reads. Each path uses the same cached cache+
          // origin policies (no cookies, query strings forwarded).
          //
          // IMPORTANT: CloudFront path patterns are evaluated in declaration
          // order. We list specific routes first and broader patterns last.
          // POST/PUT/DELETE on these paths fall through to the default
          // (no-cache) behavior because the AllowedMethods on the cached
          // behaviors is GET/HEAD only — CloudFront will return a 403 for
          // a POST on a GET-only behavior, which we want to AVOID, so we
          // include OPTIONS in the cached behaviors and route POSTs via
          // the no-cache default for explicit paths like /comments and
          // /clubhouse below.
          //
          // To handle this cleanly: cache behaviors below allow GET/HEAD/
          // OPTIONS only; the matching POST/PUT/DELETE routes (e.g.
          // /comments/{id} POST, /clubhouse/.../post POST) need their
          // own no-cache behavior since they share path patterns with
          // GET reads. We declare those NO-CACHE behaviors FIRST so they
          // take precedence in CloudFront's longest-prefix-match rules.

          // /auth/* — never cache. Cookies + Authorization headers pass
          // through unchanged. All HTTP methods allowed.
          '/auth/*': {
            origin,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
            cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
            cachePolicy: passthroughCachePolicy,
            originRequestPolicy: passthroughOriginPolicy,
            compress: true,
          },
          // /comments/* — POST/DELETE are mutations, GET is the only
          // cacheable read. Since POST and GET share the same path prefix,
          // we route the entire prefix through the no-cache behavior to
          // avoid the GET-only-allowed-methods bug. Trade-off: we lose
          // edge caching on /comments GET, but we still have the
          // Cache-Control: public, max-age=15 header so browsers cache
          // it client-side.
          '/comments/*': {
            origin,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
            cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
            cachePolicy: passthroughCachePolicy,
            originRequestPolicy: passthroughOriginPolicy,
            compress: true,
          },
          // /clubhouse/* — same reasoning as /comments. Mutations and reads
          // share path prefix; route all to no-cache.
          '/clubhouse/*': {
            origin,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
            cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
            cachePolicy: passthroughCachePolicy,
            originRequestPolicy: passthroughOriginPolicy,
            compress: true,
          },
          // /profile/* — POST creates/updates the auth'd user's profile,
          // GET fetches a public profile. Same shared-prefix issue, route
          // to no-cache. The handler still emits Cache-Control headers
          // for the GET, so the browser caches it.
          '/profile/*': {
            origin,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
            cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
            cachePolicy: passthroughCachePolicy,
            originRequestPolicy: passthroughOriginPolicy,
            compress: true,
          },
          // /drep/* (committee routes) — POST + PUT mix with GET. Same
          // shared-prefix logic: route all through no-cache, rely on
          // browser caching from origin Cache-Control where applicable.
          '/drep/*': {
            origin,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
            cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
            cachePolicy: passthroughCachePolicy,
            originRequestPolicy: passthroughOriginPolicy,
            compress: true,
          },
          // /governance/sync is a POST — route /governance/sync* to
          // no-cache to override the cacheable /governance/* below.
          // (CloudFront uses longest-prefix; this 14-char pattern beats
          // the 12-char `/governance/*`).
          '/governance/sync': {
            origin,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
            cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
            cachePolicy: passthroughCachePolicy,
            originRequestPolicy: passthroughOriginPolicy,
            compress: true,
          },
          // ---- Cacheable GET routes ----
          // /governance — list of governance actions (paginated reads).
          // GET-only for the purpose of caching. We allow GET/HEAD/OPTIONS
          // (OPTIONS is the CORS preflight, never cached but allowed).
          '/governance': {
            origin,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
            cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
            cachePolicy: cachedKeyPolicy,
            originRequestPolicy: cachedOriginPolicy,
            compress: true,
          },
          // /governance/* (after /governance/sync) — covers /governance/{id}
          // and /governance/stats. Both GET, both cacheable.
          '/governance/*': {
            origin,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
            cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
            cachePolicy: cachedKeyPolicy,
            originRequestPolicy: cachedOriginPolicy,
            compress: true,
          },
          // /dreps — directory list. GET-only.
          '/dreps': {
            origin,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
            cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
            cachePolicy: cachedKeyPolicy,
            originRequestPolicy: cachedOriginPolicy,
            compress: true,
          },
          // /dreps/* — single-DRep detail.
          '/dreps/*': {
            origin,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
            cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
            cachePolicy: cachedKeyPolicy,
            originRequestPolicy: cachedOriginPolicy,
            compress: true,
          },
          // /epoch — epoch info, already module-cached at the Lambda layer.
          '/epoch': {
            origin,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
            cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
            cachePolicy: cachedKeyPolicy,
            originRequestPolicy: cachedOriginPolicy,
            compress: true,
          },
        },
        priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
        // No HTTP/3 (default off in CDK). HTTP/2 is fine.
      });

      // ---- WAF — Layer 2 ----
      //
      // Single rate-based rule, scoped CLOUDFRONT (us-east-1 ACL). 2000
      // requests / 5 min sliding window per source IP, action BLOCK.
      // Default ACL action ALLOW so only the rate rule blocks.
      //
      // Logging: CloudWatch log group with 7-day retention. Required log
      // group name prefix is `aws-waf-logs-` for WAF to accept it.
      const wafLogGroup = new logs.LogGroup(this, 'ApiWafLogGroup', {
        logGroupName: `aws-waf-logs-drep-platform-${stage}-api`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: stage === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      });

      const webAcl = new wafv2.CfnWebACL(this, 'ApiWebAcl', {
        name: `drep-platform-${stage}-api`,
        scope: 'CLOUDFRONT',
        defaultAction: { allow: {} },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: `drep-platform-${stage}-api-acl`,
          sampledRequestsEnabled: true,
        },
        rules: [
          {
            name: 'RateLimitPerIp',
            priority: 1,
            statement: {
              rateBasedStatement: {
                limit: 2000,
                aggregateKeyType: 'IP',
                // 5-minute sliding window — WAF only supports 1 / 2 / 5
                // / 10 minute windows; 5 is the right one here.
                evaluationWindowSec: 300,
              },
            },
            action: { block: {} },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: `drep-platform-${stage}-api-ratelimit`,
              sampledRequestsEnabled: true,
            },
          },
        ],
      });

      // Associate the Web ACL with the CloudFront distribution.
      // CloudFront uses the WebACLId via the distribution's WebACLId
      // attribute, not a separate association (unlike API Gateway).
      // We do this via the distribution's underlying CFN resource.
      const cfnDistribution = apiDistribution.node.defaultChild as cloudfront.CfnDistribution;
      cfnDistribution.addPropertyOverride('DistributionConfig.WebACLId', webAcl.attrArn);

      // WAF logging configuration. The destination is the CW log group.
      // Without this, WAF still BLOCKs but we can't audit which IPs/UAs
      // got blocked.
      new wafv2.CfnLoggingConfiguration(this, 'ApiWafLogging', {
        resourceArn: webAcl.attrArn,
        logDestinationConfigs: [wafLogGroup.logGroupArn],
      });

      // ---- Route 53 alias: api.drep.tools → CloudFront ----
      // Replaces the previous ApiGatewayv2 alias target. The CloudFront
      // distribution is what end-users hit; CloudFront forwards to the
      // API Gateway origin defined above.
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'ApiZone', {
        hostedZoneId: customDomain.hostedZoneId,
        zoneName: customDomain.zoneName,
      });
      const apiCloudFrontTarget = route53.RecordTarget.fromAlias(
        new route53Targets.CloudFrontTarget(apiDistribution),
      );
      new route53.ARecord(this, 'ApiAliasA', {
        zone,
        recordName: customDomain.apiDomain,
        target: apiCloudFrontTarget,
      });
      new route53.AaaaRecord(this, 'ApiAliasAAAA', {
        zone,
        recordName: customDomain.apiDomain,
        target: apiCloudFrontTarget,
      });

      new cdk.CfnOutput(this, 'ApiCustomUrl', {
        value: `https://${customDomain.apiDomain}`,
        exportName: `${stage}-ApiCustomUrl`,
      });
      new cdk.CfnOutput(this, 'ApiDistributionUrl', {
        value: `https://${apiDistribution.distributionDomainName}`,
        exportName: `${stage}-ApiDistributionUrl`,
      });
      new cdk.CfnOutput(this, 'ApiDistributionId', {
        value: apiDistribution.distributionId,
        exportName: `${stage}-ApiDistributionId`,
      });
      new cdk.CfnOutput(this, 'ApiWebAclArn', {
        value: webAcl.attrArn,
        exportName: `${stage}-ApiWebAclArn`,
      });
    }

    // ---- Layer 5 — AWS Budgets (alert-only, no auto-action) ----
    //
    // IMPORTANT: these budgets are alert-only. Per the user's explicit
    // instruction, NEVER add automated stop / IAM-deny actions here.
    // If a future dev wants auto-deny, that's a separate, deliberate
    // decision — uncommenting an "actions" array here without that
    // discussion would silently disable the platform on a billing
    // spike, which is much worse UX than getting an email.
    //
    // Budgets are a global service (no region) and free of charge.
    // They live on the API stack purely for code locality with the
    // other cost-protection layers.
    new budgets.CfnBudget(this, 'SoftBudget', {
      budget: {
        budgetName: `drep-platform-${stage}-soft-monthly`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: 5, unit: 'USD' },
        // includeCredit: false → measures gross spend before AWS credits.
        costTypes: {
          includeCredit: false,
          includeRefund: false,
          includeSubscription: true,
          includeRecurring: true,
          includeOtherSubscription: true,
          includeSupport: true,
          includeTax: true,
          includeUpfront: true,
          useBlended: false,
          useAmortized: false,
          includeDiscount: true,
        },
      },
      // Alert-only — NO actions block.
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 80,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [
            { subscriptionType: 'EMAIL', address: 'claude@rusch.me' },
          ],
        },
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [
            { subscriptionType: 'EMAIL', address: 'claude@rusch.me' },
          ],
        },
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 120,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [
            { subscriptionType: 'EMAIL', address: 'claude@rusch.me' },
          ],
        },
      ],
    });

    new budgets.CfnBudget(this, 'HardBudget', {
      budget: {
        budgetName: `drep-platform-${stage}-hard-monthly`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: 20, unit: 'USD' },
        costTypes: {
          includeCredit: false,
          includeRefund: false,
          includeSubscription: true,
          includeRecurring: true,
          includeOtherSubscription: true,
          includeSupport: true,
          includeTax: true,
          includeUpfront: true,
          useBlended: false,
          useAmortized: false,
          includeDiscount: true,
        },
      },
      // Alert-only — NO actions block. Same rationale as SoftBudget above.
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [
            { subscriptionType: 'EMAIL', address: 'claude@rusch.me' },
          ],
        },
      ],
    });
  }
}
