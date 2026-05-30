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

const env: cdk.Environment = {
  account: 'REDACTED_ACCOUNT_ID',
  region: 'us-east-1',
};

// ---- Custom domain configuration (drep.tools) ----
// Per-stage: prod/dev → drep.tools, test → test.drep.tools (separate cookie
// scope). The hosted zone and ACM certificates are managed manually outside
// CDK to avoid destruction risk; CDK imports them by ID/ARN. The test cert can
// be supplied via `--context testCertArn=arn:...` until it's the default.
const testCertArn = app.node.tryGetContext('testCertArn') as string | undefined;
const customDomain = customDomainFor(stage, { testCertArn });

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

const frontendStack = new FrontendStack(app, `DRepPlatform-Frontend-${stage}`, {
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
