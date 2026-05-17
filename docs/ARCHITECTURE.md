# Architecture

This document is the deep dive. For the front-door overview see the root
[README](../README.md).

## Contents

- [System diagram](#system-diagram)
- [Per-surface data flow](#per-surface-data-flow)
- [Sync pipelines](#sync-pipelines)
- [Caching layers](#caching-layers)
- [Security layers](#security-layers)
- [Failure modes and circuit breakers](#failure-modes-and-circuit-breakers)
- [Cost protection](#cost-protection)
- [Why each tech was chosen](#why-each-tech-was-chosen)

---

## System diagram

```
                    +----------------------+
                    |  Cardano mainnet     |
                    |  (cardano-node +     |
                    |   cardano-db-sync)   |
                    +----------+-----------+
                               |
              +----------------+-----------------+
              |                                  |
     +--------v---------+              +---------v---------+
     |  Koios           |              |  Blockfrost       |
     |  api.koios.rest  |              |  cardano-mainnet  |
     |  free, primary   |              |  paid, fallback   |
     |  bulk endpoints  |              |  per-action calls |
     +--------+---------+              +---------+---------+
              |                                  |
              +-----------+----------------------+
                          |
                          v
         +--------------------------------------+
         | EventBridge Scheduler                 |
         |   - 1 min: governance-intake-sync     |
         |   - 30 min: drep-directory-sync       |
         +-----------------+--------------------+
                           |
                           v
         +--------------------------------------+
         | Sync Lambdas (backend/src/sync/*)     |
         |   * compare-then-write to DynamoDB    |
         |   * tally + voter-lookup math         |
         |   * persistent Blockfrost circuit     |
         +-----------------+--------------------+
                           |
                           v
         +--------------------------------------+
         |   DynamoDB  (PAY_PER_REQUEST)         |
         |   8 tables, 9 GSIs                    |
         |   - governance_actions                |
         |   - drep_directory                    |
         |   - users, drep_committees,           |
         |     comments, clubhouse_posts,        |
         |     audit_log, auth_nonces            |
         +--------+--------------+--------------+
                           |
                           v  (read + write)
         +--------------------------------------+
         | API handlers (backend/src/handlers/*) |
         | 22 Lambda functions, all NodeJS 20.x, |
         | ARM64, 512 MB / 30 s default          |
         |                                       |
         | + JWT authorizer (middleware/         |
         |   jwt-authorizer.ts) on protected     |
         |   routes                              |
         +-----------------+--------------------+
                           |
                           v
         +--------------------------------------+
         |  HTTP API v2 (api id: i9la4x29c6 dev) |
         |  100 req/s steady, 200 burst          |
         |  CORS allowlist: drep.tools,          |
         |    www.drep.tools                     |
         +-----------------+--------------------+
                           |
                           v
         +--------------------------------------+
         |  CloudFront (api.drep.tools)          |
         |  - cache GET reads (s-maxage=30)      |
         |  - default behavior pass-through      |
         |  - WAF Web ACL attached               |
         +-----------------+--------------------+
                           |
                           v
         +--------------------------------------+
         |  WAFv2 — RateLimitPerIp rule          |
         |  2000 req / 5 min / source IP, BLOCK  |
         +-----------------+--------------------+
                           |
                           v
                       Public Internet
                           |
                           v
         +--------------------------------------+
         |  React SPA (drep.tools)               |
         |  - served from S3 + CloudFront        |
         |  - CSP, HSTS, X-Frame-DENY headers    |
         |  - SPA fallback (4xx -> index.html)   |
         +-----------------+--------------------+
                           |
                           v
         +--------------------------------------+
         |  User browser + CIP-30 wallet         |
         |  Eternl / Lace / NuFi / Yoroi / Begin |
         |  (MeshSDK abstracts the wallet API)   |
         +--------------------------------------+
```

---

## Per-surface data flow

### Governance list (`/governance` page)

```
SPA (GovernanceListPage.tsx)
  |
  v  GET /governance?status=&actionType=&limit=
CloudFront (api.drep.tools)
  |  cache HIT? -> respond from edge
  |  cache MISS -> forward to origin
  v
API Gateway -> Lambda govListFn (handlers/governance/list.ts)
  |  Query governance_actions (GSI: status-submittedAt-index)
  v
DynamoDB
  |  rows pre-enriched by sync at write time
  v
Lambda emits Cache-Control: public, s-maxage=30
  |
  v
CloudFront stores at the edge (per-route policy: 30s defaultTtl)
  |
  v
Browser caches per Cache-Control (Cache-Control: max-age=15)
  |
  v
TanStack Query holds in-memory + retries on stale-while-revalidate
```

### Governance detail (`/governance/{actionId}`)

Same path as the list, but:
- `GET /governance/{actionId}` against `govGetFn`
- Vote tally and `votingRoles` are already on the row (computed at sync time
  by `voteTally.ts` + `applicableRoles`)
- Frontend reuses TanStack Query cache from the list when navigating
  list -> detail to avoid the round-trip

### DRep directory (`/dreps` page)

```
SPA (DRepDirectoryPage.tsx)
  |
  v  GET /dreps?sort=power&search=&page=0&pageSize=25
CloudFront cache (30s)
  |
  v
Lambda drepDirectoryListFn (handlers/directory/list.ts)
  |
  |  In-Lambda module-level cache (30s TTL, 50-entry LRU bound)
  |  cache HIT? -> respond
  |  cache MISS -> Scan
  v
DynamoDB Scan (full table, in-memory sort, paginate after sort)
  |
  v
Cache the response in-Lambda + emit Cache-Control: public, s-maxage=30
```

The Scan is fine at ~2000 rows. When the directory grows past ~10k we'll
need a real search service (OpenSearch, Algolia) — see comments in
`handlers/directory/list.ts`.

### DRep public profile (`/dreps/{drepId}`)

```
SPA (DRepPublicProfile.tsx)
  |
  v  GET /dreps/{drepId}
Lambda drepDirectoryGetFn (handlers/directory/get.ts)
  |
  v  GetItem on drep_directory (PROFILE row)
  v  + Query on drep_directory (POWER#* rows — Phase C voting-power history)
  v  + on-demand calls to Koios for delegators / recent votes
       (5-min in-Lambda cache)
DynamoDB + Koios -> response (with votingPowerHistory[] for Sparkline)
```

### Comments (governance + clubhouse)

```
SPA (CommentList.tsx + CommentForm.tsx)
  |
  v  GET /comments/{actionId}                     [public]
  v  POST /comments/{actionId} {body, sig, key}    [authenticated]
Lambda comments/list.ts | comments/create.ts
  |
  |  POST validates JWT cookie + mutation-nonce + Ed25519 signature
  |  Optional: lookupRecognition(stakeAddress) -> Koios primary, Blockfrost fallback (best-effort)
  v
DynamoDB Put on comments table
```

### Clubhouse

Same shape as comments, but scoped to a `drepId` partition. Posts can be
polls (clubhouse/votePoll.ts handles vote casting — JWT-only, no
mutation-nonce; trade-off documented inline).

### Auth challenge / verify

See the wallet flow diagram in the root [README](../README.md).
Implementation: `backend/src/lib/auth.ts` + `handlers/auth/*`.

---

## Sync pipelines

### Governance intake (`backend/src/sync/governance-intake.ts`)

- **Cadence**: every 1 minute (set by `SchedulerStack`).
- **Phase A**: Koios `/proposal_list` is the primary metadata source. One
  bulk call returns every action plus parsed CIP-108 anchor body
  (`meta_json`), on-chain description, lifecycle epochs, and
  `meta_is_valid`. Replaces 4 Blockfrost calls per action.
- **Phase B**: Koios `/vote_list` is also fetched once per cycle. Per-action
  vote tallies are computed in O(1) per action from the in-memory map,
  replacing ~109 Blockfrost calls per cycle.
- **Active-voter lookups** (Koios): `drep_list`, `pool_list`, `committee_info`,
  predefined-DRep power. Used to compute `notVoted = totalActive − cast` per
  CIP-1694, with auto-abstain stake correctly excluded from the denominator.
- **Idempotent writes**: every cycle compares the candidate row against
  what's already in DynamoDB (canonicalize-and-stringify, ignoring
  `lastSyncedAt`) and only `Put`s when something a downstream reader cares
  about changed.
- **Circuit breaker**: at the top of each cycle, check the persistent
  marker in `auth_nonces`; if open, skip the cycle entirely. Quota errors
  (402/429) on Blockfrost calls open the marker for 6 hours.
- **Enrichment versioning**: `ENRICHMENT_VERSION = 13` today. Bumping
  forces a re-enrichment of every row. Full version history is in the
  source comments (`backend/src/sync/governance-intake.ts:67-201`).
- **Phase C — per-vote event persistence**: at the same point the cycle
  already has the global `vote_list` in memory, the sync writes one row
  per individual vote into the new `governance_votes` table
  (`persistVoteEvents`). Append-only via conditional Put; bounded by a
  persistent high-water-mark in `auth_nonces` so steady-state cost is
  ~50 WCU/cycle (only newly-cast votes pay the WCU). Unlocks the
  governance-action-detail vote-timeline UX without a Koios round-trip
  on every page load.

### DRep directory (`backend/src/sync/drep-directory.ts`)

- **Cadence**: every 30 minutes. Bumped from 5 min as part of an emergency
  cost fix — the previous Put-every-row hot path was burning ~38k WCU/hour
  on `drep_directory` for ~zero changes per cycle.
- **Four Koios calls**: `drep_list` (full registry), `drep_info` (batched
  50/req — voting power, deposit), `drep_metadata` (batched 50/req — only
  for DReps with a `meta_url`), `vote_list` (global vote feed, aggregated
  to per-DRep `lastVotedAt` + `voteCount`).
- **Includes retired and inactive DReps**: writes a row for every DRep in
  `drep_list` regardless of state. Retired DReps render with a "Retired"
  badge and `votingPower="0"`. Surfaces behind `?includeInactive=true`.
- **Idempotent writes**: BatchGet existing rows, build candidates, only
  `Put` rows that genuinely differ (canonicalize-and-stringify, ignoring
  `lastSyncedAt`).
- No Blockfrost dependency at all.

### DRep voting-power history (`backend/src/sync/drep-voting-power-history.ts`) — Phase C

- **Cadence**: once daily at 02:00 UTC (set by `SchedulerStack`).
- **One Koios call per active DRep** (`/drep_voting_power_history`),
  paced at ~5 RPS to stay under the public-tier 10 RPS ceiling. ~1500
  active DReps → ~5 min wall-clock.
- **Storage**: `POWER#${zero-padded epoch_no}`-prefixed sub-rows on the
  existing `drep_directory` table. One row per (drepId, epoch) snapshot.
  Conditional Put on `attribute_not_exists(SK)` — historical snapshots
  are immutable so re-attempts silently skip at 1 WCU each.
- **Surfaced**: `directory/get.ts` queries the `POWER#` rows alongside
  the `PROFILE` row on every request and serves them as
  `votingPowerHistory[]`. The frontend Sparkline reads this field.
- **No Blockfrost dependency.** Pure Koios → DynamoDB sync.

---

## Caching layers

The platform caches at four layers, in order of distance from origin:

### Layer 1 — Browser

`Cache-Control: public, max-age=15` (or similar) emitted from each read
handler. Lets the browser hold the response in memory between navigations.
TanStack Query also dedupes in-flight requests and serves stale data while
revalidating.

### Layer 2 — CloudFront edge

Per-route cache policy on api.drep.tools (`api-stack.ts:451-462`):

| Route | TTL (default / max) | Cache key |
|-------|---------------------|-----------|
| `/governance`, `/governance/*` (GET) | 30 / 300 s | method + path + query, no cookies |
| `/dreps`, `/dreps/*` (GET) | 30 / 300 s | same |
| `/epoch` (GET) | 30 / 300 s | same |
| `/auth/*` | no-cache | pass-through |
| `/comments/*`, `/clubhouse/*`, `/profile/*`, `/drep/*` | no-cache | pass-through (origin emits browser-side Cache-Control) |
| `/governance/sync` | no-cache | passthrough (POST) |

The cache key never includes `Cookie` — all cacheable routes are public
reads. CloudFront forwards `Origin` for CORS but nothing else.

### Layer 3 — In-Lambda module-level cache

Each cold-edge / cache-invalidated request still hits the Lambda. To absorb
those:

- `handlers/directory/list.ts` keeps a `Map<string, CachedListEntry>` keyed
  by `(sort, search, includeInactive, page, pageSize)`. 30s TTL, 50-entry
  LRU bound. Hot when CloudFront has a cold edge.
- `handlers/directory/get.ts` caches per-DRep delegator and recent-vote
  lookups for 5 minutes.
- `lib/koios.ts` caches `/proposal_list`, `/drep_list`, `/pool_list`,
  `/committee_info`, `/vote_list` at the module level so the same Lambda
  warm container reuses results across simultaneous handler invocations
  (when the sync and a handler land on the same instance).
- `lib/blockfrost.ts` caches `/epoch` and serves stale on rate-limit.

These caches are wiped when the Lambda is cold-started, so they're an
optimization, not a correctness mechanism.

### Layer 4 — DynamoDB

DynamoDB is the source of truth for everything except the `/epoch` and
on-demand Koios endpoints. Reads are O(1) on the partition key. Writes are
idempotent at the application layer (compare-then-write).

---

## Security layers

### CIP-30 wallet signature verification

`backend/src/lib/auth.ts` implements the chain of trust:

1. Frontend calls `wallet.signData(stakeAddress, challengeMessage)` via
   MeshSDK. Wallet returns COSE_Sign1 (CBOR) + COSE_Key.
2. Backend CBOR-decodes the COSE_Sign1, extracts the `protected` headers,
   reconstructs the `Sig_Structure`, and verifies the Ed25519 signature
   using Node `crypto.verify`.
3. The COSE_Key's `-2` field carries the Ed25519 public key; the
   `walletAddress` claim is derived from a Blake2b-224 hash of that key
   (matching the chain's payment-credential derivation).
4. On success, the JWT is signed (HS256, 15-min TTL for non-`remember_me`
   sessions) and returned as an `HttpOnly; Secure; SameSite=Strict`
   cookie scoped to `Domain=.drep.tools`.

### JWT cookie

- `HttpOnly` — JS cannot read it (XSS-resistant).
- `Secure` — only sent over HTTPS.
- `SameSite=Strict` — never sent on cross-site requests.
- `Domain=.drep.tools` — shared across apex and `api.drep.tools`.
- `Max-Age` — 15 min for normal sessions, 30 days for `remember_me`.
- Refresh path on `/auth/refresh` (authenticated) issues a new cookie.

### Mutation nonces

For state-changing operations (comments, clubhouse posts, profile update),
the client must:
1. Call `POST /auth/mutation-nonce` to receive a 5-min single-use nonce.
2. Sign `{nonce, walletAddress, body}` with CIP-30.
3. Submit signature + nonce + payload to the mutation endpoint.

The handler verifies signature, deletes the nonce, and proceeds. This
defends against CSRF and replay even if the JWT cookie is somehow leaked.

Exception: `clubhouse/votePoll.ts` accepts JWT-only without a mutation
nonce. Trade-off documented inline — poll votes are cheap to undo and the
extra round-trip was noticeably degrading the polling UX.

### CSP / HSTS / X-Frame

`infra/lib/frontend-stack.ts:65-128` configures a CloudFront
`ResponseHeadersPolicy`:

- **CSP**: `default-src 'self'`, with explicit allowlists for
  `https://api.drep.tools`, `https://*.blockfrost.io`,
  `https://fonts.googleapis.com`, `https://fonts.gstatic.com`.
  Includes `'wasm-unsafe-eval'` (MeshSDK CSL) and `'unsafe-eval'`
  (vm-browserify in MeshSDK — tracked as a future tightening target).
- **HSTS**: `max-age=31536000; includeSubDomains` (1 year).
- **X-Frame-Options**: `DENY`.
- **Referrer-Policy**: `strict-origin-when-cross-origin`.
- **X-Content-Type-Options**: `nosniff`.

### WAF (CloudFront Web ACL)

Single rate-based rule:
- Limit: 2000 requests / 5 min sliding window per source IP
- Action: BLOCK
- Default ACL action: ALLOW
- Logging: CloudWatch log group `aws-waf-logs-drep-platform-{stage}-api`,
  7-day retention

This protects against the common case (single botnet IP hammering reads).
For DDoS at scale, AWS Shield Standard is automatic and free.

---

## Failure modes and circuit breakers

### Blockfrost circuit breaker

When the daily quota is exceeded, Blockfrost returns 402 — but the rejected
calls themselves count against the rolling window. Hammering 402s prevents
the window from ever clearing.

`backend/src/lib/circuitBreaker.ts` writes a marker to `auth_nonces` (which
already has TTL configured) when `isBlockfrostQuotaError(err)` returns
true. The governance sync checks the marker on entry and skips its run if
open. Marker auto-expires after 6 hours via DynamoDB TTL, after which the
next sync attempts a fresh probe.

State to inspect:

```bash
aws dynamodb get-item \
  --profile drep-platform \
  --table-name drep-platform-prod-auth_nonces \
  --key '{"nonce": {"S": "_circuit:blockfrost"}}'
```

### Koios outage fallback

The governance sync wraps Koios calls in `Promise.allSettled` and falls
through to the legacy Blockfrost-driven path on any rejection. The
directory sync has no Blockfrost path — on Koios outage it logs and skips
the cycle. Detail handlers degrade gracefully: a Koios delegator-list
failure leaves `delegators: undefined` rather than 5xx-ing.

### Deterministic /epoch fallback

`backend/src/handlers/epoch/get.ts` first tries the in-Lambda cache, then
Blockfrost `epochsLatest`. If both fail, it serves stale-cached data with
a `Stale: true` flag, OR — if no cached data exists at all — it returns a
deterministic chain-math computation based on `epoch 0` time + 432000s
slot length. This keeps the SPA functional even when both Blockfrost and
the cache are down.

---

## Cost protection

Layered defense:

1. **CloudFront cache** — reduces Lambda invocations for hot reads to ~1
   per 30s per cache key. A botnet pounding `/dreps` at 100 req/s gets
   served from the edge with one Lambda hit per 30s.
2. **WAF rate-limit** — a single IP can issue at most 2000 req / 5 min
   before being blocked.
3. **In-Lambda cache** — even on cold edges, the Lambda's module-level
   cache absorbs duplicate work across same-instance requests.
4. **Idempotent syncs** — neither sync writes a row that hasn't actually
   changed. The hot path on quiet cycles is now zero writes.
5. **AWS Budgets** — alert-only at $5 (80%, 100%, 120%) and $20 (100%).
   Per the project owner's explicit instruction these never trigger an
   automated stop / IAM-deny.

Each layer addresses a different attack profile. Layer 1 stops the obvious
cost amplifier; Layer 2 limits the per-IP base rate; Layer 3 catches what
slips through; Layer 4 fixes the internal hot paths; Layer 5 guarantees
human-in-the-loop awareness.

---

## Why each tech was chosen

### Koios (primary) over Blockfrost

- **Free tier** sufficient for current scale; no quota to worry about.
- **Bulk endpoints** that match our access patterns (`proposal_list`,
  `drep_list`, `vote_list` — one call returns everything). Blockfrost
  exposes the same data but spread across many per-action endpoints.
- **Decentralized** — multiple operator-run Koios instances, no single
  point of failure on the upstream side.
- **CIP-108 anchors pre-parsed**: Koios validates and parses anchor JSON
  for us via `meta_json`. Blockfrost's `/governance/proposals/.../metadata`
  often 404s for older actions.

Blockfrost is kept as fallback because it has a stable API contract and is
operationally robust. **Phase C (2026-05-17)** moved the last remaining
Blockfrost-primary surfaces — `/epoch`, recognition pills, and
`/profile/{wallet}/delegation-history` — to Koios primary via
`/epoch_info` and `/account_info_cached`. After Phase C, Blockfrost is
exercised only when Koios is unreachable; steady-state call volume on
the Blockfrost project drops to ~zero, and the Discovery tier can be
safely downgraded to free.

### HTTP API v2 over REST API

- **Cookie auth**: native cookie support (REST requires custom mappings).
- **70% cheaper**: $1/M requests vs $3.50/M for REST.
- **Lambda integrations only** — fits our handlers exactly.
- We don't need REST-only features (request validation, transformation
  templates, custom domains with multiple stages).

### DynamoDB PAY_PER_REQUEST

- **Auto-scale** for bursty workloads — the governance sync's per-minute
  burst is an order of magnitude bigger than the steady-state read traffic.
- **No capacity planning** — we don't know the steady-state traffic for a
  brand-new platform.
- **Idempotent writes** are first-class — `ConditionExpression` makes
  compare-then-write trivial.
- Cost is linear in actual usage, not provisioned capacity.

We'd switch to provisioned capacity if we ever saw sustained throughput
that would make on-demand more expensive than provisioned + auto-scaling.

### CDK over Terraform

- **TypeScript-native** — same language as the rest of the stack.
- **Native AWS** — no provider lag for new AWS features.
- **Type safety** for resource references (`databaseStack.usersTable.tableName`
  is a string, fully typed).
- **CloudFormation under the hood** — drift detection and rollback for free.

### Tailwind + custom design tokens

- **Cardano brand parity**: the `DESIGN_PARITY_*` MDs document the
  Cardano-Foundation-handoff design system; tokens live in
  `frontend/src/styles/design-system.css` and Tailwind extends them.
- **Utility-first** keeps the bundle small (only used classes ship).
- **Component primitives** (`<Card>`, `<Button>`, `<Donut>`, …) absorb the
  per-component styling decisions; pages compose with utility classes.

### MeshSDK for CIP-30

- The de-facto SDK for Cardano dApps. Handles wallet discovery, CIP-30
  enable/disable, COSE_Sign1 signing.
- Vendor-coupling is acceptable here — every wallet implements CIP-30, and
  if MeshSDK ever becomes a problem we can switch to a thinner CIP-30
  helper without changing the platform's auth model.
