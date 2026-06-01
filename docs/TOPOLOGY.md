# Deployment topology & the prod-migration runbook

_Last updated 2026-05-31._

## Current reality (read this first)

| Environment | Domain | Served by CloudFormation stage | Notes |
|---|---|---|---|
| **Production** | `drep.tools`, `www.drep.tools`, `api.drep.tools` | **`dev`** stacks (`DRepPlatform-*-dev`) | Historical artifact — the old `customDomainFor` handed `drep.tools` to any non-`test` stage, so prod runs as `dev`. Frozen at "Phase 1" pending the migration below. |
| **Test** | `test.drep.tools`, `api.test.drep.tools` | `test` stacks (`DRepPlatform-*-test`) | Mainnet test env. Tracks `main` (currently includes Phase 2 + all fixes). |
| **Dev** | _none_ | n/a | There is no separate dev environment right now — `dev` IS production. |

**There are no `*-prod` stacks yet.** "Promoting to prod" today means the migration runbook below.

### Why this is guarded
Because production is the `dev` stage:
- A `cdk deploy` of the `dev` stacks **changes the live site**, and since `customDomainFor('dev')` now returns no domain, it would **detach `drep.tools`**.
- `scripts/deploy.sh` therefore **hard-blocks** deploying `dev`/`prod` without `--touch-production`, and `infra/bin/app.ts` prints a banner for direct `cdk deploy`.
- All production DynamoDB tables have **deletion protection enabled** (2026-05-31), so a stack replace/`destroy` can't wipe the data even though the CFN removal policy is still `Delete`.

**Do not deploy the `dev` stacks** until the migration. If you must (e.g. a hotfix to current prod), use `--touch-production` and understand you're changing the live site.

## The data (why migration is low-risk)
Almost everything in the prod tables is **regenerable** by the sync Lambdas:
- `drep_directory` (~102k), `governance_actions` (~120), `pool_metadata`, `clubhouse_posts` auto-posts — all rebuilt from chain on the normal sync cadence (+ `scripts/warm-syncs.sh`).
- Genuinely irreplaceable state is tiny: a handful of **user profiles**, **comments**, and human-authored **clubhouse posts**.

## Migration runbook — do this when promoting Phase 2 to prod

Goal end-state: `drep.tools` served by real `DRepPlatform-*-prod` stacks (RETAIN policies, own secrets), `dev` becomes a true throwaway dev env. One planned cutover window (~10–15 min). Deploy `main`.

**Pre-reqs (no production impact):**
1. Create secrets: `drep-platform/prod/jwt-secret` (new random 32+ bytes) and `drep-platform/prod/blockfrost-api-key` (copy the value from `drep-platform/dev/blockfrost-api-key`).
2. Confirm the prod ACM cert is still ISSUED and covers `drep.tools` + `www` + `*.drep.tools` (it does: `…/certificate/9b367d8e-…`, reused by the current distributions).

**Stand up prod (no domain conflict yet):**
3. `bash scripts/deploy.sh --stage prod --touch-production DRepPlatform-Database-prod DRepPlatform-Scheduler-prod` — new tables (RETAIN), syncs begin repopulating the regenerable data. Run `scripts/warm-syncs.sh` (prod) to prime them.
4. Build the frontend for prod (`VITE_API_BASE_URL=https://api.drep.tools VITE_STAGE=prod`) and deploy `DRepPlatform-Api-prod` + `DRepPlatform-Frontend-prod`. **They will fail to claim `drep.tools`/`api.drep.tools` while the `dev` stacks still hold those aliases — that's expected.** To verify the prod stage first, temporarily deploy Api/Frontend-prod with the domain suppressed (e.g. add a `--context noCustomDomain=1` path in `app.ts`) and smoke-test on the `*.cloudfront.net` URLs.

**Migrate the small real data:**
5. Copy `users`, `comments`, and human-authored `clubhouse_posts`/`clubhouse_comments` from `drep-platform-dev-*` → `drep-platform-prod-*` (scan + batch-write). Everything else regenerates.

**Cutover (the only downtime — ~10–15 min):**
6. Release the aliases from `dev`: `bash scripts/deploy.sh --stage dev --touch-production DRepPlatform-Api-dev DRepPlatform-Frontend-dev` — with the current code (`dev` → no custom domain) this removes the `drep.tools`/`api.drep.tools` aliases + Route53 records from the dev distributions.
7. Immediately deploy `DRepPlatform-Api-prod` + `DRepPlatform-Frontend-prod` **with** the domain so they claim the now-free aliases + recreate Route53.
8. Verify `https://drep.tools` and `https://api.drep.tools/epoch`. New `prod` JWT secret means everyone re-logs-in (fine).

**After:**
9. `dev` is now domain-less — a real throwaway dev environment. Leave it or scale it down.
10. Update this file + the topology table.

### Zero-downtime alternative
If downtime is unacceptable, replace steps 6–7 with `aws cloudfront associate-alias` (atomically moves each alias `dev`→`prod` distribution), then repoint Route53, then reconcile CDK ownership. More fiddly; not worth it for the current tiny userbase.
