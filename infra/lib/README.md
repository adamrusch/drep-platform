# `infra/lib/`

AWS CDK stacks. Synthesized to CloudFormation by `bin/app.ts`. Per-stage
deployment via `--context stage=dev|staging|prod`.

## Stacks

| File | Purpose |
|------|---------|
| `database-stack.ts` | 8 DynamoDB tables (users, drep_committees, drep_directory, governance_actions, comments, clubhouse_posts, audit_log, auth_nonces) and 9 GSIs. PAY_PER_REQUEST. PITR enabled. RETAIN on prod, DESTROY otherwise |
| `api-stack.ts` | 22 Lambda handlers + JWT authorizer. HTTP API v2 with throttle (100 req/s, 200 burst). Custom domain (`api.drep.tools`) fronted by CloudFront with WAF rate-limit and per-route cache policies. AWS Budgets ($5 soft, $20 hard, alert-only) live here too |
| `frontend-stack.ts` | Private S3 bucket for SPA assets, CloudFront with OAC, custom domain (`drep.tools` + `www.drep.tools`), CSP/HSTS response-headers policy, SPA fallback for React Router |
| `scheduler-stack.ts` | Two scheduled Lambdas: `governance-intake-sync` (every 1 min) and `drep-directory-sync` (every 30 min). Separate execution roles per least-privilege; only the governance role gets the Blockfrost secret |

## Stack dependencies

```
DatabaseStack
   ^
   |
   +-- ApiStack       (handlers need DynamoDB grants + secrets)
   |
   +-- SchedulerStack (sync Lambdas need DynamoDB grants + Blockfrost)

FrontendStack         (independent)
```

## Shared configuration

`bin/app.ts` defines per-stage AWS account/region (`409410541898` /
`us-east-1`) and the `customDomain` block (Hosted Zone ID, ACM
certificate ARN, apex/www/api domains). The hosted zone and certificate
are managed manually outside CDK to avoid destruction risk; CDK imports
them by ID/ARN.

## Deploying

```bash
cd infra
AWS_PROFILE=drep-platform npx cdk deploy --all --context stage=prod

# specific stack
AWS_PROFILE=drep-platform npx cdk deploy DRepPlatform-Api-prod --context stage=prod

# diff before deploy
AWS_PROFILE=drep-platform npx cdk diff --context stage=prod
```

Removal:

```bash
# Be careful — only the dev stack uses RemovalPolicy.DESTROY
AWS_PROFILE=drep-platform npx cdk destroy --all --context stage=dev
```

Production stacks all set `removalPolicy: RETAIN` on stateful resources;
a `cdk destroy` on prod will preserve the DynamoDB tables, S3 bucket,
and Secrets but delete the API/Frontend distributions and Lambdas.
Recreate by re-deploying.

## Bundling notes

Lambda functions use `lambdaNodejs.NodejsFunction` (esbuild bundling).
Two packages need special handling:

- `@emurgo/cardano-serialization-lib-nodejs` ships a `.wasm` file that
  esbuild cannot inline. Listed under `nodeModules: [...]` so CDK
  npm-installs it into the Lambda zip with the WASM intact.
- `blake2b` dynamically `require()`s `blake2b-wasm` at runtime. Same
  treatment.

`@aws-sdk/*` is marked external — Lambda's NodeJS 20 runtime ships AWS
SDK v3 in the layer.

## Outputs

Every stack emits CloudFormation outputs prefixed `<stage>-…` so cross-stack
references are stable. Common outputs:

- `<stage>-UsersTableName`, `<stage>-GovernanceActionsTableName`, etc.
- `<stage>-ApiUrl` (api endpoint), `<stage>-ApiCustomUrl`
  (`https://api.drep.tools`)
- `<stage>-FrontendBucketName`, `<stage>-DistributionUrl`,
  `<stage>-DistributionId`
- `<stage>-GovernanceSyncFnArn`, `<stage>-DirectorySyncFnArn`
- `<stage>-ApiWebAclArn`

Use these in deploy scripts and CI rather than hardcoding ARNs.
