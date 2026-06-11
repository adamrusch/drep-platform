# Architecture Decision Records (ADRs)

Brief records of major engineering choices. Format:
- **Status** — Accepted / Superseded / Reversed
- **Context** — the problem
- **Decision** — what we did
- **Consequences** — trade-offs

For implementation detail and inline rationale, follow the file
references at the end of each ADR.

---

## ADR-001: Koios as primary metadata source (Phase A)

**Status**: Accepted (2026-04, commit `cdaefc56`)

**Context**: Originally we used Blockfrost for everything — listing
governance actions, fetching CIP-108 anchors, computing vote tallies.
Two problems compounded: (1) Blockfrost's `/governance/proposals/.../metadata`
endpoint 404s for many actions whose anchors exist and validate elsewhere;
(2) one full sync cycle made 4 Blockfrost calls per action × 109 actions
= ~436 calls per cycle, plus retries — easily 30-40k calls/day on the
sync alone.

**Decision**: Migrate the governance sync's primary metadata source to
Koios's `/proposal_list`. One bulk call returns every action with the
parsed CIP-108 body (`meta_json`), on-chain description, lifecycle
epochs, and `meta_is_valid`. Blockfrost is kept as a fallback for the
cold-path enrichment and a few specific endpoints.

**Consequences**:
- 4 Blockfrost calls per action -> 0 on the hot path (when Koios is up).
- Per-cycle Blockfrost volume drops from ~436 to ~111 (votes only — see
  ADR-006 for the next step).
- New dependency on Koios uptime, mitigated by `Promise.allSettled` and
  fall-through to Blockfrost.
- More CIP-108 bodies surfaced (Koios validates more anchors than
  Blockfrost reports).

See: `backend/src/lib/koios.ts`, `backend/src/sync/governance-intake.ts`.

---

## ADR-002: HTTP API v2 over REST API

**Status**: Accepted (2026-04, initial infra)

**Context**: API Gateway has two product lines: REST API (v1) and HTTP
API (v2). REST is feature-rich (request validation, transformation
templates, AWS service integrations) but expensive ($3.50/M req).
HTTP API is leaner and **70% cheaper** ($1.00/M req).

**Decision**: Use HTTP API v2. We don't need REST-only features. Cookie
auth is natively supported by the HTTP API Lambda authorizer; we can
read `Cookie` and `Authorization` headers in the authorizer Lambda
without custom mappings.

**Consequences**:
- Lower per-request cost.
- Simpler payload format (`PayloadFormatVersion.VERSION_2_0`).
- No request validation at the gateway — handlers must validate
  payloads themselves. Acceptable since Lambda layer-level validation
  is more flexible anyway.
- No usage plans / API keys. Not needed for our model.

See: `infra/lib/api-stack.ts`.

---

## ADR-003: PAY_PER_REQUEST DynamoDB

**Status**: Accepted (2026-04, initial infra)

**Context**: We don't know the steady-state traffic for a brand-new
platform. Provisioned capacity needs careful planning to avoid throttling
or paying for unused capacity. Burst patterns (sync at top-of-minute)
make provisioned capacity awkward — auto-scaling reacts in minutes, not
seconds.

**Decision**: Every table on PAY_PER_REQUEST. Pay for actual usage; no
capacity planning.

**Consequences**:
- Cost is linear with usage. At low scale, very cheap (~$1.40/mo today).
- No throttling on bursty workloads — DynamoDB's adaptive capacity
  handles the per-minute spikes.
- Migration to provisioned capacity is one-line if we ever sustain
  traffic that makes it cheaper. The threshold is roughly 50% utilization
  of equivalent provisioned capacity.

See: `infra/lib/database-stack.ts` — every `dynamodb.Table` has
`billingMode: PAY_PER_REQUEST`.

---

## ADR-004: CIP-1694 active voting stake math

**Status**: Accepted (2026-04, commit `8d69a31b`)

**Context**: When computing the ratification denominator for governance
actions (the "Total Active Voting Stake" the donut renders against), our
first implementation included auto-abstain stake (`drep_always_abstain`)
in `totalActive`. That made ratios systematically off by ~8.9 billion
ADA — the auto-abstain pool is enormous on mainnet today.

CIP-1694 (Pre-defined Voting Options) explicitly says:

> If an Ada holder delegates to Abstain, then their stake is actively
> marked as not participating in governance. The effect of delegating to
> Abstain on chain is that the delegated stake will not be considered to
> be a part of the active voting stake.

**Decision**: Exclude auto-abstain stake from `totalActive`. The
ratification slice identity that must hold exactly:

```
yes.power + no.power + notVoted.power == totalActive.power
```

Auto-abstain power is carried as a separate informational field
(`autoAbstainPower`), surfaced in a footnote BELOW the donut rather than
inside it. Auto-no-confidence stake is direction-flipped: counted as
"Yes" on `NoConfidence` actions, "No" otherwise.

**Consequences**:
- Donut ratios match the spec.
- Backwards-incompatible row shape — bumped `enrichmentVersion` 7 -> 8
  to force a re-tally on every row.
- Frontend simplification — the "Auto-abstain" footnote is now visually
  distinct from the active stake, matching how CIP-1694 distinguishes
  them.

See: `backend/src/lib/voteTally.ts`, `backend/src/sync/governance-intake.ts`
(version history for v7 -> v8).

---

## ADR-005: Four cost-protection layers

**Status**: Accepted (2026-04, commits `af0e9934` + cost-fix series)

**Context**: A new platform on AWS has the standard cost-explosion risks:
botnet attacks, runaway Lambda loops, DynamoDB write spikes, Blockfrost
quota cascades. No single mechanism protects against all four.

**Decision**: Four protection layers, defense in depth:

1. **CloudFront cache** in front of the API. Cache GET reads with 30s
   `s-maxage`. Cache key is method+path+query, no cookies.
2. **WAFv2 rate-based rule** on the CloudFront distribution. 2000 req /
   5 min sliding window per source IP, BLOCK action.
3. **In-Lambda module-level caches** for the heaviest endpoints
   (directory list, Koios bulk responses). Absorbs cold-edge misses.
4. **AWS Budgets** at $5 (soft) and $20 (hard), alert-only. Per the
   project owner's instruction, never any automated stop / IAM-deny.

Fixed cost: ~$6/mo (WAF dominates). All four together cap the absolute
worst-case at <$50/mo even under sustained attack.

**Consequences**:
- ~$6/mo baseline. Acceptable.
- Multiple inflection points before cost becomes catastrophic.
- The WAF cost is a single line item — if it ever becomes a concern, the
  rate-limit rule could be migrated to a Lambda@Edge IP throttle for
  ~$0.50/mo, at the loss of WAF's observability.

See: `infra/lib/api-stack.ts:381-906`, `docs/COST-MODEL.md`.

---

## ADR-006: Phase B vote-tally migration to Koios

**Status**: Accepted (2026-04, commits `5de6e114` + `118ea5a6`)

**Context**: After Phase A (ADR-001), the governance sync still hit
Blockfrost ~109 times per cycle for vote tallies — one
`governance.proposalVotes` call per action. That was the biggest
remaining Blockfrost cost on the hot path AND the most common cause of
402 cascades during governance-heavy weeks.

Koios's `/vote_list` endpoint returns the global vote feed (~24k rows on
mainnet today) in a single bulk call. The directory sync was already
fetching this for `lastVotedAt` aggregation. Sharing the call across
both syncs via the module-level cache made it a near-zero-cost addition.

**Decision**: Replace `governance.proposalVotes` with Koios `/vote_list`
+ in-memory grouping. Adapt the row format with
`koiosVotesToBlockfrostShape()` so the existing pure-function tally
math is reused untouched. Add an inline assertion that catches >100bps
drift between old and new tallies for the first cycle after deploy.

**Consequences**:
- Per-cycle Blockfrost calls: ~111 -> ~1 (just `epochsLatest` as a
  fallback when Koios `/tip` fails).
- ~99% reduction in Blockfrost call volume on the vote path.
- The `assertTallyMatchesPrevious` helper logged within tolerance for
  the first day — no real drift, the migration was clean.
- Bumped `ENRICHMENT_VERSION` 10 -> 11 to force re-tally from Koios.

See: `backend/src/lib/koios.ts` (vote_list helpers), `backend/src/sync/governance-intake.ts`,
`backend/src/lib/voteTally.ts` (`koiosVotesToBlockfrostShape`).

---

## ADR-007: Idempotent sync writes

**Status**: Accepted (2026-04, commits `1199e256` + `6608593f` + `f6acb024`)

**Context**: A CloudWatch alarm flagged sustained ~38k WCU/hour on
`drep_directory` and ~66k WCU/hour on `governance_actions`. Both were
cause-correlated with the EventBridge sync rules.

Investigation showed both syncs were `Put`-ing every row every cycle,
even when no field had actually changed. Cost: ~$2-4/day in DynamoDB
write capacity that was producing zero observable effect.

**Decision**: Both syncs now compare-then-write:

1. Read existing rows (BatchGet for directory; per-action GetItem in the
   governance loop).
2. Build the candidate row from upstream data.
3. Canonicalize both sides (stable key order via JSON.stringify replacer)
   ignoring `lastSyncedAt`.
4. `Put` only when canonicalized strings differ.
5. `enrichmentVersion` is INCLUDED in the comparison — bumping the
   constant in code forces a write on the next cycle.

`lastSyncedAt` was demoted from "is the row fresh?" semantics to a
purely informational stamp. The freshness signal is now `enrichmentVersion`
matching the deployed code. Also bumped the directory sync cadence from
5 min to 30 min, since the user-visible `lastVotedAt` data comes from
the governance sync's 1-min cadence anyway.

**Consequences**:
- WCU on both tables collapsed by >95% on quiet cycles.
- Cost reduction: ~$2-4/day on the AWS bill.
- BatchGet adds ~800 RRU/cycle to the directory sync — two orders of
  magnitude cheaper than the wasted PutItem volume.
- Quiet cycles are near-free; busy cycles still write the rows that
  actually changed.
- Idempotency check needs to be kept in sync with row schema —
  `enrichmentVersion` MUST be bumped on any field shape change.

See: `backend/src/sync/drep-directory.ts:455-545`,
`backend/src/sync/governance-intake.ts:170-200, 472-480`.

---

## ADR-008: Opening a committee proposal takes no wallet signature

**Status**: Accepted (2026-06-05, PR #64)

**Context**: Every committee mutation re-signed a stage-bound CIP-30 message
(leaked-cookie protection). For *opening* a proposal — queuing a governance
action for the group to deliberate — the extra wallet popup was friction the
product owner explicitly didn't want, and the action is low-stakes: the group
still has to actually vote it through.

**Decision**: Opening a proposal is now JWT-auth + committee-membership only,
no re-sign. `proposerSignature` became optional on the proposal row. The
binding actions downstream — cast, close/pass, finalize rationale, and the
on-chain submission receipt — still require a fresh signature.

**Consequences**:
- One fewer wallet prompt on the most common committee action.
- A leaked session cookie can, at worst, queue a proposal the group then has
  to vote through — it can't cast or submit anything.
- `proposerSignature` is now nullable; old signed proposals still carry it.

See: `backend/src/handlers/committee/openProposal.ts`,
`frontend/src/hooks/useCommitteeVotes.ts` (`useOpenProposal`).

## ADR-009: Cache voter rationales from IPFS (active actions, on-row, manual backfill)

**Status**: Accepted (2026-06-05, PR #66)

**Context**: A DRep/SPO/CC vote can attach a CIP-100 rationale anchor
(`ipfs://`/`https://` URL + blake2b hash). We stored the URL + hash on the
`governance_votes` row but never downloaded the body, so the UI could only
render a raw external IPFS link. We wanted rationales shown inline.

**Decision**: A scheduled Lambda (`sync/vote-rationale-sync`) downloads each
vote's rationale via the existing multi-gateway, hash-verifying IPFS fetcher
(or direct https + blake2b), parses CIP-100 `body.comment` / CIP-108
`rationale`/`abstract`, and writes a compact `{rationaleText, title, status,
hashMatch}` **onto the vote row** (no new table — reuses the
`status-submittedAt-index` GSI). Scope: **active actions only** on the 30-min
schedule, bounded ~200 fetches/run, idempotent (terminal statuses skipped,
only `unreachable` retried). A manual invoke payload `{statuses, sinceDays}`
runs a **backfill** over concluded actions + a time window. `GET
/governance/{actionId}` returns the cached fields; the Votes tab renders them
inline (expandable, hash-mismatch caveat, "Source" link).

**Consequences**:
- Rationales display inline, hash-verified, with no per-render gateway hit.
- On-row storage keeps the hot `getVotesForAction` path read-free (capped to
  ~12 KB/field to stay under the 400 KB item limit).
- Active-only steady state keeps the working set + Blockfrost-independent
  gateway load small; history is an explicit, bounded backfill.
- The parser had to be split into a CSL-free `lib/cip108.ts` so the lean sync
  Lambda doesn't bundle the serialization-lib WASM (see LESSONS_LEARNED 06-05).

See: `backend/src/lib/voteRationale.ts`, `backend/src/lib/cip108.ts`,
`backend/src/sync/vote-rationale-sync.ts`,
`frontend/src/components/governance/VotesTab.tsx`.

## ADR-010: Migrate prod to dedicated `*-prod` stacks (full migration, not in-place)

**Status**: Accepted (2026-06-05). Supersedes the "Phase 1: dev IS prod" topology.

**Context**: `drep.tools` was served by the `dev`-stage stacks, and
`customDomainFor('dev')` had been set to return no domain (prepping a
migration). A naive `dev` deploy would therefore **detach the live domain**.
Shipping current code to prod required either an in-place hotfix (keep
`drep.tools` on the `dev` stacks, re-entangling the wart) or the documented
full migration to real `*-prod` stacks.

**Decision**: Full migration. Stand up `DRepPlatform-*-prod` (own prod
secrets, RETAIN tables, prod ACM cert) behind a new `--context noCustomDomain`
flag, smoke-test on raw URLs, copy the tiny irreplaceable data (3 users + 2
comments — everything else regenerates from chain), then a one-window cutover
that releases the aliases from `dev` and claims them on `prod`. New prod JWT
secret → all users re-log in. `dev` becomes a throwaway env with its syncs
disabled.

**Consequences**:
- `drep.tools` now on clean, isolated prod stacks; `dev` is a real dev env.
- ~15-25 min cutover downtime + a forced re-login (acceptable for the current
  tiny userbase; the data is regenerable).
- The `dev`-is-prod guards in `scripts/deploy.sh` / `infra/bin/app.ts` are now
  inverted and stale — follow-up to relax them (block only `prod`).

See: `docs/TOPOLOGY.md` (runbook + "Migration history"), `infra/bin/app.ts`
(`noCustomDomain`), `infra/lib/stage.ts` (`customDomainFor`).

---

## ADR-011: Adopt DRep Talk's identity subsystem (C-prime)

**Status**: Accepted (2026-06-10, Sprint 0–1)

**Context**: A comparative analysis between the in-house CIP-30 login in
`backend/src/lib/auth.ts` and the upstream DRep Talk codebase
(https://github.com/katomm/dreptalk.com, Apache-2.0) found DRep Talk's
identity surface to be the more disciplined and more robust of the two:
dependency-injected stores, structured `{ok, reason}` returns, fail-closed
COSE verification, a tighter pubkey-vs-address binding, and a substantial
test corpus including real wallet fixtures. With the platform's priorities
being correctness and the most-robust login surface available, the
question was not "do we improve our verifier" but "do we adopt the
known-good one."

**Decision**: Lift DRep Talk's `auth/*`, `crypto/*`, and
`cardano/identity.ts` modules WHOLE into `backend/src/lib/identity/`,
preserving the upstream module boundaries and dependency-injection
shape. Stack adaptations (the seams):

- **CBOR**: `cbor-x` instead of upstream `cborg`. `cborg` is ESM-only with
  an exports map our backend's commonjs/node module resolution cannot
  read; `cbor-x` is already a backend dep and `mapsAsObjects:false` gives
  the JS `Map` shape DRep Talk's verifier expects.
- **Ed25519**: Node `crypto` (`createPublicKey` + `verify` with an SPKI
  prefix) instead of `@noble/curves`. Same ESM-only blocker.
- **Blake2b**: existing `blake2b` dependency instead of `blakejs`. Same.
- **Stores**: DynamoDB-backed `NonceStore` / `SessionStore` adapters
  behind the upstream's KV/D1 interfaces.
- **Koios**: the existing `lib/koios.ts` wrapped behind a thin
  `KoiosAdapter` matching the upstream's resolver contracts.

The port is kept as a self-contained subsystem; explicitly **do not
dissolve into the legacy `backend/src/lib/auth.ts`** (the cohesion is
the robustness we're adopting). The legacy CIP-30 login continues to
run unchanged in parallel as the production surface; the ported code
backs the new on-chain login (ADR-012) and is the verifier the legacy
path cuts over to (ADR-016).

**Consequences**:
- A second auth implementation alongside the legacy one during the
  parallel window. ADR-016 collapses the duplication by re-routing the
  legacy `/auth/verify` through the same ported verifier.
- Apache-2.0 attribution block added to `NOTICE` covering
  `backend/src/lib/identity/*`, `backend/src/lib/dreps/*`, the
  concentration / avatar handlers, and the matching frontend modules.
- Backend test count rose from a baseline of 577 (snapshotted Sprint 0)
  to 1034 today across the seven sprints plus the security-review fixes.
  The 577-test governance baseline stayed untouched.
- A `parity.test.ts` cross-implementation corpus pins the ported COSE
  verifier against the legacy reference behavior wallet-fixture-by-
  fixture, so a future refactor can't silently drift.

See: `backend/src/lib/identity/` (the whole module tree),
`backend/src/lib/identity/README.md` (provenance + adaptation seams),
`backend/src/lib/identity/parity.test.ts` (DRep Talk parity corpus),
`NOTICE` (Apache-2.0 attribution).

---

## ADR-012: Four-role on-chain login as an additive parallel surface

**Status**: Accepted (2026-06-10, Sprint 2)

**Context**: The legacy CIP-30 login authenticates a stake address —
sufficient for governance discussion but insufficient for surfaces that
need to recognise a caller's on-chain authority (DRep, SPO, CC member,
Proposer). A naive approach would have extended the `UserRole` union
with the four new values, but doing so would have churned every
exhaustive `switch` over `UserRole` across handlers / middleware /
frontend, with no functional benefit (the legacy role set and the
on-chain set are semantically distinct — legacy roles are platform-
internal grants; on-chain roles are cryptographic proofs of chain
state).

**Decision**: Add the four on-chain roles via a **parallel JWT claim**
(`onChainRoles: ('drep' | 'spo' | 'cc' | 'proposer')[]`) and a **new
endpoint family** under `/auth/onchain/*`, leaving the legacy
`UserRole` union and the legacy `/auth/*` surface untouched. Endpoints:

- `POST /auth/onchain/challenge` — issue a fresh nonce.
- `POST /auth/onchain/verify` — verify a CIP-8 (DRep / Proposer) /
  raw-Ed25519 (SPO Calidus, CC hot key) signature, resolve the on-chain
  role via Koios, mint a JWT carrying `onChainRoles` + `jti` + `personId`.
- `POST /auth/onchain/link/challenge` + `POST /auth/onchain/link/verify`
  — add a second credential to an already-authenticated person (ADR-014).
- `GET /auth/onchain/me` — aggregate response for the current person.
- `GET /auth/onchain/profile` / `PUT /auth/onchain/profile` — read/edit
  the canonical person profile (`onchain_users` row).

The verifier mix per role:

- **DRep / Proposer** — CIP-8 (COSE_Sign1) via the ported `verifyCip8`.
- **SPO** — Calidus pubkey + raw Ed25519 signature, resolved against the
  pool's currently-registered Calidus key via Koios (CIP-151).
- **CC** — raw Ed25519 signature against a pasted CC hot key, resolved
  against the active committee roster via Koios `/committee_info`.

**Consequences**:
- Zero churn on legacy handlers / middleware / frontend — every
  `switch(role)` over `UserRole` stays exhaustive.
- Pre-Sprint-1 JWTs continue to verify; the new claims are read
  defensively (`onChainRoles: []` when absent).
- New roles are resolved + gated entirely via Koios — no Blockfrost
  dependency on the on-chain login path.
- The on-chain login mints a `personId` (ADR-014); the parallel
  surface means a wallet can legitimately log in TWICE (once
  cookie-based legacy, once on-chain) and still resolve to one person
  (completed by ADR-016).

See: `backend/src/handlers/auth/onchainChallenge.ts`,
`backend/src/handlers/auth/onchainVerify.ts`,
`backend/src/lib/identity/auth/resolveRole.ts`,
`backend/src/lib/identity/auth/koios.ts`,
`backend/src/lib/auth.ts` (`issueJWT` / `verifyJWT` — `onChainRoles` +
`personId` + `jti` reader/writer),
`infra/lib/api-stack.ts` (route wiring under `/auth/onchain/*`).

---

## ADR-013: Dedicated `identity_sessions` table for per-session revocation

**Status**: Accepted (2026-06-10, Sprint 2 + Decision #1)

**Context**: The legacy `tokenVersion` revocation model on the `users`
table is a single monotonic counter per wallet — perfect for "log me
out everywhere" but useless for "log THIS device out, leave my other
sessions intact." The four-role on-chain login needs the latter
(a stolen tab on one machine should not invalidate the user's pinned
governance dashboard on another). Sprint 1 implemented session
revocation by reusing the `authNonces` table with `kind='session' |
'session_index'` discriminators; review for the production cutover
flagged three problems: a filtered Scan would have been required for
per-identity enumeration, two separate rows (tombstone + index) had to
be kept in sync via best-effort writes, and the session-store traffic
would have cost-coupled to the high-churn challenge/mutation nonce
traffic on the same table.

**Decision**: Carve a dedicated `identity_sessions` table with one row
per session.

- **PK** = `sessionKey` (SHA-256(jti) hex — opaque, deterministic,
  cheap to derive from the JWT).
- **Attributes**: `identityId`, `onChainRoles[]`, `issuedAt`,
  `expiresAt`, `revoked?`, `spoCalidusPubKeyHex?` (M5).
- **GSI**: `identityId-issuedAt-index` (PK `identityId`, SK `issuedAt`,
  projection ALL) so revoke-all and the cron enumeration are
  single-partition Queries, not Scans.
- **TTL** on `expiresAt` so rows are removed when the JWT can no longer
  be presented.

The public surface (`recordSessionForUser`, `isSessionRevoked`,
`revokeSessionByJti`, `revokeAllSessionsForUser`,
`listActiveSessionIndices`) is table-agnostic — a future migration
moves the storage without changing any caller.

The authorizer's `isSessionRevoked` fails **OPEN** on a store-read
error (a thrown read resolves to `false`): the JWT itself is already
cryptographically valid, an outage shouldn't lock every authenticated
user out, and the M3 fix (2026-06-10) adds `ConsistentRead: true` so a
just-landed revoke is visible on the next request.

A daily **role-revalidation cron** (EventBridge `02:30 UTC`,
`backend/src/sync/revalidate-onchain-roles.ts`) enumerates every active
identity via the GSI and revokes sessions whose role no longer holds
on-chain — closes the window where a deregistered DRep / retired SPO /
revoked CC keeps an unexpired JWT for up to 30 days. Critical
invariant: the cron uses a **strict Koios adapter** that propagates
errors (so a Koios outage surfaces as `upstream-failure` and skips,
NEVER as "role gone, revoke"); the verify-path adapter swallows them
for clean 401s.

**Consequences**:
- `revokeAllSessionsForUser` and the cron enumeration are O(per-identity)
  single-partition Queries.
- IAM footprint of the cron Lambda tightens to the one table it
  touches (previously `authNonces` RW; now `identitySessions` RW only).
- Session storage cost is decoupled from the auth-nonces hot path.
- Granular revoke (one session) and bulk revoke (everywhere) are
  semantically distinct operations, not different rows in the same
  table.

See: `infra/lib/database-stack.ts` (`identitySessionsTable`),
`backend/src/lib/sessionRevocation.ts` (the public surface),
`backend/src/middleware/jwt-authorizer.ts` (the `isSessionRevoked`
consult on every authenticated request),
`backend/src/sync/revalidate-onchain-roles.ts` (the daily cron +
strict adapter),
`backend/src/handlers/auth/logout.ts` (granular + revoke-all paths),
`docs/SECURITY_REVIEW_IDENTITY.md` (the deeper threat-model walk).

---

## ADR-014: Canonical person model + verified credential linking (no silent merge)

**Status**: Accepted (2026-06-10, Sprint 2 + Decision #3)

**Context**: A single human may legitimately authenticate to the
platform via several on-chain credentials — a wallet stake address
(legacy CIP-30), a DRep id (CIP-8), a pool's Calidus key (raw Ed25519),
a CC hot key (raw Ed25519). Without a canonical-person layer, four
logins from one person look like four unrelated identities: profile
edits don't transfer, the moderation surface mis-counts, and the
flagging primitive can be Sybil-gamed by one human producing four
"distinct" flag votes.

**Decision**: A two-table canonical-person model.

- **`onchain_users`** — PK = `personId` (ULID, opaque, never reused).
  Holds the editable profile (`displayName`, `bio`, `socialLinks`) +
  bookkeeping (`createdAt`, `updatedAt`). Distinct from the legacy
  `users` table — `users` is keyed by stake address and bound to the
  CIP-30 session; folding the person model there would collide on the
  PK for the wallet-stake case and break every legacy read site.

- **`identity_links`** — PK = `identityKey` =
  `${credentialType}:${credentialId}` (`drep:<drepId>` |
  `pool:<poolId>` | `cc:<ccCred>` | `stake:<stakeAddr>`). The
  namespace prefix is load-bearing — it makes the credential type
  self-describing on read and prevents cross-type collisions. GSI
  `personId-verifiedAt-index` (PK `personId`, SK `verifiedAt`,
  projection ALL) enumerates every credential one person controls in
  a single-partition Query.

Login auto-provisions: first on-chain login for an unmapped credential
mints a fresh `personId`, writes the `identity_links` row first (with
a conditional Put on `attribute_not_exists` so a concurrent racer
doesn't orphan a person row — S3 fix, 2026-06-10), then writes the
`onchain_users` row. The link's `verifiedVia: 'login' | 'link'` is the
audit breadcrumb for which path created it.

**Safety contract — no silent merge.** An already-authenticated user
linking another credential must produce a fresh cryptographic proof of
control. A credential already mapped to a DIFFERENT `personId` than
the caller's session person is **REJECTED** with a 409
"credential already linked to another account" — never silently
re-pointed. Account-merge is a future product decision; do not infer
it from a signature.

The link challenge's signed payload binds the caller's `personId`
into the bytes the wallet signs (M1 fix, 2026-06-10) — format
`dreptalk-link:<personId>:<stage>:<domain>:<nonce>:<issuedAt>` — so a
victim cannot be socially engineered into signing a challenge that
attaches their credential to the attacker's account. The link-verify
nonce is consumed only on a fully successful pass (signature + bound-
personId match), via `consumeNonceWithCheck`, so a forged signature
doesn't DoS the legitimate caller.

ADR-016 completes the reconciliation: the legacy CIP-30 login also
provisions a person under `stake:<stakeAddr>`, so wallet + raw-key
logins for the same human resolve to one `personId`.

**Consequences**:
- One person, many credentials — moderation, flagging, and profile
  surfaces are unified at the person level.
- Linking requires fresh proof of control on the new credential AND
  binds the caller's identity into the signed bytes; neither sufficient
  alone.
- The `users` table is untouched; the legacy CIP-30 surface keeps its
  existing read/write paths exactly.
- `personId` rides the JWT as an optional claim; pre-Decision-3 tokens
  omit it and downstream handlers fall back to resolving via the
  on-chain credential.

See: `infra/lib/database-stack.ts` (`onchainUsersTable`,
`identityLinksTable`),
`backend/src/lib/identityPerson.ts` (`resolveOrProvisionPerson` and
the conditional-put-first order),
`backend/src/handlers/auth/linkChallenge.ts` /
`backend/src/handlers/auth/linkVerify.ts` (the bound-personId
challenge + the same-person check + `consumeNonceWithCheck`),
`backend/src/handlers/auth/onchainMe.ts` (per-person aggregation),
`backend/src/handlers/auth/onchainProfileGet.ts` /
`backend/src/handlers/auth/onchainProfileUpdate.ts`,
`docs/SECURITY_REVIEW_IDENTITY.md` (M1 / S3 deep dive).

---

## ADR-015: Relax the strict COSE address-header to a credential fallback

**Status**: Accepted (2026-06-10, Decision #4). Supersedes the strict-
reject documented in `docs/SECURITY_REVIEW_IDENTITY.md` (`§ Strict
address-header decision`).

**Context**: CIP-8's protected header carries an optional `address`
field that DRep Talk's upstream verifier required. Some older wallet
builds (and a handful of currently-shipping ones) omit it. Sprint 3
kept the strict reject and added an `IdentityCoseMissingAddressHeader`
CloudWatch metric to quantify the affected wallet population before
making a decision. After observation, the reject was found to be
forcing user-visible failures on legitimate wallets without buying
meaningful security — every protection the address header offers is
ALSO enforced by the Ed25519 signature check that always runs first.

**Decision**: Relax the address-header requirement to a **fallback**:
when the protected header carries `address`, verify the signature AND
cross-check the pubkey-derived credential against the address bytes
(the existing bind step); when the header is absent, verify the
signature and **derive the identity from the pubkey alone**, matching
the legacy `verifyWalletSignature`'s behavior for the same case. The
returned `addressBound: boolean` discriminates the two paths so
downstream handlers can branch (and emit
`METRIC_IDENTITY_PROPOSER_ADDRESS_UNBOUND` on the unbound proposer
path — S4c, 2026-06-10).

Safe because the COSE protected header is part of the signed
`Sig_structure` — any tampering would invalidate the signature, which
is always verified first. Relaxing the header requirement therefore
cannot enable a forgery that the signature check would have caught.
The `IdentityCoseMissingAddressHeader` metric stays in place so a
sudden change in the affected-wallet population still surfaces.

**Consequences**:
- Legitimate wallets that omit the address header now log in
  successfully via the on-chain login.
- The legacy verifier's address-header handling and the ported
  verifier's now match exactly — important for ADR-016, which routes
  the legacy login through the ported code.
- A metric still tracks the affected-wallet shape; the threat-model
  walk in `docs/SECURITY_REVIEW_IDENTITY.md` records why a relaxed
  header is signature-evident.

See: `backend/src/lib/identity/auth/cose.ts` (the `addressBound`
discriminator + the relaxed-header logic with the pubkey-fallback
comment), `backend/src/handlers/auth/onchainVerify.ts` (the
`addressBound === false` branch + the metric emit), `backend/src/lib/
metrics.ts` (`IdentityCoseMissingAddressHeader`,
`METRIC_IDENTITY_PROPOSER_ADDRESS_UNBOUND`),
`docs/SECURITY_REVIEW_IDENTITY.md` (`§ Strict address-header
decision + telemetry metric`).

---

## ADR-016: Cut the legacy CIP-30 login over to the ported verifier (parity-gated)

**Status**: Accepted (2026-06-11, sibling PR #71)

**Context**: With the ported `verifyCip8` running in production on the
on-chain login surface, fixing-once-vs-twice became the question:
maintain two CIP-8 verifiers (legacy `verifyWalletSignature` for
`/auth/verify`, ported `verifyCip8` for `/auth/onchain/verify`), or
collapse to one. The ported verifier is stricter, better-tested, and
shares the COSE header relaxation (ADR-015) and the bound-pubkey →
claimed-address contract with the legacy path. Keeping both means
every security fix has to land in two places.

**Decision**: Reroute `backend/src/handlers/auth/verify.ts` from
`verifyWalletSignature` to the ported `verifyCip8`, with the legacy
path's load-bearing **identity-binding guard re-asserted after**
verification:

1. **Pubkey → claimed-address binding** (the P0-1 impersonation guard):
   the verified Ed25519 pubkey's blake2b-224 hash must match a
   credential embedded in the claimed `walletAddress`. Mismatch /
   script-credential / malformed address all reject. This is the
   load-bearing legacy check; preserving it byte-for-byte is the
   parity-gate's primary concern.
2. **Protected-header cross-check** (when present): when the COSE
   header carries an `address`, the verifier already enforces
   pubkey ↔ header-address binding; the handler additionally
   byte-compares it against the body-supplied `walletAddress`. When
   absent (ADR-015), the handler skips this step and trusts the
   pubkey-fallback — exactly matching legacy behavior.

The legacy JWT then carries `personId` (Decision #3 reconciliation):
after a successful legacy verify, `resolveOrProvisionPerson('stake',
stakeAddr, 'login')` provisions or resolves a person for the wallet's
stake credential, so a wallet login and the same human's on-chain
login resolve to one `personId`. Best-effort — never blocks login on a
write blip.

**Parity gate.** Two layers, both required green before the cutover
merges:

1. **`auth.walletSignature.test.ts` kept GREEN, untouched.** This is
   the legacy reference suite. We do NOT weaken it to make the new
   path pass. If the new path fails any case the legacy code accepted
   (or accepts any case it rejected), the cutover is wrong.
2. **`verify.parity.test.ts`** — a cross-implementation corpus
   asserting new-path == legacy-path on accept/reject AND on bound
   identity, including the wrong-claimed-address case (the impersonation
   guard), header-spoof, payload tamper, signature tamper, and
   missing-header cases.

`verifyWalletSignature` is **DEPRECATED**, not removed — two callers
remain (`handlers/comments/create.ts`, `handlers/committee/_committee.ts`)
that verify a mutation-nonce-signed message rather than the auth
challenge; migrating those is a follow-up.

**Consequences**:
- One CIP-8 verifier across the platform. Future fixes (e.g. a tighter
  COSE check) land in one place.
- Wallets that succeed under the legacy path continue to succeed (the
  parity gate is its proof).
- Wallets that produce headers slightly tighter than legacy accepted
  may now fail — the ported verifier is stricter on alg / kty / crv
  encoding. The parity tests pin the practical behavior; a regression
  would surface in the corpus.
- The two `verifyWalletSignature` mutation-nonce callers stay on the
  legacy code until a follow-up migration.

See: `backend/src/handlers/auth/verify.ts` (the cutover + the re-
asserted bindings), `backend/src/handlers/auth/verify.parity.test.ts`
(the corpus), `backend/src/lib/auth.walletSignature.test.ts` (the
legacy reference, kept green), `backend/src/lib/identity/auth/cose.ts`
(`verifyCip8`), `backend/src/lib/auth.ts`
(`verifyWalletSignature` — deprecated; the two remaining callers
documented inline).
