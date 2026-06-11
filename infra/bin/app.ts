#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { DatabaseStack } from '../lib/database-stack';
import { ApiStack } from '../lib/api-stack';
import { FrontendStack } from '../lib/frontend-stack';
import { SchedulerStack } from '../lib/scheduler-stack';
import { assertStage, customDomainFor } from '../lib/stage';

const app = new cdk.App();

const stage = app.node.tryGetContext('stage') as string | undefined ?? 'dev';
assertStage(stage); // fail fast on a typo'd stage before provisioning anything

// PRODUCTION WARNING: the live drep.tools site is currently served by the `dev`
// stage stacks (historical artifact — see docs/TOPOLOGY.md). Until the planned
// migration to real `*-prod` stacks, deploying `dev` (or `prod`) changes the
// live site, and because `dev` now resolves to no custom domain a deploy would
// DETACH drep.tools. The deploy.sh wrapper hard-blocks this without
// `--touch-production`; this banner covers a direct `cdk deploy`.
if (stage === 'dev' || stage === 'prod') {
  console.error(
    `\n⚠️  Stage "${stage}" currently serves the LIVE drep.tools site. ` +
      `Deploying it changes production (and a "dev" deploy detaches the domain). ` +
      `See docs/TOPOLOGY.md before proceeding.\n`,
  );
}

const env: cdk.Environment = {
  account: '409410541898',
  region: 'us-east-1',
};

// ---- Custom domain configuration (drep.tools) ----
// Per-stage: prod → drep.tools, test → test.drep.tools (separate cookie scope),
// dev → undefined (raw CloudFront/API URLs, no custom domain). The hosted zone
// and ACM certificates are managed manually outside CDK to avoid destruction
// risk; CDK imports them by ID/ARN. The test cert can be supplied via
// `--context testCertArn=arn:...` until it's the default.
const testCertArn = app.node.tryGetContext('testCertArn') as string | undefined;
// `--context noCustomDomain=1` suppresses the custom-domain config so the
// stacks deploy on their raw CloudFront / API-Gateway URLs only. Used during
// the dev→prod migration (docs/TOPOLOGY.md) to stand up + smoke-test the
// `*-prod` stacks BEFORE the cutover, while the `dev` stacks still hold the
// `drep.tools` / `api.drep.tools` aliases (a CloudFront alias can live on only
// one distribution, so claiming it early would fail). Drop the flag for the
// cutover deploy so prod claims the now-free aliases + recreates Route53.
const suppressDomain = Boolean(app.node.tryGetContext('noCustomDomain'));
const customDomain = suppressDomain ? undefined : customDomainFor(stage, { testCertArn });

const databaseStack = new DatabaseStack(app, `DRepPlatform-Database-${stage}`, {
  stage,
  env,
  description: `DRep Platform DynamoDB tables — ${stage}`,
  tags: {
    Project: 'drep-platform',
    Stage: stage,
  },
});

const apiStack = new ApiStack(app, `DRepPlatform-Api-${stage}`, {
  stage,
  databaseStack,
  customDomain,
  env,
  description: `DRep Platform API Gateway + Lambda — ${stage}`,
  tags: {
    Project: 'drep-platform',
    Stage: stage,
  },
});
apiStack.addDependency(databaseStack);

const _frontendStack = new FrontendStack(app, `DRepPlatform-Frontend-${stage}`, {
  stage,
  customDomain,
  env,
  description: `DRep Platform S3 + CloudFront — ${stage}`,
  tags: {
    Project: 'drep-platform',
    Stage: stage,
  },
});

const schedulerStack = new SchedulerStack(app, `DRepPlatform-Scheduler-${stage}`, {
  stage,
  databaseStack,
  env,
  description: `DRep Platform EventBridge scheduler — ${stage}`,
  tags: {
    Project: 'drep-platform',
    Stage: stage,
  },
});
schedulerStack.addDependency(databaseStack);

app.synth();
