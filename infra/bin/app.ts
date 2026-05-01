#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { DatabaseStack } from '../lib/database-stack';
import { ApiStack } from '../lib/api-stack';
import { FrontendStack } from '../lib/frontend-stack';
import { SchedulerStack } from '../lib/scheduler-stack';

const app = new cdk.App();

const stage = app.node.tryGetContext('stage') as string | undefined ?? 'dev';

const env: cdk.Environment = {
  account: '409410541898',
  region: 'us-east-1',
};

// ---- Custom domain configuration (drep.tools) ----
// Enabled for all stages currently. Apex + www → frontend; api.drep.tools → API.
// The hosted zone and ACM certificate are managed manually outside CDK to avoid
// destruction risk; CDK imports them by ID/ARN.
const customDomain = {
  hostedZoneId: 'Z0487212142GV67N7GOFU',
  zoneName: 'drep.tools',
  certificateArn:
    'arn:aws:acm:us-east-1:409410541898:certificate/9b367d8e-f72f-4e69-9f02-0124c70c7149',
  apexDomain: 'drep.tools',
  wwwDomain: 'www.drep.tools',
  apiDomain: 'api.drep.tools',
};

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
