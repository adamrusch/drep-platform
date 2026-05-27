# scripts/

Repo-level operations scripts. Per-workspace scripts (DDB backfills,
data migrations, etc.) live in the workspace they belong to —
`backend/scripts/` for the API + sync code, etc.

## `deploy.sh`

The **only** way production deploys should ever be run. Wraps
`cdk deploy` with two protections that the bare CLI does not provide:

1. **Outer lock** — `flock` if available, falling back to an atomic
   `mkdir`-based lock. Two concurrent invocations of `deploy.sh` cannot
   both proceed; the second one aborts cleanly with a clear error.
2. **Per-stack `--output cdk.out.<slug>`** — each stack writes to its
   own synth output directory, so even if two `cdk deploy` invocations
   somehow run against the same stack name simultaneously (e.g. inside
   a CI matrix), they don't share `cdk.out/` and cannot trigger the
   "Another CLI is currently synthing" race.

After each successful stack deploy, the wrapper invokes
`check-deploy-drift.ts` for that stack and prints the result. Drift
is reported loudly but does NOT trigger a rollback.

### Why this exists

On 2026-05-26 during the deploy of PR #2, I (Claude) ran
`cdk deploy DRepPlatform-Api-dev` and
`cdk deploy DRepPlatform-Scheduler-dev` in parallel against the
shared default `cdk.out/`. The SchedulerStack process printed
"Another CLI is currently synthing to cdk.out. Invoke the CLI in
sequence" — and **exited with code 0**. The Lambda code was never
actually updated. The clean exit code masked the failure for 10
minutes until a spot check of `aws lambda get-function-configuration`
revealed `LastModified` was 9 days stale.

### Usage

```sh
# Standard deploy (sequential, locked, drift-checked):
./scripts/deploy.sh DRepPlatform-Api-dev DRepPlatform-Scheduler-dev

# Single-stack deploy:
./scripts/deploy.sh DRepPlatform-Database-dev

# Full re-deploy:
./scripts/deploy.sh \
    DRepPlatform-Database-dev \
    DRepPlatform-Api-dev \
    DRepPlatform-Frontend-dev \
    DRepPlatform-Scheduler-dev
```

### Flags

| Flag           | Effect                                                  |
| -------------- | ------------------------------------------------------- |
| `--dry-run`    | Print what would be deployed without executing.         |
| `--no-drift`   | Skip the post-deploy drift check.                       |
| `--stage NAME` | Override the CDK stage context (default: `dev`).        |
| `-h`/`--help`  | Print full help.                                        |

### Exit codes

| Code | Meaning                                                  |
| ---- | -------------------------------------------------------- |
| 0    | All requested stacks deployed cleanly.                   |
| 1    | Argument / usage error.                                  |
| 2    | Lock acquisition failed (another deploy already running).|
| 3    | `cdk deploy` failed for at least one stack.              |
| 4    | Post-deploy drift check failed for at least one stack.   |

### NEVER run raw `cdk deploy` for production

Use this wrapper. The wrapper is what prevents the `cdk.out` race
that bit us on 2026-05-26.

If you genuinely need a raw `cdk deploy` (e.g. for a one-off `--hotswap`
during local iteration), make sure no other deploy is in flight and
pass `--output cdk.out.<unique-suffix>` so you don't conflict with the
wrapper-managed default `cdk.out/`.

---

## `check-deploy-drift.ts`

Run with: `npx tsx scripts/check-deploy-drift.ts [STACK_NAME...]`

Lambda code-drift detector. Answers the question: "does the deployed
Lambda code match what the current source tree would produce?"

### Strategy

The script uses CDK as its own oracle (PERMISSIVE comparison —
asset-hash, not raw `CodeSha256`):

1. Runs `cdk synth --all` into a temp dir to produce the asset
   directories and CFN template that CDK *would* deploy from the
   current source tree.
2. Reads each Lambda's `Code.S3Key` from the synth output — that key
   prefix IS the CDK asset hash, which is what CDK uses to decide
   whether a Lambda needs an upload.
3. Reads each Lambda's CURRENTLY-DEPLOYED `Code.S3Key` from the
   CloudFormation stack's template via `aws cloudformation
   get-template`. This is what CFN thinks it deployed last.
4. Compares. Mismatch == drift.

Plus surfaces `CodeSha256` and `LastModified` (with human-readable
age) from `aws lambda get-function-configuration` so you can see how
stale the deployed code is — this is the "9-day-stale" signal that
caught the 2026-05-26 race.

### Why permissive (not strict)

AWS Lambda's `CodeSha256` is `base64(SHA-256(deployed-zip-bytes))`.
Reproducing it from local sources would require byte-for-byte
replication of CDK's bundling + archiver zip semantics (esbuild
flags, mtime normalization, central-directory ordering). That's
fragile — a single dependency bump in `cdk-assets` could silently
invalidate every drift check.

Asset-hash comparison is functionally equivalent for our use case
(catching the cdk.out race) and stable across CDK versions.

### Environment

| Env var               | Purpose                                                     |
| --------------------- | ----------------------------------------------------------- |
| `AWS_PROFILE`         | AWS profile (default: `drep-platform`).                     |
| `AWS_REGION`          | AWS region (default: `us-east-1`).                          |
| `DRIFT_CHECK_DEBUG`   | When set to anything, print AWS CLI error details.          |

### Exit codes

| Code | Meaning                                            |
| ---- | -------------------------------------------------- |
| 0    | No drift detected.                                 |
| 1    | Argument / runtime error.                          |
| 2    | Drift detected on at least one Lambda.             |

---

## CI / branch protection (one-time GitHub UI setup)

`.github/workflows/ci.yml` runs three parallel jobs (`backend`,
`frontend`, `infra`) on every PR + push to `main`. To make CI
load-bearing, enable branch protection — **this is a GitHub UI
toggle and cannot be configured from code**:

1. Repo Settings → Branches → **Add branch protection rule**
2. Branch name pattern: `main`
3. Enable **"Require status checks to pass before merging"**
4. Search and add as required checks (after the first PR runs CI
   so GitHub knows the check names):
   - `ci / backend`
   - `ci / frontend`
   - `ci / infra`
5. Recommended: also enable **"Require branches to be up to date
   before merging"** so a PR is rebased on `main` before it merges.

The `cdk synth` step inside the `infra` job is the most important
guard the CI adds — it catches CFN-invalid changes and broken Lambda
imports before they hit the cdk.out race window.
