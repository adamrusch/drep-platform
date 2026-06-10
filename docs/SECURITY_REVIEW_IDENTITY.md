# Security Review — On-Chain Identity Subsystem

**Status:** Engineering review. **NOT a formal security certification.** An
independent third-party review is strongly recommended before the
four-role on-chain login is exposed to production traffic on
`drep.tools`.

**Scope:** The three new seams added by Sprints 1–3:

  1. The **KV → DynamoDB nonce adapter** (`backend/src/lib/identity/stores/nonceStore.dynamodb.ts`).
  2. The **per-session JWT revocation store** (`backend/src/lib/sessionRevocation.ts`).
  3. The **daily role-revalidation cron** (`backend/src/sync/revalidate-onchain-roles.ts`).

Plus the strict-address-header decision and the new
`IdentityCoseMissingAddressHeader` CloudWatch metric (Sprint 3).

**Out of scope:** the ported `lib/identity/auth/` resolvers (DRep
Talk Apache-2.0 code, structurally re-verified in `parity.test.ts`); the
legacy CIP-30 wallet login path (untouched by this work); the broader
governance / clubhouse / committee surfaces.

---

## Seam (a) — KV → DDB nonce adapter

File: `backend/src/lib/identity/stores/nonceStore.dynamodb.ts`

DRep Talk's reference implementation uses Cloudflare KV. The port stores
identity-flow nonces in the shared `authNonces` DynamoDB table under
`kind='identity'`, keyed by the 32-byte base64url nonce itself.

### TTL-lag / replay window

**Threat.** Cloudflare KV auto-evicts at the TTL boundary. DynamoDB's
TTL deletion lags by up to 48 hours. An attacker who captured a
challenge nonce on the wire and watched the legitimate user fail to
complete the verify step (e.g. wallet rejected) could replay the
captured signature LATER — past the intended 5-minute window — and
collect the resulting session, IF the read path treated the row's mere
presence as proof of un-expired validity.

**Current mitigation.** The adapter does an EXPLICIT `now > expiresAt`
check on every read (`nonceStore.dynamodb.ts:53`) and treats an expired
row as ABSENT. The check sources `now` from the injected `NowFn` (the
prod default is wall-clock seconds). The expired row is also
best-effort deleted on the read path so the table stays tidy and the
replay window cannot be re-opened by a subsequent reader skipping the
check. This is the same pattern used by the per-session tombstone store
(`sessionRevocation.ts:216`).

**Residual risk.** A clock skew on the Lambda runtime (extremely
unlikely on AWS-managed runtime) could open a small window where
`now` < the real `expiresAt`. Bounded by AWS NTP — typically sub-second.

**Recommended follow-up.** None — the explicit expiry check is the
correct mitigation. An optional defense-in-depth would be a periodic
TTL-cleanup sync over `authNonces` (the table already has DDB TTL
enabled, so this is purely belt-and-suspenders).

### Append-only nonce write

**Threat.** A racing concurrent put for the same nonce could overwrite
a legitimately-issued challenge with attacker-controlled bytes, e.g. to
extend the lifetime or rebind it to a different domain.

**Current mitigation.** The put uses
`attribute_not_exists(#nonce)` (`nonceStore.dynamodb.ts:45`) — DynamoDB
fails the second writer with `ConditionalCheckFailedException`. Combined
with random 256-bit nonces (collision probability negligible) this is
strict append-only.

**Residual risk.** None practical. A 256-bit collision is below
cryptographic-impossibility thresholds.

**Recommended follow-up.** None.

### Single-use consume

**Threat.** A replay of a successfully-consumed nonce.

**Current mitigation.** `consumeNonce` (in `lib/identity/auth/nonce.ts`)
calls `store.delete` after the cryptographic checks pass. The DDB
`deleteItem` uses `attribute_exists(#nonce)` — the second
`delete` call against the same nonce returns CCFE which the adapter
swallows as "already gone" (idempotent), preserving the single-use
semantic without races.

**Residual risk.** None — the contract is sound.

**Recommended follow-up.** None.

---

## Seam (b) — Per-session JWT revocation

File: `backend/src/lib/sessionRevocation.ts`

Every on-chain login mints a fresh ULID `jti`, which is then indexed
per identity under `kind='session_index'` and (on a revoke) tombstoned
under `kind='session'`. The JWT authorizer at
`backend/src/middleware/jwt-authorizer.ts:80` consults
`isSessionRevoked` on every authenticated request.

### Fail-OPEN on store read errors

**Threat.** A DynamoDB outage that makes `isSessionRevoked` throw could
either (i) lock every authenticated user out (fail-CLOSED) or (ii) skip
the revocation check entirely (fail-OPEN). The current code chooses
fail-OPEN at `sessionRevocation.ts:225` — a thrown read resolves to
`false` (not revoked). An attacker who managed to revoke their own
token (e.g. via a logout-everywhere that succeeded) could then
re-attack the token DURING the DynamoDB blip and have it accepted.

**Current mitigation.** This is a deliberate trade-off documented in
the file header (`sessionRevocation.ts:13–17`). The JWT itself is
already cryptographically valid — fail-OPEN matches the live behavior
of the legacy `tokenVersion` path in the authorizer
(`middleware/jwt-authorizer.ts:116`) and prioritizes availability
during an AWS-side outage over enforcing revocation. The exposure
window is bounded by the outage duration (minutes, typically) AND by
the fact that the attacker still needs a cryptographically valid token
they previously held.

**Residual risk.** A coordinated attacker who logged out a stolen
session and then re-attempted use during a DDB blip would briefly
re-gain access. The window is small and constrained by the
already-compromised credential — this is not a meaningful escalation
of an existing compromise. Locked in by
`sessionRevocation.test.ts: returns false when getItem throws (DynamoDB blip)`.

**Recommended follow-up.** Consider a future independent `pkce`-style
binding (token + per-request DPoP proof) so a stolen token alone is
not enough to authenticate. Outside Sprint 3 scope; track as a backlog
item.

### `authNonces` table reuse — boundary

**Threat.** Tombstones, per-user index rows, and identity nonces all
land in the same `authNonces` table the legacy
`'challenge' | 'mutation' | 'circuit' | 'drep_link'` rows live in. A
schema-discriminator collision (a tombstone read by legacy-nonce code,
or vice versa) could let one path mistakenly accept rows from another.

**Current mitigation.** Every reader checks `kind` before acting on a
row. The legacy `lib/auth.ts` nonce kinds form a closed set
(`'challenge' | 'mutation' | 'circuit' | 'drep_link'`) which never
matches `'session' | 'session_index' | 'identity'` (the new kinds).
Documented at `sessionRevocation.ts:23–28`. Locked in structurally by
TypeScript narrowing in each consumer.

**Residual risk.** A future kind-name collision introduced by a
maintainer who skips the documented boundary. Low — the boundary is
called out in the file header AND TypeScript would not narrow correctly
on a mis-typed kind.

**Recommended follow-up.** When the platform's identity surface stops
being additive, migrate per-session tombstones to a dedicated table.
The current public surface (`revokeSessionByJti` / `isSessionRevoked` /
`revokeAllSessionsForUser` / `listActiveSessionIndices`) is
table-agnostic — a future CDK PR can split the storage without changing
any caller.

### `jti` uniqueness

**Threat.** A `jti` collision between two concurrently-issued sessions
would let one revoke tombstone close BOTH tokens — or, worse, let an
attacker who can predict ULIDs preemptively tombstone the next legit
session.

**Current mitigation.** `jti` is a ULID generated at
`backend/src/handlers/auth/onchainVerify.ts:243` via the `ulid` package
(monotonic, 80 bits of entropy per millisecond). Collision probability
is negligible at the platform's expected scale. ULIDs are NOT
cryptographically random — a sophisticated attacker who knows the
millisecond an issue happens can constrain the search space, but to
preemptively tombstone they would also need the OUTPUT of
`recordSessionForUser` (which writes the index BEFORE the login
response is sent).

**Residual risk.** A monitoring attacker who can observe the verify
Lambda's stdout (i.e. has CloudWatch Logs read access) could in
principle see the issued `jti` and revoke it — but this requires
AWS-side access far beyond the platform's threat model.

**Recommended follow-up.** None. ULIDs are appropriate. The marginal
benefit of fully-random UUIDs (replacing `ulid()` with
`crypto.randomUUID()`) is unwarranted; the existing structure
preserves debug ergonomics (sortable by issue time).

### Per-user index TTL bound

**Threat.** A long-lived wallet's `session_index.jtiHashes` array could
grow unbounded.

**Current mitigation.** Bounded at 1024 entries (`sessionRevocation.ts`
`merged.slice(-1024)`). A wallet with more than 1024 concurrent
sessions would lose the oldest hash from the index — that session is
still individually revocable via its `jti` but won't be picked up by a
future `revokeAllSessionsForUser`.

**Residual risk.** A wallet that holds 1024+ concurrent sessions could
have an old session that survives a "logout everywhere" call. In
practice no real user creates more than a handful of sessions in the
30-day JWT TTL window.

**Recommended follow-up.** None.

---

## Seam (c) — Daily role-revalidation cron

File: `backend/src/sync/revalidate-onchain-roles.ts`

EventBridge fires the Lambda at 02:30 UTC daily. It enumerates active
on-chain identities via `listActiveSessionIndices`, re-resolves each
role via Koios, and revokes definitively-deregistered identities via
`revokeAllSessionsForUser`.

### Staleness window — 24h

**Threat.** A DRep who deregisters at 02:31 UTC keeps an unexpired
JWT (worst case) for ~24 hours before the next cron pass. Their
governance-action vote-cast surface stays unlocked during that window.

**Current mitigation.** 24h is the cadence locked by Sprint 3. It's a
deliberate trade-off — shorter cadence (e.g. hourly) would multiply
Koios calls without materially shrinking the practical exposure window
(epoch transitions are ~5 days on mainnet, so 24h vs 1h is irrelevant
to most role-loss events). Documented at
`revalidate-onchain-roles.ts:75–83`.

**Residual risk.** Up to 24h gap between a definitive deregistration
and revocation. The legacy `tokenVersion` path (which a global "log
out all my sessions" still hits) closes this faster IF the user
explicitly logs out — but the cron exists precisely to handle the
case where they don't.

**Recommended follow-up.** Consider tightening to 4–6h cadence if
post-deployment monitoring shows a meaningful number of role-loss
events landing in production. Bounded by the public-tier Koios RPS
budget — at today's scale this is trivial; at 10k+ active identities
it would need a dedicated Koios paid tier or batching all four
resolvers into a single pass per cycle.

### Fail-safe on Koios error

**Threat.** A Koios outage that throws on every lookup, if treated as
"role no longer present", would mass-revoke every active on-chain
identity. This is the inverse failure mode of fail-OPEN above and is
strictly worse — users would be silently locked out and would have to
re-authenticate (some, e.g. SPOs, would need to dig out cold keys).

**Current mitigation.** Two layers:

  1. **Strict Koios adapter.** The cron does NOT use the verify-path
     `buildKoiosAdapter` (which catches every Koios failure and returns
     `null` / `[]` so the live login can 401 cleanly). It instead uses
     a `buildStrictKoiosAdapter` defined inline at
     `revalidate-onchain-roles.ts:107–185` that wraps the same
     underlying `koios.ts` helpers but PROPAGATES `KoiosError`s. This
     is the load-bearing piece — without it, a Koios brownout would
     surface to the cron's decision logic as `drepInfo() → null`,
     indistinguishable from a genuine deregistration. The strict
     adapter ensures errors stay distinguishable from "no row".

  2. **Decision logic only revokes on DEFINITIVE positive reading.**
     `decideForIdentity` only emits `revoke` when the resolver returned
     `{isRole: false}` AND the underlying Koios call did NOT throw.
     Anything else — `resolveDRep`/`resolveProposer` throws caught by
     the `upstream-failure` branch, the CC committee returning an
     empty roster (brownout signature), the SPO role-check being
     absent entirely — counts under `identitiesUpstreamFailures` and
     SKIPS the identity.

Locked in by explicit tests in `revalidate-onchain-roles.test.ts`:

  - `Koios error leaves sessions intact (NO revoke on thrown lookup)`
  - `enumeration failure → empty result, NO revoke calls (fail-safe)`
  - `CC member with empty committee_info → upstream-failure (NOT revoke)`
  - `uses STRICT semantics: thrown koios.fetchDRepInfoBatch surfaces as upstream-failure`
  - `uses STRICT semantics: empty fetchDRepInfoBatch result = definitive deregistration → revoke`

**Residual risk.** A persistent multi-day Koios outage prevents the
cron from doing its job. The role-loss gap widens during the outage.
This is an availability degradation, not a security regression — the
legacy `tokenVersion` path still allows manual log-out-everywhere.

**Recommended follow-up.** Consider a Blockfrost fallback for the
role-check (mirroring the governance-intake sync's primary/secondary
pattern). Adds infra complexity; deferred.

### Revocation correctness

**Threat.** The cron's `revoke` path delegates to
`revokeAllSessionsForUser(walletAddress)`. A bug that called this with
the wrong walletAddress (cross-tenant) could wipe out an unrelated
identity's sessions.

**Current mitigation.** The cron passes `idx.walletAddress` directly
from the session-index row that produced the role-mismatch finding —
no string manipulation, no role-to-credential remapping. Each
identity's sessions are scoped by the credential identifier used as the
JWT `sub`. Locked in by
`revalidate-onchain-roles.test.ts: now-deregistered identity gets revoked (revoke called exactly once)`
asserting `revoke` was called with the EXACT enumerated walletAddress.

**Residual risk.** None practical — the data flow is pass-through.

**Recommended follow-up.** None.

### Documented Sprint 3 SPO gap

**Limitation.** The cron's SPO branch is a no-op (sessions preserved).
The legacy resolver suite checks SPOs by Calidus public key
(`resolveSpo` takes `calidusPubKeyHex`), but the session index only
stores `pool_id_bech32` — not the originating Calidus key. The cron
cannot re-check pool retirement without a `poolStatus(poolId)`
adapter method that the live `koiosAdapter` does not expose.

The cron emits a per-SPO-identity warning per pass so the gap shows up
in CloudWatch. Other three roles (drep / cc / proposer) gain the daily
revalidation immediately. Sprint 4 should add the missing adapter
method + extend the cron's SPO branch. Documented in-line at
`revalidate-onchain-roles.ts:159–179`.

**Residual risk.** A retired SPO keeps their `spo`-role JWT for up to
30 days. The SPO permission set on the platform is narrow today
(public-comment governance writes); the staleness window does not
expose vote-cast or treasury actions.

**Recommended follow-up.** Sprint 4 — add `poolStatus(poolId)` to the
koiosAdapter; flip the SPO branch in `decideForIdentity` from
"still-valid" to the real check.

---

## Strict address-header decision + telemetry metric

File: `backend/src/lib/identity/auth/cose.ts:212–215`,
`backend/src/handlers/auth/onchainVerify.ts:170–180`.

### The strict-reject

CIP-8 protected headers are required by the spec to carry an
`address` field; the verifier rejects when it's missing
(`cose.ts:213`). Oracle flagged that some older wallets omit it. Sprint
3 keeps the strict rejection — relaxing without quantification would
open a defense-in-depth gap (the address binds the signature to a
specific cardano address, preventing certain cross-account replay
shapes).

**Threat (if relaxed).** A signature lifted from one wallet and replayed
against the verify path WITHOUT the address binding could potentially
satisfy a different cardano address's role check (the resolver picks
the address from the signature; without the address field the verifier
falls back to the bare key hash). The exact exploit surface depends on
which roles a key happens to satisfy. Strict rejection eliminates this
entirely.

### The new metric

To quantify the affected wallet population BEFORE any future decision
to relax, Sprint 3 emits a CloudWatch metric
(`IdentityCoseMissingAddressHeader`, namespace `DrepPlatform/Identity`,
dimensions `Stage` + `Role`) via Embedded Metric Format on every
specifically-this-rejection (`onchainVerify.ts:173–179`). The metric
is emitted at the handler boundary, NOT inside `cose.ts` — the
identity module stays pure.

The wire response stays generic (`'Signature verification failed'`) —
the internal reason is NEVER leaked to a caller.

**Threat.** A wallet that gets a `401` learns nothing about whether
the failure was a bad signature, a wrong key, a wrong nonce, or a
missing address header. Good. But the operator running CloudWatch can
see the aggregate count.

**Current mitigation.** EMF format chosen over `PutMetricData` because
(a) the Lambda already has `logs:PutLogEvents` from
`AWSLambdaBasicExecutionRole`, so no IAM change is needed; (b) EMF is
cheaper. Documented in `lib/metrics.ts`. Locked in by
`onchainVerify.test.ts: emits IdentityCoseMissingAddressHeader on a CIP-8 verify with no protected-header address`
+ the negative `does NOT emit the metric for a valid signature` and
`does NOT emit the metric for a non-address-header verify failure` tests.

**Residual risk.** None practical — the metric is a counter; it
reveals only aggregate failure shape, not per-user data.

**Recommended follow-up.** After ~1 month of production traffic,
review the metric. If `IdentityCoseMissingAddressHeader/total CIP-8 401s`
is below ~5%, the strict reject is fine to keep indefinitely. If
materially above, consider an opt-in relaxation mode tied to a feature
flag with an independent security review of the relaxed verifier
semantics.

---

## Closing notes

This review is engineering judgment by the implementing engineer. It
captures the threat model that informed the design but is NOT a formal
security certification.

**Before exposing four-role login to production traffic on `drep.tools`,
the recommended steps are:**

  1. Independent code review of the three new seams by an external
     security engineer familiar with COSE / CIP-8 and AWS identity
     patterns.
  2. Threat-model walk-through with at least one Cardano-protocol
     security reviewer (Intersect MBO security WG or equivalent).
  3. A dry-run of the daily revalidation cron in `staging` against
     synthetic role-loss events (deregister a test DRep, retire a
     test SPO via cold-key rotation) to verify the revoke path
     end-to-end against real Koios responses.
  4. Verify the EMF metric is reaching CloudWatch correctly via
     `aws cloudwatch get-metric-data` against
     `DrepPlatform/Identity / IdentityCoseMissingAddressHeader`.
  5. Confirm the SPO gap (documented at
     `revalidate-onchain-roles.ts:159–179`) is acceptable for the
     initial production exposure, or implement the Sprint-4 follow-up
     before launch.

**Test coverage** for the seams under review:
`backend/src/lib/sessionRevocation.test.ts` (13 tests),
`backend/src/sync/revalidate-onchain-roles.test.ts` (20 tests),
`backend/src/handlers/auth/onchainVerify.test.ts` (12 tests).
The COSE verifier itself rides the substantial coverage already in
`backend/src/lib/identity/auth/cose.test.ts` (DRep Talk parity).
