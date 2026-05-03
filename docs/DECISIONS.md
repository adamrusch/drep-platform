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
