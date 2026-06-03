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

## Append 2026-05-31 — identity / impersonation

- **"Proves it exists" ≠ "proves you control it."** The DRep-link + committee-register handlers accepted a pasted `drep1…` id and only checked it was *registered on-chain* (present in the synced directory). That lets ANY wallet claim ANY DRep's identity — the impersonator then shows that DRep's name + "Registered DRep" badge on their profile and clubhouse posts, and could bind a committee to someone else's DRep. The only path that proves control is **CIP-95 `getPubDRepKey` → derive the drep id server-side**; a wallet only returns a key it controls. *(Fix: `lib/stage.ts#pasteDrepLinkAllowed()` — paste allowed on dev/test as a convenience since those never broadcast on-chain; production requires CIP-95. Gated in `drep/linkDrep.ts` AND `drep/register.ts`, and the paste input is hidden in the prod frontend.)*
- **When you leave an insecure shortcut in for testing, gate it by stage in the code, not by discipline.** A comment saying "does not prove control — prefer drepKey" is not enforcement. Tie the shortcut to `STAGE !== 'prod'` so it physically cannot ship to production.
- **Identity claims need a uniqueness/ownership story.** Linking just writes `users.drepId` on the caller's own row with no check that another wallet hasn't already claimed the same DRep. CIP-95 makes collisions impossible in practice (only the real controller can link), but if the paste path ever returns, add a uniqueness guard (conditional write / reverse index) so two wallets can't both claim one DRep.

## Append 2026-05-31 — design review (oracle + sisyphus) fixes

- **A mutated DB field that lives in the JWT is stale until re-auth — surface the live value where it matters.** `/auth/me` returned `drepId` from the JWT claim, but `/drep/link` (and the CIP-95 auto-link) write `users.drepId` *without re-issuing the JWT*. Result: the auto-link silently "didn't work" — the session kept serving the old value, and the FE re-fired the link every page load. Fix was free: `/auth/me` already fetches the user row, so prefer `user.drepId ?? authCtx.registeredDrepId`. **General rule:** when a write changes something the JWT also carries, either re-issue the session OR have the read-path prefer the live row. (Roles are the opposite call — keep `/auth/me` roles sourced from the JWT, because the authorizer enforces the JWT; showing live roles the API won't honor just creates "UI says admin, API says 403".)
- **Content that anchors to chain must be frozen once submitted.** `finalizeRationale` wrote `RATIONALE#FINAL` with an unconditional Put, and `submitReceipt` snapshotted only the `anchorHash`, not the bytes. A re-finalize after submission would leave the displayed rationale hashing to something *other* than the on-chain anchor — the worst credibility failure for a governance tool. Fix: (1) finalize is now a `transactWrite` with a `ConditionCheck` that `SUBMISSION` doesn't exist (re-finalize allowed before submit to fix typos, frozen after); (2) `submitReceipt` snapshots `canonicalJson` onto the immutable SUBMISSION row, so it self-verifies against its own `anchorHash` regardless of the FINAL row.
- **DynamoDB list-as-roster needs optimistic concurrency.** `removeMember` did a read-modify-write of the `members` list conditioned only on `attribute_exists`. A concurrent `addMember` could be clobbered, stranding a member (membership slot taken, roster doesn't list them → denied access). Fix: condition the roster write on `updatedAt = :expected` (the value just read); 409 on mismatch. Any read-modify-write of a list attribute wants this. (`editRationale` already had the pattern — mirror it.)
- **Don't let `assertStage` accept a stage that has no real config.** `STAGES` listed `staging`, but `customDomainFor` had no `staging` branch — it fell through to the prod `drep.tools` block, so `--context stage=staging` would have fought prod's Route53/cookies. Removed `staging` (unused); made `customDomainFor` return `undefined` for `dev` (deploys on raw CloudFront/API URLs, can't shadow prod) and only `test`/`prod` get real domains. **Rule:** a recognized stage must have an end-to-end config, or the validator should reject it — a half-wired stage name is a footgun that silently targets prod.
- **A design/security review pays for itself.** The oracle + sisyphus pass found the stale-JWT bug (which explained a real symptom the user hit), the anchor-drift integrity hole, and the roster race — none of which the 502-test suite caught, because they're cross-handler/temporal properties, not single-function logic. Schedule one before any prod cutover.

## Append 2026-05-31 — Oracle security audit (secrets clean; auth flaws found)

- **Deriving an id from a public key proves NOTHING about control.** `/drep/link`'s "CIP-95 `drepKey`" path hashed a supplied DRep *public* key into a drep id and set `users.drepId` — and a code comment claimed it "proves the caller controls the DRep." It does not: a DRep public key is public on-chain data, so anyone could submit a victim's pubkey and impersonate their DRep (and then bind a committee to it). Proof-of-control requires verifying a SIGNATURE made with the private key over a fresh nonce. Interim fix: gate the `drepKey` path to non-prod (like the paste path) until real CIP-95 signed proof-of-control is built; never let an "identity link" go live in prod on derivation alone. **Lesson: "prove you control X" always means "produce a signature only the holder of X could make," never "show me X's public identifier."**
- **Never rest-spread a DB row into a public response.** `profile/get` (unauthenticated, edge-cached) did `const {sessionTokenHash, sessionExpiry, ...rest} = user; return rest` — which also shipped `roles` (advertising platform_admins), `tokenVersion`, and the full `delegationHistory`. A row with an index signature + a deny-list strip leaks every *future* field by default. Use an explicit allow-list projection at every public boundary; deny-lists rot.
- **"Snapshot the rule" must snapshot the *eligible set*, not just the threshold.** The X-of-N proposal froze X and N but checked voter eligibility against the LIVE roster — so a chair could add sympathetic members mid-proposal and manufacture the approval. Freeze WHO may act, not just how many, when an action's outcome depends on a mutable set.
- **Role checks honor the *global* JWT role, not the resource.** `/governance/sync` was gated on `lead_drep` — held by every wallet that ever made a committee — letting any of them trigger expensive Koios/IPFS/GitHub fan-out. For a cost-amplifying or privileged action, gate on `platform_admin` (or a per-resource scope), not a role anyone can self-grant by using the product.
- **Secrets audit came back clean — and here's what "clean" looked like:** no secret ever committed (git history checked), the public frontend bundle inlines only `VITE_API_*`/`VITE_STAGE` (never a server secret), JWT/Blockfrost/IPFS keys live only in Secrets Manager (fetched by name, cached in module memory, never returned or logged), the IPFS key endpoint returns `{stored:boolean}` not the key, cookies are HttpOnly+Secure+SameSite, and no `console.log` prints a secret VALUE (only identifiers). Keep it that way: the failure mode is always a *new* field/endpoint added without the allow-list.

## Append 2026-05-31 — post-review hardening (the lower-priority items, done)

- **"Defense in depth" that nothing checks is theater.** logout nulled `sessionTokenHash`, and the authorizer's docstring bragged about "immediate revocation on logout" — but the authorizer was pure-JWT and never read that field, so a leaked cookie stayed valid until its 7–30 day `exp`. Real fix: a monotonic `tokenVersion` on the user row, embedded in the JWT, checked by the authorizer (one GetItem/req); logout does an atomic `ADD tokenVersion :1` = "log out everywhere". If you claim a security property in a comment, point at the line that enforces it.
- **A stateless hot path can take a scoped read when the wiring's already there.** The authorizer is deliberately 128MB/pure-JWT, but it already had `lambdaRole` (table read) + the table-prefix env via `commonLambdaProps` — so adding the revocation read needed ZERO infra change. Check what permissions/env a Lambda already inherits before assuming a new dependency means new wiring.
- **Fail-open vs fail-closed is a deliberate per-check decision.** The authorizer's revocation read fails OPEN on a DynamoDB error (token is already crypto-valid; prefer availability over enforcing revocation during an outage) but fails CLOSED on a real version mismatch. Write the choice — and the reason — into the code, not into your head.
- **A revocation counter must be carried forward by every re-issue path, or login/refresh silently un-revokes.** Both `/auth/verify` (full-row putItem — would reset `tokenVersion` to 0) and `/auth/refresh` (re-signs from authCtx) had to thread the current version through. refresh reuses the value the authorizer already validated (forwarded in the authorizer context) so it needs no second read. Known minor race: a *same-wallet* concurrent login+logout can let login's full-row putItem overwrite the just-incremented version — pathological, documented, not worth a conditional write here.
- **Stage-bind every signed message, not just some.** The committee messages embedded `(stage=...)`; the auth *challenge* didn't, relying solely on per-stage nonce tables. Added it to `buildSignMessage` — safe because the frontend signs the server-provided message verbatim (it never reconstructs it). Confirm that "signs verbatim" assumption in the client before changing a signed-message format.
- **New signed-message types are additive — don't bump the format version.** Adding `submit-receipt` / `ipfs-key` builders to the 3 byte-identical `committeeMessages.ts` copies doesn't change existing messages, so existing signatures still verify; bumping `COMMITTEE_MSG_FORMAT` would needlessly invalidate in-flight signing. Bump the version only when an *existing* message's layout changes. The drift test (3 copies byte-identical) is the guardrail — keep all three edits identical.

## Append 2026-05-31 — a "freshness gate" that never expires = permanent bad data

- **Symptom → root cause beats symptom → patch.** GAs showed "(No off-chain metadata)" though the anchor was on-chain. The tempting read is "metadata fetch is flaky." The real bug: a *freshness gate*. `isEnrichmentFresh` skipped re-enrichment for 24h keyed on `lastSyncedAt` — but the warm path bumps `lastSyncedAt` on every vote change, and active proposals get vote churn constantly, so the window **never elapsed**. A row whose first cold pass missed the anchor (Koios down / transient null `meta_url`) was frozen in that state forever. A code comment even *claimed* `lastSyncedAt` "is no longer load-bearing" for the freshness check — it was. Verify the gate's actual inputs, don't trust the comment.
- **Self-healing > one-shot backfill.** Two fixes: (1) bump `ENRICHMENT_VERSION` to force a one-time re-enrich of all rows (backfilled 24→0), and (2) make the gate *keep retrying* anchorless ACTIVE rows on a short cadence so future transient failures self-heal instead of locking in. Without (2), the next Koios blip recreates the bug and only a human-noticed version bump fixes it.
- **A TTL throttle whose timestamp is updated by an unrelated write path is a no-op throttle.** If you gate "re-do expensive work every N hours" on a timestamp, make sure *only* the expensive work updates that timestamp — or gate on a dedicated field. Otherwise a chatty sibling write keeps the window perpetually open (or, inverted, perpetually closed).
- **Ground a data-bug investigation in the live table + the upstream source.** Scanning `governance_actions` (24 rows `metadataSource=none`, freshly synced at the current version) plus hitting Koios `/proposal_list` directly (every one had `meta_url`+`meta_hash`) proved "the metadata exists, the sync dropped it" before a single line was read. Confirm with data, then read code to find the mechanism.
- **Beware 18-char-truncated ids in ad-hoc scans.** A first scan truncating `actionId` to 18 chars made distinct GAs look like duplicate rows and sent the analysis down a "duplicate-row" path; a full-id grouping showed 120 distinct, 0 dups. Print full keys when reasoning about uniqueness.
