#!/usr/bin/env npx tsx
/**
 * scripts/check-deploy-drift.ts — Lambda code-drift detector
 *
 * Why this exists (2026-05-26):
 *   `cdk deploy` can silently no-op when two invocations race against a
 *   shared `cdk.out/` directory — the second one prints a warning about
 *   "Another CLI is currently synthing" and exits 0. The clean exit
 *   code mas an `aws lambda get-function-configuration` showing a 9-day
 *   stale `LastModified`. This script is the canary: it answers "does
 *   the deployed Lambda code match what the current source tree would
 *   produce?"
 *
 * Strategy: PERMISSIVE (asset-hash comparison via cdk synth)
 *
 *   The script does NOT recompute AWS Lambda's `CodeSha256` — that's
 *   base64(SHA-256(deployed-zip-bytes)) and reproducing it from
 *   sources requires replicating CDK's bundling + archiver zip
 *   semantics byte-for-byte (esbuild flags, mtime normalization,
 *   central-directory ordering, etc.). That's fragile across CDK and
 *   esbuild versions; a single dependency bump in cdk-assets could
 *   silently invalidate every drift check.
 *
 *   Instead we use CDK as its own oracle:
 *     1. Run `cdk synth` into a temp dir to produce the asset
 *        directories and CFN template that CDK *would* deploy from
 *        the current source tree.
 *     2. Read each Lambda's `Code.S3Key` from the synth output. That
 *        key prefix IS the CDK asset hash — a stable, deterministic
 *        identifier CDK uses to decide whether a Lambda needs an
 *        upload. (CDK's asset hash includes source content + bundling
 *        options + esbuild output; if anything changes, the hash
 *        changes.)
 *     3. Read each Lambda's CURRENTLY-DEPLOYED `Code.S3Key` from the
 *        CloudFormation stack's template via `aws cloudformation
 *        get-template`. This is what CFN thinks it deployed last.
 *     4. Compare. Mismatch == local source has changed since the last
 *        successful deploy.
 *   Plus we surface `CodeSha256` and `LastModified` from `aws lambda
 *   get-function-configuration` so you can see how stale the actually-
 *   deployed code is (this is the 9-day-stale signal that bit us).
 *
 *   This is functionally equivalent to "strict" SHA-256 matching for
 *   our use case (catching the cdk.out race), without the fragility.
 *   The compromise: we cannot detect "AWS Lambda's CodeSha256 differs
 *   from what CDK shipped" — i.e. someone manually edited the Lambda
 *   in the AWS Console. The `LastModified` column covers that case at
 *   the human-judgement level.
 *
 * Usage:
 *     npx tsx scripts/check-deploy-drift.ts                          # all four stacks
 *     npx tsx scripts/check-deploy-drift.ts DRepPlatform-Api-dev     # one stack
 *
 * Exit codes:
 *     0   No drift detected (all stacks scanned cleanly).
 *     1   Argument / runtime error.
 *     2   Drift detected on at least one Lambda.
 */
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const STAGE = 'dev';
const ALL_STACKS = [
  `DRepPlatform-Database-${STAGE}`,
  `DRepPlatform-Api-${STAGE}`,
  `DRepPlatform-Frontend-${STAGE}`,
  `DRepPlatform-Scheduler-${STAGE}`,
];

const REPO_ROOT = path.resolve(__dirname, '..');
const INFRA_DIR = path.join(REPO_ROOT, 'infra');
const AWS_PROFILE = process.env.AWS_PROFILE ?? 'drep-platform';
const AWS_REGION = process.env.AWS_REGION ?? 'us-east-1';

interface LambdaCheck {
  logicalId: string;
  functionName?: string;
  localS3Key: string;
  deployedS3Key: string | null;
  codeSha256: string | null;
  lastModified: string | null;
  ageHours: number | null;
  match: 'match' | 'drift' | 'undeployed' | 'unknown';
}

function awsCmd(args: string[]): string {
  // The `aws` CLI is the only external dependency. We pass --profile +
  // --region explicitly so this works the same regardless of which
  // shell env the user has loaded.
  const fullArgs = ['--profile', AWS_PROFILE, '--region', AWS_REGION, ...args];
  return execSync(`aws ${fullArgs.map(shellEscape).join(' ')}`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function shellEscape(s: string): string {
  if (/^[A-Za-z0-9_\-./=]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function cdkSynthAll(outDir: string): void {
  // Synthesize ALL stacks once into a throwaway dir. We deliberately
  // don't reuse `cdk.out/` — it might be shared with an in-flight
  // deploy. CDK's `app.ts` always instantiates every stack regardless
  // of which one(s) you ask for on the CLI, so a single `cdk synth`
  // is the same wall-clock cost as one-per-stack and produces a
  // template.json for each.
  console.error(`  synthesizing all stacks → ${outDir} (this can take ~60s for bundling) ...`);
  execSync(
    `npx cdk synth --all --context stage=${STAGE} --output ${shellEscape(outDir)} --quiet`,
    {
      cwd: INFRA_DIR,
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  );
}

function readTemplateLambdas(templateJson: object): Array<{
  logicalId: string;
  functionName?: string;
  s3Key: string;
}> {
  // CFN template shape:
  //   { "Resources": { "<LogicalId>": { "Type": "AWS::Lambda::Function",
  //                                     "Properties": { "FunctionName": "...",
  //                                                     "Code": { "S3Bucket": "...",
  //                                                               "S3Key": "<hash>.zip" } } } } }
  const out: Array<{ logicalId: string; functionName?: string; s3Key: string }> = [];
  const resources = (templateJson as { Resources?: Record<string, unknown> }).Resources ?? {};
  for (const [logicalId, raw] of Object.entries(resources)) {
    const res = raw as {
      Type?: string;
      Properties?: { FunctionName?: string; Code?: { S3Key?: string } };
    };
    if (res.Type !== 'AWS::Lambda::Function') continue;
    const s3Key = res.Properties?.Code?.S3Key;
    if (!s3Key) continue; // skip alias/version Lambdas without inline code
    out.push({
      logicalId,
      functionName: res.Properties?.FunctionName,
      s3Key,
    });
  }
  return out;
}

function getStackLambdaPhysicalIds(stack: string): Map<string, string> {
  // Returns a Map<LogicalId, PhysicalResourceId> for every
  // AWS::Lambda::Function in the stack. Needed because the API stack
  // doesn't set `FunctionName` on its Lambdas — CDK auto-generates one
  // like `DRepPlatform-Api-dev-AuthChallengeFn320DEC1D-Wp8a3Lkasid`
  // and stamps it onto the live resource only. Without this lookup we'd
  // have no way to call `lambda get-function-configuration` for API
  // Lambdas.
  const result = new Map<string, string>();
  try {
    let token = '';
    do {
      const args = [
        'cloudformation',
        'list-stack-resources',
        '--stack-name',
        stack,
        '--output',
        'json',
      ];
      if (token) {
        args.push('--starting-token', token);
      }
      const raw = awsCmd(args);
      const parsed = JSON.parse(raw) as {
        StackResourceSummaries?: Array<{
          LogicalResourceId?: string;
          PhysicalResourceId?: string;
          ResourceType?: string;
        }>;
        NextToken?: string;
      };
      for (const r of parsed.StackResourceSummaries ?? []) {
        if (
          r.ResourceType === 'AWS::Lambda::Function' &&
          r.LogicalResourceId &&
          r.PhysicalResourceId
        ) {
          result.set(r.LogicalResourceId, r.PhysicalResourceId);
        }
      }
      token = parsed.NextToken ?? '';
    } while (token);
  } catch (err) {
    if (process.env.DRIFT_CHECK_DEBUG) {
      console.error(`  DEBUG: list-stack-resources failed for ${stack}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }
  }
  return result;
}

function getDeployedTemplate(stack: string): object | null {
  // `--template-stage Original` returns the template as it was synthesized
  // by CDK on the last deploy (including the actual `S3Key` values, NOT
  // the intrinsic-function refs that `--template-stage Processed` would
  // give us).
  try {
    const raw = awsCmd([
      'cloudformation',
      'get-template',
      '--stack-name',
      stack,
      '--template-stage',
      'Original',
      '--output',
      'json',
    ]);
    const parsed = JSON.parse(raw) as { TemplateBody?: object | string };
    // CFN can return TemplateBody as either an object (if JSON) or a YAML string.
    // CDK always emits JSON, so for our stacks it's an object.
    if (typeof parsed.TemplateBody === 'string') {
      // YAML — best-effort, but this shouldn't happen for our CDK stacks.
      return null;
    }
    return parsed.TemplateBody ?? null;
  } catch (err) {
    // Most common cause: stack doesn't exist (never deployed). Surface
    // but don't crash — let the caller decide.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  WARN: cloudformation get-template failed for ${stack}: ${msg.split('\n')[0]}`);
    return null;
  }
}

function getLambdaInfo(
  functionName: string,
): { codeSha256: string; lastModified: string } | null {
  try {
    const raw = awsCmd([
      'lambda',
      'get-function-configuration',
      '--function-name',
      functionName,
      '--query',
      // JMESPath list-projection: [scalar1, scalar2] returns a JSON array
      // with the two values. A bare `CodeSha256,LastModified` is a parse
      // error — `,` is not a valid JMESPath operator at the top level.
      '[CodeSha256,LastModified]',
      '--output',
      'json',
    ]);
    const parsed: unknown = JSON.parse(raw);
    // --query with two fields returns a list; with one field returns the scalar.
    if (Array.isArray(parsed) && parsed.length === 2) {
      const [codeSha256, lastModified] = parsed;
      if (typeof codeSha256 === 'string' && typeof lastModified === 'string') {
        return { codeSha256, lastModified };
      }
    }
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as { CodeSha256?: unknown; LastModified?: unknown };
      if (typeof obj.CodeSha256 === 'string' && typeof obj.LastModified === 'string') {
        return { codeSha256: obj.CodeSha256, lastModified: obj.LastModified };
      }
    }
    return null;
  } catch (err) {
    // Most common failure: Lambda doesn't exist yet (first-time deploy).
    // Stay quiet unless the user opts into debug logging — drift checks
    // shouldn't spam unrelated failures into a hot deploy path.
    if (process.env.DRIFT_CHECK_DEBUG) {
      console.error(`  DEBUG: lambda get-function-configuration for ${functionName}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }
    return null;
  }
}

function ageHoursOf(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 3_600_000;
}

function checkStack(stack: string, synthDir: string): LambdaCheck[] {
  console.error(`\n==== ${stack} ====`);

  // 1. Read the locally-synthesized template for this stack.
  const localTplPath = path.join(synthDir, `${stack}.template.json`);
  if (!fs.existsSync(localTplPath)) {
    console.error(`  ERROR: expected ${localTplPath} not found after synth`);
    return [];
  }
  const localTpl = JSON.parse(fs.readFileSync(localTplPath, 'utf8')) as object;
  const localLambdas = readTemplateLambdas(localTpl);
  if (localLambdas.length === 0) {
    console.error(`  (no Lambda functions in this stack — nothing to check)`);
    return [];
  }

  // 2. Pull the currently-deployed template (whatever CFN thinks shipped).
  const deployedTpl = getDeployedTemplate(stack);
  const deployedLambdas = deployedTpl
    ? new Map(readTemplateLambdas(deployedTpl).map((l) => [l.logicalId, l]))
    : new Map<string, ReturnType<typeof readTemplateLambdas>[number]>();

  // 2b. Resolve logicalId → live PhysicalResourceId for Lambdas that
  //     don't declare an explicit FunctionName (most of the API stack).
  const physicalIds = getStackLambdaPhysicalIds(stack);

  // 3. For each Lambda, compare local synth S3Key vs deployed S3Key,
  //    then pull AWS Lambda's actual CodeSha256 + LastModified for the
  //    "drift was masked, here's how stale it is" signal.
  const results: LambdaCheck[] = [];
  for (const lam of localLambdas) {
    const deployed = deployedLambdas.get(lam.logicalId);
    const fname =
      lam.functionName ?? deployed?.functionName ?? physicalIds.get(lam.logicalId);
    const info = fname ? getLambdaInfo(fname) : null;
    const localKey = lam.s3Key;
    const deployedKey = deployed?.s3Key ?? null;

    let match: LambdaCheck['match'];
    if (!deployedKey) match = 'undeployed';
    else if (deployedKey === localKey) match = 'match';
    else match = 'drift';

    results.push({
      logicalId: lam.logicalId,
      functionName: fname,
      localS3Key: localKey,
      deployedS3Key: deployedKey,
      codeSha256: info?.codeSha256 ?? null,
      lastModified: info?.lastModified ?? null,
      ageHours: ageHoursOf(info?.lastModified ?? null),
      match,
    });
  }
  return results;
}

function truncateMid(s: string | null, head = 8, tail = 4): string {
  if (!s) return '—';
  if (s.length <= head + tail + 3) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function fmtAge(h: number | null): string {
  if (h === null) return '—';
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

function printTable(rows: LambdaCheck[]): void {
  const cols = [
    { header: 'Function', get: (r: LambdaCheck) => r.functionName ?? r.logicalId },
    { header: 'Local Hash', get: (r: LambdaCheck) => truncateMid(r.localS3Key, 12, 4) },
    { header: 'Deployed Hash', get: (r: LambdaCheck) => truncateMid(r.deployedS3Key, 12, 4) },
    { header: 'CodeSha256', get: (r: LambdaCheck) => truncateMid(r.codeSha256, 8, 4) },
    { header: 'Age', get: (r: LambdaCheck) => fmtAge(r.ageHours) },
    {
      header: 'Match?',
      get: (r: LambdaCheck) =>
        r.match === 'match'
          ? '✓'
          : r.match === 'drift'
            ? '✗ DRIFT'
            : r.match === 'undeployed'
              ? '? new'
              : '?',
    },
  ];

  const widths = cols.map((c) => Math.max(c.header.length, ...rows.map((r) => c.get(r).length)));
  const sep = widths.map((w) => '-'.repeat(w)).join('-+-');
  const fmt = (vals: string[]): string =>
    vals.map((v, i) => v.padEnd(widths[i])).join(' | ');

  console.log(fmt(cols.map((c) => c.header)));
  console.log(sep);
  for (const r of rows) {
    console.log(fmt(cols.map((c) => c.get(r))));
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const stacks = args.length > 0 ? args : ALL_STACKS;

  console.error(`drift check: ${stacks.length} stack(s), profile=${AWS_PROFILE}, region=${AWS_REGION}`);

  // Single synth covers every stack — `infra/bin/app.ts` always
  // instantiates the whole app, so doing it per-stack would just
  // re-bundle every Lambda N times for no gain.
  const synthDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-check-'));
  let drift = 0;
  const allResults: { stack: string; rows: LambdaCheck[] }[] = [];
  try {
    cdkSynthAll(synthDir);
    for (const stack of stacks) {
      try {
        const rows = checkStack(stack, synthDir);
        allResults.push({ stack, rows });
        drift += rows.filter((r) => r.match === 'drift').length;
      } catch (err) {
        console.error(`ERROR scanning ${stack}: ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
      }
    }
  } finally {
    fs.rmSync(synthDir, { recursive: true, force: true });
  }

  console.log('');
  console.log('================================================================');
  console.log('  Lambda drift report');
  console.log('================================================================');
  for (const { stack, rows } of allResults) {
    if (rows.length === 0) continue;
    console.log(`\n[${stack}]`);
    printTable(rows);
  }

  console.log('');
  console.log('================================================================');
  if (drift > 0) {
    console.log(`  ✗ ${drift} Lambda(s) drift — local source has changed`);
    console.log(`    since the last successful deploy. Run scripts/deploy.sh.`);
    console.log('================================================================');
    process.exit(2);
  } else {
    console.log(`  ✓ no drift across ${stacks.length} stack(s).`);
    console.log('================================================================');
  }
}

main();
