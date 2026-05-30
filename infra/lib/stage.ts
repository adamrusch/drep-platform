import type { CustomDomainConfig } from './frontend-stack';

/**
 * Centralised stage logic. Every per-stage branch in the CDK app should route
 * through here so that adding a stage (e.g. `test`) is a one-file change and a
 * fat-fingered stage name fails fast instead of silently provisioning a
 * throwaway-policy production table.
 */

/** All recognised deployment stages. Anything else is a typo. */
export const STAGES = ['dev', 'test', 'staging', 'prod'] as const;
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
// TODO(test-stage): the test.drep.tools certificate must be issued before the
// first `cdk deploy --context stage=test`. It is overridable via
// `--context testCertArn=arn:...` so `cdk synth` never blocks on it.
const TEST_CERTIFICATE_ARN_PLACEHOLDER =
  'arn:aws:acm:us-east-1:REDACTED_ACCOUNT_ID:certificate/REPLACE_WITH_TEST_CERT_ARN';

const HOSTED_ZONE_ID = 'Z0487212142GV67N7GOFU';
const ZONE_NAME = 'drep.tools';

/**
 * Per-stage custom-domain config. `test` lives at test.drep.tools with its own
 * cookie scope so its sessions can never bleed onto prod. dev + prod are
 * behaviour-preserving — byte-identical to the pre-refactor hardcoded block.
 */
export function customDomainFor(
  stage: string,
  opts: { testCertArn?: string } = {},
): CustomDomainConfig {
  if (stage === 'test') {
    return {
      hostedZoneId: HOSTED_ZONE_ID,
      zoneName: ZONE_NAME,
      certificateArn: opts.testCertArn ?? TEST_CERTIFICATE_ARN_PLACEHOLDER,
      apexDomain: 'test.drep.tools',
      wwwDomain: 'www.test.drep.tools',
      apiDomain: 'api.test.drep.tools',
      cookieDomain: '.test.drep.tools',
    };
  }
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
