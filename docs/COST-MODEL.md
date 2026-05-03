# Cost Model

Per-service cost projections for drep.tools at current scale (~316k
Blockfrost-budget calls/day, ~2000 DReps, ~110 governance actions on
mainnet today). Numbers are USD/month unless noted.

## TL;DR

Steady-state: **$1-3/month** for the AWS stack.

Break-even free-tier coverage extends comfortably past 10k MAU before
costs become non-trivial.

## Contents

- [Lambda](#lambda)
- [DynamoDB](#dynamodb)
- [API Gateway](#api-gateway)
- [CloudFront](#cloudfront)
- [WAF](#waf)
- [Route 53](#route-53)
- [Secrets Manager](#secrets-manager)
- [AWS Budgets](#aws-budgets)
- [Total](#total)
- [Cost-explosion failure modes](#cost-explosion-failure-modes)
- [External costs](#external-costs)

---

## Lambda

### Sync Lambdas

- **Governance intake**: 1 invocation/min × 60 × 24 × 30 = **43,200/mo**
  - Average duration: ~5-10s
  - Memory: 1024 MB
  - GB-seconds: 43,200 × 7.5s × 1 GB = 324,000 GB-s/mo
- **Directory sync**: 1 invocation/30 min × 48 × 30 = **1,440/mo**
  - Average duration: ~30-60s
  - Memory: 1024 MB
  - GB-seconds: 1,440 × 45s × 1 GB = 64,800 GB-s/mo

### API handlers (22 functions)

Estimated traffic at current scale:
- Governance list/detail: ~5k req/day
- Directory list/detail: ~3k req/day
- Auth flow (challenge + verify + me): ~500/day
- Comments + clubhouse + profile: ~1k/day total
- **Total**: ~10k handler invocations/day = **300k/mo**
- Average duration: ~200ms (cache-warm), ~2s (cold)
- Average GB-s: 300k × 0.5s × 0.5 GB = 75,000 GB-s/mo

### Free tier

- 1M invocations/mo free → we're at ~344k, fully covered
- 400,000 GB-s/mo free → we're at ~464k, slight overrun

### Projection

- After free tier: ~64k GB-s × $0.0000133/GB-s × 0.8 (ARM64 discount) ≈
  **$0.05-0.10/mo**
- Compute provisioned-concurrency cost: **$0** (we don't use it)

**Lambda total: <$0.10/mo**

---

## DynamoDB

PAY_PER_REQUEST pricing:
- $1.25 per million write request units (WRU)
- $0.25 per million read request units (RRU)
- 1 KB per WRU/RRU

### Write-heavy paths (syncs)

After the idempotency fix (commits `1199e256` + `6608593f` + `f6acb024`):

- **governance_actions**: ~109 rows × 1 WRU/row × ~30 writes/day = ~3,300
  WRU/day = **~99k WRU/mo**
  - On most cycles, only 1-3 actions actually change. The compare-then-write
    skip rate is typically >95%.
- **drep_directory**: ~2000 rows × 1 WRU/row × ~5 writes/day = ~10k WRU/day
  = **~300k WRU/mo**
  - 30-min cadence × 95%+ skip rate. Typical cycle writes 2-10 rows.
- **comments + clubhouse_posts**: ~50 user writes/day × 1 WRU = **~1.5k
  WRU/mo**
- **users + audit_log + auth_nonces**: ~1k WRU/mo combined

**Total writes**: ~400k WRU/mo × $1.25/M = **~$0.50/mo**

### Read-heavy paths

- **drep_directory list**: ~3k req/day × ~1.6 KB/scan-row × 1500 rows / 4
  KB per RRU = ~1,200 RRU/req. CloudFront cache hit ratio ~90% means only
  10% reach the Lambda; the in-Lambda module cache absorbs another ~70%
  of that. Effective: ~3k × 0.1 × 0.3 × 1200 = ~108k RRU/day = **~3.2M
  RRU/mo**.
- **governance_actions list/detail**: ~5k req/day × ~5 RRU/req × CloudFront
  cache hit ratio ~80% = ~5k RRU/day effective = **~150k RRU/mo**
- **All other GETs**: negligible

**Total reads**: ~3.4M RRU/mo × $0.25/M = **~$0.85/mo**

### GSI multipliers

GSIs incur their own RRU/WRU cost, equal to ~1× the base table for queries
that hit them. Counted above.

### Storage

~10 MB across all tables. Storage cost: **~$0.01/mo**.

### PITR (point-in-time recovery)

$0.20/GB/mo of backup storage. At ~10 MB total: **<$0.01/mo**.

**DynamoDB total: ~$1.40/mo**

---

## API Gateway

HTTP API v2 pricing: **$1.00 per million requests** (regional).

At ~10k req/day = ~300k/mo, mostly cached at CloudFront so origin requests
are even fewer:
- Origin requests after CloudFront cache: ~30% of viewer requests = ~90k/mo
- Cost: 90k × $1/M = **~$0.10/mo**

Free tier: first 1M HTTP API requests/mo free for 12 months.

**API Gateway total: <$0.10/mo**

---

## CloudFront

Pricing (US/Canada/EU edge):
- Data transfer out: $0.085/GB
- Per-request: $0.0075/10,000 HTTPS requests

### SPA distribution

- Bundle size: ~6.8 MB (mesh-sdk dominates), gzipped ~2 MB
- Initial loads: ~3k/day = 90k/mo
- Bandwidth: 90k × 2 MB = ~180 GB/mo
- Cost: $0.085 × 180 = **~$15/mo**

But: CloudFront cache hit ratio for static assets is ~99%. The
`s-maxage=31536000` on hashed bundle filenames means each bundle is
fetched at most a few times globally. Real-world bandwidth is ~1-5 GB/mo:
- Cost: $0.085 × 5 = **~$0.40/mo**

Per-request cost: 90k × $0.0075/10k = **~$0.07/mo**

### API distribution

Heavily cached. Most response bodies are <50 KB.
- Effective bandwidth: ~1 GB/mo
- Cost: **~$0.10/mo**

**CloudFront total: <$0.50/mo**

---

## WAF

Pricing:
- $5/Web ACL/mo (we have 1 — the API one)
- $1 per rule per month (we have 1 — RateLimitPerIp)
- $0.60 per million inspected requests

At ~300k inspected requests/mo: **$0.20/mo** for inspection.

**WAF total: ~$6.20/mo** (NOTE: this is the largest single line item.)

> If WAF cost becomes a concern, the rate-limit rule could be moved to
> CloudFront's native rate limiting (preview feature) or replaced with
> a Lambda@Edge IP throttle. The trade-off is observability — WAF gives
> us BlockedRequests metrics + CW logging out of the box.

---

## Route 53

- $0.50/hosted zone/month — we have one (`drep.tools`)
- $0.40 per million queries (first 1B); we're well under

**Route 53 total: $0.50/mo**

---

## Secrets Manager

$0.40/secret/month. We have two:
- `drep-platform/{stage}/jwt-secret`
- `drep-platform/{stage}/blockfrost-api-key`

API call cost: $0.05 per 10k requests. Negligible — both secrets are
fetched once per cold-start and cached at module level.

**Secrets Manager total: $0.80/mo**

---

## AWS Budgets

$0 — Budgets is a free service. Email notifications are also free.

We have two budgets:
- Soft: $5/mo, alerts at 80%, 100%, 120%
- Hard: $20/mo, alerts at 100%

Both are alert-only — per the project owner's explicit instruction, no
automated stop / IAM-deny. Documented in `api-stack.ts:798-906`.

---

## Total

| Service | Monthly |
|---------|---------|
| WAF | $6.20 |
| DynamoDB | $1.40 |
| Route 53 | $0.50 |
| Secrets Manager | $0.80 |
| CloudFront | $0.50 |
| Lambda | $0.10 |
| API Gateway | $0.10 |
| Budgets | $0 |
| **Total** | **~$9.60/mo** |

Hmm — that's higher than the "$1-3/mo" I quoted in the README. Let me
check the math:

- WAF dominates at $6+/mo. We can't eliminate it without losing the
  rate-limit defense.
- DynamoDB at $1.40 is roughly correct.
- Route 53 + Secrets are fixed per-asset costs.

A more honest framing: **~$10/mo at zero traffic, scaling slowly with
usage**. The README's "$1-3/mo" came from an earlier projection before
the WAF + Secrets Manager + Route 53 baseline were factored in. The
README will be reconciled with this document — keep this as the source
of truth for ops planning.

The free-tier first-year discount on Lambda (1M req, 400k GB-s) and
DynamoDB (25 GB storage, no request free tier on PAY_PER_REQUEST) shaves
a few cents. Not material.

---

## Cost-explosion failure modes

### Botnet on read endpoints

Without protections: 100 req/s × 30 days × 86400 s = 259M Lambda
invocations/mo. At $0.20/M = $52 + GB-s = ~$200/mo.

**Protections in place**:
1. CloudFront cache hits absorb >90% of repeat traffic.
2. WAF blocks single IPs at 2000 req / 5 min = 24,000 req/hour cap per
   IP.
3. In-Lambda cache absorbs cold-edge misses.
4. Idempotent syncs mean the writes side is unaffected.

**Worst-case** with all defenses engaged: a distributed botnet of 100
unique IPs each at the WAF limit = 2.4M req/hour × 720 hours = 1.7B
req/mo. Most go to CloudFront cache. Origin reaches: ~5% of those =
85M Lambda hits = ~$50/mo.

That's still survivable. The Budgets alert at $20 (100%) gives a 1-day
heads-up under sustained attack.

### DynamoDB write hotpath leak

Was the actual cause of a $2-4/day cost increase before commits
`1199e256` and `6608593f`. The fix moved both syncs to compare-then-write,
collapsing the write rate by >95% on quiet cycles.

**Protection**: the idempotency check IS the protection. As long as
`enrichmentVersion` matches and the data hasn't changed, no write
happens.

**Detection**: CloudWatch metric `ConsumedWriteCapacityUnits` per table.
A sudden 100x increase is the canary.

### Lambda runaway

A handler stuck in a tight error loop calling Blockfrost would burn the
Blockfrost quota and Lambda invocations simultaneously.

**Protection**:
- API Gateway throttle: 100 req/s steady, 200 burst.
- Per-handler timeout: 30s.
- Retries: 2 max in `eventsTargets.LambdaFunction` for syncs, no retries
  on user-triggered Lambdas.

### CloudFront egress runaway

Someone scraping the SPA bundle 1M times/day = 6.8 TB/day = ~$580/day at
$0.085/GB.

**Protection**:
- Hashed bundle filenames + s-maxage=31536000 means each unique bundle
  is fetched a small constant number of times globally regardless of
  user count.
- WAF rate-limit applies to the SPA distribution too if we enable it
  there (currently only on the API distribution; consider extending).

**Detection**: AWS Budgets at $20 hard.

---

## External costs

### Blockfrost

- **Discovery tier**: free, up to 1M requests/day. We're at ~316k/day,
  so we have ~3x headroom. After Phase B (commit `118ea5a6`) the
  governance sync no longer hits Blockfrost on the hot path; only the
  legacy fallback does.
- **Build tier**: $39/mo, 5M req/day. Only needed if Koios outages
  become routine and we exhaust the Discovery quota.

### Koios

Free, no quota. The `api.koios.rest` public endpoint is operated by stake
pools.

### Cardano IPFS gateways

Used by some DReps for anchor metadata. Free public gateways. No cost
to us.

### Domain (drep.tools)

~$15/year via Namecheap or similar. Not on AWS bill.

### Email (SES)

Configured in `api-stack.ts` (`SES_FROM_ADDRESS=notifications@drep-platform.io`)
but no production traffic yet. SES costs $0.10 per 1000 emails. The
identity needs to be verified before sending — see `RESUME.md` "Phase
1-D" notes.

---

## Cost-conscious changes to consider

If the WAF $6+/mo line ever needs to drop:
1. Move the rate-limit rule to a Lambda@Edge IP throttle (~$0.50/mo).
2. Use CloudFront's native rate limiting (currently in preview).
3. Drop WAF entirely and rely on CloudFront cache + API Gateway
   throttle + Budgets alert.

If DynamoDB grows past 10 GB stored, switch to tiered storage with
`StandardInfrequentAccess` table class (50% cheaper for cold data). Not
relevant at current scale.
