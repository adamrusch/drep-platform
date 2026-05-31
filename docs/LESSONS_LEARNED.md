# Lessons Learned — drep.tools

A living checklist of mistakes made (and good practices that worked) while building, testing, and deploying this platform. **Consult this before claiming something is done/deployed, and when asked to "check based on lessons learned."** Append new lessons as they surface — date them.

The recurring meta-lesson: **verify state empirically; never infer it.** Most pain below came from asserting something was true (merged, deployed, recognized, populated) instead of checking.

---

## 🔴 The big one: verify merge & deploy state before claiming "done/live"

- **PRs being open ≠ merged.** Check explicitly: `gh pr view <n> --json state`. Don't infer merge state from ambiguous signals (system notes, "modified files", assumptions). *(2026-05-30: told the user the committee UI was "live"; PRs #31–#34 were actually still OPEN — main had none of the UI pages or routes.)*
- **A deploy only ships what's in the artifact.** Before/after deploying, confirm the feature's files actually exist on the branch you built from: `ls`/`[ -f ]` the key files, `grep` the route wiring in the app entrypoint, and grep the build output for the expected chunks (e.g. `ls dist/assets | grep -i committee`).
- **After merging a stack of PRs, verify the integrated result.** Check out the target branch, confirm all expected files exist, then typecheck + test + build. A clean per-PR build does NOT guarantee the merged main is whole.

## 🔴 Stacked PRs are fragile

- Long chains of stacked PRs (each based on the previous) are easy to merge out of order or partially, silently dropping files on the target. *(2026-05-30: steps 11–14 were a 4-deep stack; they never landed on main.)*
- If using a stack: merge strictly bottom-up, retarget each base to main as its parent lands, use **merge commits (not squash)** to preserve SHAs the stack depends on, and **verify files exist on main after the whole stack merges**.
- When a stack has diverged from main (because main moved underneath it), prefer pulling the verified files directly (`git checkout <branch> -- <paths>`) over fighting merge conflicts.

---

## Development

- **Know the canonical identity format before configuring anything keyed on it.** This app identifies users by **stake address** (`stake1…`), not payment address (`addr1…`) or DRep id (`drep1…`). Verify by inspecting what the app actually stores (`scan` the users table) before seeding admin lists, allowlists, etc. *(2026-05-30: seeded `ADMIN_BOOTSTRAP_WALLETS` with a payment address → never matched → no admin.)*
- **Trace every new role/permission end-to-end.** A role must be (1) enforced in the backend AND (2) surfaced to the UI that reacts to it. Here, `platform_admin` was checked at the handler layer but never put in the JWT, so the FE nav/RoleGuard couldn't see it. Path to verify: handler check → JWT claims (issued at login) → `/auth/me` response → frontend auth store → nav/RoleGuard.
- **`/auth/me` returns JWT roles, not fresh table roles.** A role/identity change written to the DB only surfaces after a wallet **re-login**. Design UX for that (prompt reconnect) or re-issue the session on the mutation.
- **Every user journey needs an entry point.** Don't build step N without step 0. Check that every backend endpoint users need has a frontend caller. *(2026-05-30: built committee-voting UI that assumed a committee exists, but there was no register UI — `POST /drep` had zero frontend callers.)* Quick check: `grep -rn "post.*'/your-endpoint'" frontend/src`.
- **Duplicated types/constants across workspaces drift.** `UserRole` (and the signed-message builders) are copied across backend/frontend/shared. When changing a shared union, update ALL copies; a golden/drift test (byte-identical assertion) catches it. *(2026-05-30: `platform_admin` went missing from the frontend `UserRole`.)*
- **Pure logic first, tested in isolation, before any I/O/infra.** The vote resolver was a no-I/O module with an exhaustive test matrix written before handlers — caught all the threshold/quorum/abstain edge cases cheaply. Keep doing this.

## Testing

- **"It ran (200)" ≠ "it worked."** Inspect the result payload + logs, not just the status code. *(2026-05-30: the directory sync returned 200 but its auto-post backfill silently errored 367/367 — visible only in the result counts + CloudWatch logs.)*
- **Validate against the live deployed stack, not just unit tests.** The strongest check here: seed synthetic rows directly in the deployed DB → hit the live API → assert the handler+resolver+GSI produce the right result → clean up. This exercises IAM, marshalling, indexes, and the real Lambda — things unit tests can't.
- **Check auth gating explicitly:** public reads → 200; mutations without a signature → 401; unknown resources → 404; a route that should exist but returns **404 means it isn't wired** (vs 401 = wired but auth-gated). This distinction is a fast "is the route deployed?" probe.
- **Look before asserting when debugging.** Inspect the actual deployed state (files on the branch, routes in the app entry, the served bundle, the Lambda env) before theorizing about causes. Reasoning from assumptions wasted cycles; one `grep` of `App.tsx` found the dropped routes immediately.
- **Production build catches what `tsc` misses.** For the frontend, run the real `vite build` (resolves imports/chunks) — typecheck-clean can still fail to build or be missing referenced files.

## Deployment

- **Scheduled jobs haven't run on a fresh stack.** EventBridge `rate()` rules don't fire until the first interval elapses, so a freshly deployed environment has **empty sync tables** (no DReps for up to 30 min, etc.). Warm them after deploy. *(Fixed with `scripts/warm-syncs.sh`, auto-invoked by `deploy.sh` when the Scheduler stack deploys.)*
- **Minimal IAM roles must grant every table each code path touches.** A deliberately-scoped role fails *closed* (AccessDenied) on an un-granted table, often in a non-fatal branch you won't notice without reading logs. *(2026-05-30: the directory-sync role's auto-post path lacked `governance_actions`/`clubhouse_posts` grants.)* After deploy, grep the Lambda's logs for `AccessDenied`.
- **Externalized config that the deploy script doesn't forward.** `scripts/deploy.sh` only forwards `--context stage=`; anything else (e.g. `--context adminBootstrapWallets=`) must go through a direct `cdk deploy`. Know what your wrapper does and doesn't pass.
- **Secrets go in Secrets Manager, never the repo.** Put provided API keys directly into `drep-platform/{stage}/…`; don't echo them back or commit them. If a secret arrived over an untrusted channel (chat), recommend rotating it after setup.
- **ACM certs for CloudFront must be in `us-east-1`** regardless of the app's region, and cover every subdomain (apex + www + api). DNS-validate via the existing hosted zone; ACM usually issues within minutes once the CNAMEs are in place.
- **Frontend env is baked at build time.** `VITE_*` vars (`VITE_API_BASE_URL`, `VITE_STAGE`) are compiled in, so the FE bundle is **not** promotable byte-for-byte across stages — rebuild per stage. Backend Lambda zips (content-hashed) are reused.

## Multi-environment (esp. a mainnet "test" env)

- **A test env on the real network can do real, irreversible things.** Gate dangerous actions (on-chain broadcast, real submissions) to `stage === 'prod'` at the infra level, and embed the stage in signed messages so a test-stage signature can't verify/act on prod.
- **Isolate sessions per stage on a shared parent domain.** Scope the cookie domain (`.test.drep.tools`, not `.drep.tools`) and the CSP `connect-src` per stage so a test session/request can't cross into prod.
- **RETAIN stateful resources on any env you don't want to lose** (prod *and* test), not just prod. Centralize the `isProd`/`isPersistent` predicate so a new stage can't accidentally inherit DESTROY.
- **Fail fast on an unknown stage.** A typo'd `--context stage=prdo` should throw, not silently provision throwaway-policy resources.

---

## Pre-flight checklist (run before saying "done" or "deployed")

1. Are the PRs that contain this feature actually **merged**? (`gh pr view`)
2. Do the feature's **files exist on the branch/commit being deployed**? (routes wired in the app entry, handlers in infra)
3. Does **typecheck + test + production build** pass on the *integrated* branch (not just per-PR)?
4. For a deploy: did the **build output contain the feature** (expected chunks/handlers)? After deploy, do the new **routes respond** (200/401, not 404) and do the **Lambda logs show no AccessDenied**?
5. For a new env: **secrets created**, **cert issued & wired**, **identity-keyed config in the right address format**, **syncs warmed**, **dangerous actions gated to prod**, **sessions isolated per stage**?
6. For any new role/permission: enforced in backend **and** surfaced to the FE (JWT → /auth/me → nav)?
7. Did I **verify empirically**, or am I **inferring**? If inferring, go check.

---
*Created 2026-05-30. Append new lessons with a date when they surface.*

## Append 2026-05-31 — auth / cookies

- **Parent-domain cookies shadow stage cookies (403 "signature verification failed").** A session cookie scoped to `.drep.tools` (set by a dev/prod login) is ALSO sent to `api.test.drep.tools`, where it fails JWT verification against the *test* secret. Per-stage cookie *domains* (`.test.drep.tools`) are not enough — the broader parent cookie still collides. **Fix: use a per-stage cookie NAME** (e.g. `access_token_test` vs `access_token`) so each stage's authorizer only reads its own cookie. Until then: test in an incognito window or clear `drep.tools` cookies.
- **Debugging auth 403s:** check the **authorizer** Lambda logs, not just the handler — a 403 on an authenticated route usually means the authorizer rejected the request *before* the handler ran (so the handler log group may be empty or not exist). "signature verification failed" == token signed with a different secret than the verifier uses (stale/foreign cookie, or a real signer/verifier secret mismatch).
- **Cached client state masks auth failure.** The Zustand auth store persists to sessionStorage, so the UI (nav, role-gated chrome) can look authenticated from cached roles even while every live API call 403s. Don't infer "logged in & authorized" from the UI; check a live authenticated call.
