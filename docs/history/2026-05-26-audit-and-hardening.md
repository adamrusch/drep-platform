# Session history — feature fixes, fresh-eyes audit, P0 hardening, Sybil resistance

_Worked 2026-05-26 → 2026-05-30. Branches merged to `main`: PR #1–#19. This is
the **earliest** recorded working session — it predates the
[2026-06-05 committee/rationale/prod-migration session](./2026-06-05-committee-fixes-rationale-cache-prod-migration.md).
All of this work shipped to the **`dev`** stacks (which served `drep.tools` at the
time) and is now live in `prod` via the later dev→prod migration._

This is a historical record of one working session. For living docs see
`ARCHITECTURE.md`, `SCHEMA.md`, `TOPOLOGY.md`, `RUNBOOK.md`, `DECISIONS.md`, and
`LESSONS_LEARNED.md`.

**Important caveat (corrected later):** throughout this session the operating
assumption was "**`dev` IS prod**" — at the time only `*-dev` stacks existed and
`drep.tools` resolved to them. That was true then and went **stale** when the
dev→prod migration shipped (see `TOPOLOGY.md` + the 2026-06-05 record). Deploys in
this session targeted `*-dev`.

Test suite over the session: backend **87 → 460**, frontend **0 → 13** (new vitest
+ RTL setup landed in PR #8).

---

## 1. The reported bugs (PRs #1, #2, #10, #11)

Starting complaints from the operator, fixed first:

- **Wallet's chosen DRep not recognized / directory missing DReps** (#1, #2). Two
  root causes. (a) `/auth/me` returned the user's *registered*-DRep id as if it
  were the DRep they *delegate to* — added `delegatedToDrepId` via a live
  Koios/Blockfrost lookup. (b) The directory list `Scan` had no `SK='PROFILE'`
  filter and was exhausted by `POWER#` history rows, so it returned ~800 of 1623
  DReps. Fixed with a sparse `entityType-votingPower-index` GSI (Query, not Scan)
  + a backfill. Active DReps went **33 → ~369**.
- **Predefined DReps missing** (#2). `drep_always_abstain` / `_no_confidence` (the
  highest-"power" entries on chain) were filtered out by the sync. Injected them
  as synthesized `PROFILE` rows with hardcoded names + an `isPredefined` flag.
- **Dashboard "Not Delegated" while the clubhouse showed the DRep** (#10). Dashboard
  read stale `delegationHistory`; switched to the live `delegatedToDrepId`.
  Collapsed the redundant delegation tiles into one **"Your DRep"** link, and
  renamed the **"Committee" nav → "DRep Committees"** (it's the platform's own
  coordination committees, not the chain Constitutional Committee).
- **Couldn't post comments/polls/questions** (#11). The Composer was shown to
  delegators, but `createPost` was JWT-role-only on the backend → 403. Unified the
  clubhouse gate so delegators-of-this-DRep (or role-holders) may post; surfaced
  delegation duration on the public DRep profile.

## 2. Features requested mid-session (PRs #1, #5, #6, #7, #9)

- **Votes tab** on each governance action (#1, #6) — per-DRep vote rows with
  newest-first + strikethrough on superseded votes, three role sections
  (DRep/SPO/CC). Reordered the action tabs to Overview → Rationale → Public
  Comments → Votes → Clubhouse. Later added **historical voting power** (join the
  vote's epoch to the `POWER#{epoch}` snapshot) + **SPO/CC name resolution** (new
  `pool_metadata` + `cc_members` cache tables).
- **Stake-weighted comment voting + threaded replies** (#1) — up/down votes carry
  the voter's wallet stake (snapshot at vote time) into a `supportLovelace` sum;
  author seeded with their own upvote; one level of nested replies, collapsed by
  default.
- **Auto-generated GA posts in every active DRep's clubhouse** (#5) — on each new
  governance action, fan out a pinned `auto_ga` post (title `GA: …`, the abstract,
  a link) to every active DRep; 2-level replies; unpinned (not deleted) when the GA
  completes. New `linkedActionId-index` GSI for the completion sweep.
- **DRep identity header** on the clubhouse (#9) — name, picture, CIP-119
  description; "Predefined" treatment for the abstain/no-confidence entries.
- **Clubhouse rail** (#7) replaced `Soon` placeholders with real "active threads" /
  "top contributors" data.

## 3. Infrastructure + latent fixes (PRs #3, #4, #8)

- **Deploy safety net** (#3) after a real near-miss: running two `cdk deploy`s in
  parallel raced on the shared `cdk.out` dir, one exited 0 **without deploying**,
  and the stale Lambda went unnoticed for ~10 min. Shipped `scripts/deploy.sh`
  (per-stack `--output`, lock), `scripts/check-deploy-drift.ts` (local-bundle vs
  deployed `CodeSha256`), GitHub Actions CI, and **PITR on every table**.
- **Latent backend bugs** (#4): JWT `drepId` → `registeredDrepId` (it was the
  registered id, not the delegated one — long a source of confusion); a
  `MAX_DELEGATORS_WALK` cap; **sparse TTL** on `POWER#` rows (365d) so the
  voting-power history self-prunes.
- **Observability** (#8): plumbed comment author-seed backfill, recognition cache
  invalidation on login/logout, **CloudWatch alarms** on every sync Lambda (→ SNS
  to the operator — first deploy requires clicking the confirmation email), and the
  first frontend vitest/RTL canary tests.

## 4. The fresh-eyes audit (Opus 4.8 + Sisyphus + Oracle)

A read-only audit ran two parallel passes — a code-level sweep and an architectural
review. It confirmed **four P0s**, all fixed:

- **Auth bypass / account takeover** (#12). `verifyWalletSignature` verified the
  signature against *the public key in the request* but never bound that key to the
  claimed wallet address. An attacker could sign the (victim-addressed) challenge
  with their own key and get a session as the victim. Fixed by deriving the address
  credential from the COSE_Key pubkey (blake2b-224 per CIP-19) + a CIP-8
  protected-header address cross-check. New `cardanoAddress.ts` helper.
- **Comment voting 100% broken** (#12). `supportLovelace` delta was passed to a DDB
  `ADD` as a JS string → the doc client marshals it as `S`, which `ADD` rejects →
  500 on every vote. Unnoticed because the table was empty and tests mocked
  `transactWrite`. Fixed to marshal as a Number (bigint) end-to-end.
- **Global `lead_drep` delete gate** (#12). `requireOwnerOrRole(…, 'lead_drep')`
  honored the role *anywhere*, so any committee lead could delete any comment or
  clubhouse post. Scoped to the committee being acted on.
- **Clubhouse comments inline-array race + 400KB cliff** (#13). Comments lived in a
  `comments[]` array on the post (read-modify-write → lost comments under
  concurrency; ~80 comments would hit DynamoDB's item-size cap and permanently
  write-lock the post). De-inlined into a `clubhouse_comments` table via the
  Oracle-designed dual-write → backfill → read-cutover migration. Prod had **zero**
  comments, so the migration was zero-risk.

The architectural review's strategic follow-ups were also shipped:

- **Perf/cost** (#14): lazy-loaded routes (main chunk **786KB → 205KB**),
  authorizer Lambda 512→128MB, `governance/stats` Scan→Query, dropped a duplicate
  GSI.
- **Data quality** (#15, #16): predefined-DRep delegator count via Koios
  `Prefer: count=exact` — fixed a **~1,000 → ~181,000** undercount (the old 100-page
  walk timed out; a single exact-count request, with the timeout bumped 8s→30s for
  abstain's ~25s `COUNT(*)`, is correct). Also `myVotes` N+1 → BatchGet, and a
  **Koios tip-lag staleness check**.
- **Security posture** (#17): flipped the soft-fail-**open** clubhouse gate to
  **fail-closed** (503 on dual-upstream outage for non-role-holders); fixed the
  poll-vote RMW race with an atomic `UpdateExpression`; guarded GA fan-out against
  already-completed actions.
- **Audit trail** (#18): the provisioned-but-unused `audit_log` table is now written
  on every mutation (best-effort — never blocks the write), and the comment
  de-inline migration was finished (stop inline writes, `deletePost` cascade,
  cleanup script).

## 5. Sybil resistance — comment-vote re-validation (PR #19)

The stake-weighted "support level" is gameable by **move-and-revote**: vote from
wallet A (1M ₳ snapshot), move the ADA to B, vote from B → 2M ₳ of support from 1M
of real stake. Operator decision: re-check each voting wallet's **current** stake
every **3 hours** and re-weight its votes to current stake (sentiment = current
conviction; it erodes if ADA is spent — the intended semantic). When A's ADA has
left, A's votes collapse to ~0. Cost: ~$0.30/mo at 10k voters; one batched Koios
`account_info_cached` call per ~100 voters covers it.

Shipped: a `comment_voters` registry, a `stakeAddress-commentId-index` GSI, the 3h
`revalidate-comment-stake` Lambda, an `N wallets · X ₳` display (exposes
concentration), and — folded in per the operator — **clubhouse delegation
enforcement**: poll voting is now delegation-gated at cast time, and the same 3h
sweep revokes poll votes + badges (does not hide) comments from wallets that have
un-delegated.

**Critical invariant:** the sweep **never** re-weights or revokes on an unconfirmed
Koios reading — a dual-upstream outage must not wipe vote weight. It skips and
retries. Proven by dedicated tests.

Deliberately **deferred** (not built this session): a per-vote weight **cap** (vs
single-whale dominance), delegation-snapshot eligibility, and a staging environment.

## 6. Process notes / lessons (see `LESSONS_LEARNED.md`)

- **The `cdk.out` parallel-deploy race** (→ `scripts/deploy.sh`). Never run two raw
  `cdk deploy`s against the shared output dir.
- **Parallel sub-agents fight over one git checkout** — two agents on separate
  branches in the same working tree clobbered each other's trees; one escaped to a
  `git worktree`. Run agents sequentially in one checkout, or give each its own
  worktree.
- **Tool-output timing** — late in the session AWS `describe`/`invoke` results
  arrived a beat out of alignment, which caused two transient false alarms (a
  wrong-filename grep read as "corruption"; a truncated key-schema readout that
  looked mis-keyed). Both were disproven by clean re-checks; no real defects. Lesson:
  re-verify with a focused single-value query before reacting.
- **Staged-migration deploy order** for new tables/GSIs: DatabaseStack → wait for
  GSI `ACTIVE` → backfill → Api/Scheduler → frontend. Reorder the backfill **before**
  the read-cutover deploy to avoid an empty-table window.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
