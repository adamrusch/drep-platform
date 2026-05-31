import type { CustomDomainConfig } from './frontend-stack';

/**
 * Centralised stage logic. Every per-stage branch in the CDK app should route
 * through here so that adding a stage (e.g. `test`) is a one-file change and a
 * fat-fingered stage name fails fast instead of silently provisioning a
 * throwaway-policy production table.
 */

/** All recognised deployment stages. Anything else is a typo.
 *  Only `test` and `prod` have a real custom-domain config (see
 *  `customDomainFor`); `dev` deploys on raw CloudFront/API-Gateway URLs. A
 *  `staging` stage was removed — it shared prod's `drep.tools` domain config,
 *  so `--context stage=staging` would have collided with prod's Route53/cookies.
 *  Reintroduce it only alongside its own domain block. */
export const STAGES = ['dev', 'test', 'prod'] as const;
export type Stage = (typeof STAGES)[number];

/** Throw early on an unknown stage so `--context stage=prdo` can't deploy. */
export function assertStage(stage: string): asserts stage is Stage {
  if (!(STAGES as readonly string[]).includes(stage)) {
    throw new Error(
      `Unknown stage "${stage}". Expected one of: ${STAGES.join(', ')}. ` +
        'Pass it with --context stage=<stage>.',
    );
  }
}

export function isProd(stage: string): boolean {
  return stage === 'prod';
}

/**
 * Stages whose stateful resources (DynamoDB tables, the frontend S3 bucket)
 * must survive a stack replace/destroy. prod obviously — and `test`, because
 * test.drep.tools holds real mainnet-shaped data we don't want to lose to a
 * stray `cdk destroy`.
 */
export function isPersistent(stage: string): boolean {
  return stage === 'prod' || stage === 'test';
}

// ACM certificates live OUTSIDE CDK — issued manually and DNS-validated in the
// drep.tools hosted zone — to avoid destruction risk. CDK imports them by ARN.
const PROD_CERTIFICATE_ARN =
  'arn:aws:acm:us-east-1:REDACTED_ACCOUNT_ID:certificate/9b367d8e-f72f-4e69-9f02-0124c70c7149';
// ACM cert for test.drep.tools + www + api (us-east-1, DNS-validated in the
// drep.tools zone). Issued 2026-05-30. Overridable via `--context testCertArn=`.
const TEST_CERTIFICATE_ARN =
  'arn:aws:acm:us-east-1:REDACTED_ACCOUNT_ID:certificate/b252b08e-d328-4ec2-804e-623eed1b7ef1';

const HOSTED_ZONE_ID = 'Z0487212142GV67N7GOFU';
const ZONE_NAME = 'drep.tools';

/**
 * Per-stage custom-domain config. `test` lives at test.drep.tools with its own
 * cookie scope so its sessions can never bleed onto prod; `prod` owns the apex
 * drep.tools. `dev` (and any other stage) returns `undefined` — it deploys on
 * the raw CloudFront/API-Gateway URLs with NO custom domain, so a dev deploy can
 * never bind or shadow prod's drep.tools records. Both the API and frontend
 * stacks treat `customDomain` as optional and guard every use.
 */
export function customDomainFor(
  stage: string,
  opts: { testCertArn?: string } = {},
): CustomDomainConfig | undefined {
  if (stage === 'test') {
    return {
      hostedZoneId: HOSTED_ZONE_ID,
      zoneName: ZONE_NAME,
      certificateArn: opts.testCertArn ?? TEST_CERTIFICATE_ARN,
      apexDomain: 'test.drep.tools',
      wwwDomain: 'www.test.drep.tools',
      apiDomain: 'api.test.drep.tools',
      cookieDomain: '.test.drep.tools',
    };
  }
  if (stage === 'prod') {
    return {
      hostedZoneId: HOSTED_ZONE_ID,
      zoneName: ZONE_NAME,
      certificateArn: PROD_CERTIFICATE_ARN,
      apexDomain: 'drep.tools',
      wwwDomain: 'www.drep.tools',
      apiDomain: 'api.drep.tools',
      cookieDomain: '.drep.tools',
    };
  }
  return undefined;
}
