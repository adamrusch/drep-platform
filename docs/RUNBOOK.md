# Runbook

Operational triage for production incidents on drep.tools. Each section
ends with **resolution** and **escalation** steps.

> Stage prefixes assume `prod`. For the dev stack, swap `prod` -> `dev`.
> AWS profile: `drep-platform`. Region: `us-east-1`.

## Contents

- [Blockfrost circuit open](#blockfrost-circuit-open)
- [Sync errors](#sync-errors)
- [Cost spike](#cost-spike)
- [Deployment rollback](#deployment-rollback)
- [Frontend showing stale data](#frontend-showing-stale-data)
- [Wallet auth failing](#wallet-auth-failing)
- [DynamoDB throttling](#dynamodb-throttling)
- [Cardano chain stalls / Koios outage](#cardano-chain-stalls--koios-outage)
- [Re-running historical syncs (schema migration)](#re-running-historical-syncs-schema-migration)
- [Common HTTP error codes from the API](#common-http-error-codes-from-the-api)

---

## Blockfrost circuit open

**What it means**: The governance sync detected a Blockfrost 402/429 and
opened the persistent circuit breaker. The sync will skip every cycle for
6 hours (or until manually cleared).

**Where to check**:

```bash
aws dynamodb get-item \
  --profile drep-platform \
  --table-name drep-platform-prod-auth_nonces \
  --key '{"nonce": {"S": "_circuit:blockfrost"}}'
```

If the item exists and `expiresAt > now()`, the circuit is open. The
governance sync logs `Governance intake skipped: Blockfrost circuit open
for ~N more min` on every invocation while open.

**Confirm Koios is taking over** (Phase B should mean the hot path doesn't
need Blockfrost at all):

```bash
aws logs tail /aws/lambda/drep-platform-prod-governance-intake-sync \
  --profile drep-platform --since 30m \
  | grep -E '(Koios|circuit|written|skipped)'
```

You want to see lines like `Governance intake: Koios returned 109
proposals` and `Governance intake complete: written=N skipped=M errors=0`.
If errors are non-zero, look at what's actually erroring.

**Resolution** — clear the circuit manually:

```bash
aws dynamodb delete-item \
  --profile drep-platform \
  --table-name drep-platform-prod-auth_nonces \
  --key '{"nonce": {"S": "_circuit:blockfrost"}}'
```

Then watch the next sync invocation log to confirm normal operation.

**Escalation**: if the circuit re-opens within 10 minutes, the underlying
Blockfrost project is over quota. Either upgrade the Blockfrost tier, or
verify Phase B (Koios primary) is fully working — only the legacy fallback
path should be hitting Blockfrost. Check `lib/circuitBreaker.ts` and
`sync/governance-intake.ts` for the trigger points.

---

## Sync errors

**Where to find logs**:

```bash
# Live tail
aws logs tail /aws/lambda/drep-platform-prod-governance-intake-sync \
  --profile drep-platform --follow

aws logs tail /aws/lambda/drep-platform-prod-drep-directory-sync \
  --profile drep-platform --follow

# Last hour
aws logs tail /aws/lambda/drep-platform-prod-governance-intake-sync \
  --profile drep-platform --since 1h
```

**Normal output (governance sync, every 60 s)**:

```
Governance intake: Koios returned 109 proposals
Governance intake: Koios vote_list returned 24123 votes across 109 proposals
Governance intake complete: written=2 enrichmentSkipped=107 errors=0; lookups: drep=1234/1234 pools=3145/3145 cc=7
```

**Normal output (directory sync, every 30 min)**:

```
Directory sync: drep_list returned 1843 (1421 registered, 422 retired)
Directory sync: 612/1843 DReps have an anchor
Directory sync: vote_list returned 24123 rows; 487 DReps have voted at least once
Directory sync: BatchGet returned 1843/1843 existing rows
Directory sync complete: total=1843 active=1029 inactive=392 retired=422 written=4 skippedFresh=1839 ...
```

**Abnormal — investigate**:
- `errors > 0` consistently (per-action `Failed to sync governance action`
  lines) -> read the per-error log to see which call failed.
- `written` is much higher than expected on a quiet cycle -> something is
  drifting; check `enrichmentVersion` matches what's deployed.
- `Koios unavailable` repeated -> Koios is down or rate-limiting; falls
  through to Blockfrost (which may then trip the circuit).

**Resolution**: most transient errors clear themselves within one cycle.
If the same action errors repeatedly for >10 cycles, look at the
`actionId` and walk the lookup chain (Koios `proposal_list` -> Blockfrost
fallback chain in `governance-intake.ts`).

**Escalation**: if errors persist after >30 min, page the owner.

---

## Cost spike

**Where to investigate first**:

1. AWS Cost Explorer — daily cost by service for the last 7 days.

```bash
aws ce get-cost-and-usage \
  --profile drep-platform \
  --time-period Start=$(date -u -v-7d +%Y-%m-%d),End=$(date -u +%Y-%m-%d) \
  --granularity DAILY \
  --metrics UnblendedCost \
  --group-by Type=DIMENSION,Key=SERVICE
```

2. Find the highest-spending service. Common culprits:

**DynamoDB write spike**:
- Cause: idempotency check broken in a sync, or schema migration writing
  every row.
- Investigate: CloudWatch metric `ConsumedWriteCapacityUnits` per table.
  Look for tables with sustained > 100 WCU/s.
- If it's `governance_actions` or `drep_directory`, check
  `enrichmentVersion` — a recent code deploy may have bumped it, forcing
  a one-time full rewrite. That's expected and ends in one cycle.

**Lambda runaway**:
- Cause: a handler in a tight error loop (e.g. throwing on every request,
  infinite retry from upstream).
- Investigate: CloudWatch metric `Invocations` per function. Look for
  spikes that don't match user traffic.
- Check `aws logs tail` on the suspect function for repeated stack traces.

**CloudFront egress spike**:
- Cause: someone scraping the SPA or API at high volume.
- Investigate: CloudFront `BytesDownloaded` metric. If it's the API
  distribution, also check WAF blocks (`BlockedRequests`).

**Blockfrost over-quota**:
- Cause: circuit breaker not opening, sync hammering 402s.
- See [Blockfrost circuit open](#blockfrost-circuit-open) above.
- The Blockfrost dashboard at blockfrost.io shows daily quota burn.

**Resolution**: depends on cause. For most spikes, redeploying the last
known-good commit clears it. For sustained, identify the hot path and fix
it (compare-then-write was a $2-4/day cost fix on a single sync — see
commits `1199e256` and `6608593f`).

**Escalation**: AWS Budgets at $5 (soft) and $20 (hard) email on threshold
crossings. If the hard limit is approached, redeploy last-known-good and
investigate after the bleeding stops.

---

## Deployment rollback

```bash
# Identify the bad commit
git log --oneline -20

# Revert (creates a new commit on top — preferred over reset --hard)
git revert <commit-sha>
git push origin main

# Redeploy infra (CDK)
cd infra
AWS_PROFILE=drep-platform npx cdk deploy --all --context stage=prod

# Redeploy frontend
cd ../frontend
VITE_API_BASE_URL=https://api.drep.tools npm run build
aws s3 sync dist/ s3://drep-platform-prod-frontend-REDACTED_ACCOUNT_ID/ \
  --profile drep-platform --delete
aws cloudfront create-invalidation \
  --profile drep-platform \
  --distribution-id <FrontendDistributionId> \
  --paths "/*"
```

The frontend distribution id is in the `DRepPlatform-Frontend-prod` stack
outputs (`DistributionId` export).

For a faster rollback that doesn't touch infra, just rebuild the previous
frontend commit and re-sync.

---

## Frontend showing stale data

**Cause**: CloudFront caches the SPA bundle aggressively. After a deploy,
old browsers may still hit the cached `/index.html` and load old asset
chunks.

**Investigate**:

```bash
# Inspect what CloudFront has cached for the SPA
curl -sI https://drep.tools/index.html | grep -E '(age|cache|x-cache)'
```

If `x-cache: Hit from cloudfront` and the build hash in the bundle is
old, the edge has stale.

**Resolution** — force-invalidate everything on the SPA distribution:

```bash
aws cloudfront create-invalidation \
  --profile drep-platform \
  --distribution-id <FrontendDistributionId> \
  --paths "/*"
```

Invalidations are free up to 1000/month. Takes 5-15 min to propagate.

**For API-side stale**, the same trick works on the API distribution:

```bash
aws cloudfront create-invalidation \
  --profile drep-platform \
  --distribution-id <ApiDistributionId> \
  --paths "/governance*" "/dreps*" "/epoch*"
```

But usually waiting for the 30s `s-maxage` to expire is faster than the
invalidation propagation.

---

## Wallet auth failing

**Common causes** (in order of likelihood):

### Network mismatch

The wallet is on `preprod` or `preview` but the API is `mainnet` (or vice
versa). The CIP-30 challenge will fail because the address doesn't match
the expected network.

**Check**: in browser DevTools, look at `POST /auth/verify` response. A
network mismatch surfaces as a 400 with a network-related error string.

**Fix**: switch the wallet to mainnet (Eternl: settings -> network ->
Mainnet).

### Mutation-nonce expired

Mutation nonces expire after 5 minutes. If the user composes a comment,
goes AFK for 10 min, then submits, the nonce is gone.

**Check**: mutation endpoints return 400 with body `{"error":"nonce expired
or invalid"}`.

**Fix**: the SPA auto-fetches a fresh nonce on each mutation submit. If a
user reports this, they're on a stale page — refresh fixes it.

### JWT cookie domain misconfigured

The cookie sets `Domain=.drep.tools`. If the user is hitting
`d31k3mmkrkmdvl.cloudfront.net` directly (the legacy non-custom-domain
URL), the cookie won't be sent.

**Check**: DevTools -> Application -> Cookies. The `access_token` cookie
should be present on `.drep.tools`.

**Fix**: redirect users to the custom domain. The CDK `customDomain`
config in `infra/bin/app.ts` is what controls this.

### CSP blocking wallet

CSP requires `'unsafe-eval'` for MeshSDK / vm-browserify. If the policy is
tightened without that exception, every wallet connect breaks immediately.

**Check**: browser DevTools -> Console -> look for CSP violations.

**Fix**: see `infra/lib/frontend-stack.ts:79-97`. The CSP is documented
inline — `'unsafe-eval'` is intentional and tracked in `QA_FINAL.md` for
future tightening.

### Debug commands

```bash
# Tail challenge / verify Lambda logs
aws logs tail /aws/lambda/DRepPlatform-Api-prod-AuthChallengeFn... \
  --profile drep-platform --follow

aws logs tail /aws/lambda/DRepPlatform-Api-prod-AuthVerifyFn... \
  --profile drep-platform --follow

# Check the auth_nonces table for live challenges
aws dynamodb scan \
  --profile drep-platform \
  --table-name drep-platform-prod-auth_nonces \
  --filter-expression '#k = :c' \
  --expression-attribute-names '{"#k":"kind"}' \
  --expression-attribute-values '{":c":{"S":"challenge"}}'
```

---

## DynamoDB throttling

**Symptom**: `ProvisionedThroughputExceededException` in handler logs;
clients see 5xxs.

**Cause** (with PAY_PER_REQUEST tables): the table is hot on a single
partition key faster than DynamoDB's adaptive capacity can scale.

**Investigate**:
- CloudWatch -> DynamoDB -> Throttled Requests metric per table. Spikes
  identify the offending table.
- If it's `governance_actions`, look at the partition key distribution:
  every action has a unique `actionId`, so single-partition hotness should
  be near-impossible. More likely: a hot read on a GSI like
  `status-submittedAt-index` where `status='active'` is the entire mainnet
  set on a single partition.

**Resolution options**:

1. Switch to provisioned capacity with auto-scaling for the hot table.
2. Add a write-shard prefix to the hot partition key.
3. Cache the hot read at the Lambda or CloudFront layer (often the right
   answer — the directory list cache solved this for `drep_directory`).

**Escalation**: see `RESUME.md` and the CDK code for prior decisions on
each table. PAY_PER_REQUEST is an explicit choice; switching to provisioned
is an architecture decision that should be documented in `docs/DECISIONS.md`.

---

## Cardano chain stalls / Koios outage

**Symptom**: governance sync logs `Koios unavailable` or `Koios returned 0
proposals`. Frontend shows stale "last updated" timestamps.

**First, verify it's actually a Koios problem**:

```bash
curl -s https://api.koios.rest/api/v1/tip | jq
# Healthy: returns recent {"hash": "...", "epoch_no": N, ...}
```

If Koios is healthy but our sync is failing, the bug is on our side — read
`sync/governance-intake.ts` logs for parse / network errors.

**If Koios is genuinely down**:

- Governance sync auto-falls-back to Blockfrost. Logs will show
  `falling back to Blockfrost-only path`. This is fine — it's expected
  degraded behavior.
- Directory sync has no fallback; it will skip the cycle. Existing rows
  remain visible but `lastVotedAt` etc. won't refresh.
- The /epoch endpoint has its own deterministic fallback (chain math), so
  user-visible "current epoch" stays accurate even with both providers
  down.

**Resolution**: wait. Koios is operated by stake pools and has multiple
operator-run instances (the public `api.koios.rest` is the meta-router).
Outages typically resolve in <1 hour.

**If outage extends past a few hours**:
- Verify the Blockfrost fallback is working (no circuit-open events).
- Consider temporarily lowering the directory sync cadence further to
  preserve cached data accuracy.
- Update the `RESUME.md` with notes for next session.

---

## Re-running historical syncs (schema migration)

Both syncs use `enrichmentVersion` as the schema-migration trigger. To
backfill all rows after a schema change:

1. Bump `ENRICHMENT_VERSION` in the sync source:
   - `backend/src/sync/governance-intake.ts:156`
   - `backend/src/sync/drep-directory.ts:108`
2. Update the version-history JSDoc comment with what changed.
3. Deploy:
   ```bash
   cd infra
   AWS_PROFILE=drep-platform npx cdk deploy DRepPlatform-Scheduler-prod \
     --context stage=prod
   ```
4. The next sync invocation (within ~1 minute for governance, ~30 min for
   directory) sees that every row's `enrichmentVersion !== current`, and
   re-enriches each one.

**One-time write spike is expected**: if `governance_actions` has 109 rows
and the version bump rewrites them all, that's 109 WCU. Trivial in
PAY_PER_REQUEST. The directory at ~2000 rows is also fine.

**If you want to force a re-run NOW** (don't wait for the EventBridge
cycle):

```bash
aws lambda invoke \
  --profile drep-platform \
  --function-name drep-platform-prod-governance-intake-sync \
  --payload '{}' \
  /tmp/sync-out.json && cat /tmp/sync-out.json

aws lambda invoke \
  --profile drep-platform \
  --function-name drep-platform-prod-drep-directory-sync \
  --payload '{}' \
  /tmp/sync-out.json && cat /tmp/sync-out.json
```

Note: `governance-intake-sync` retries 2x and has 10-min timeout;
`drep-directory-sync` retries 1x and has 5-min timeout. Set in
`scheduler-stack.ts`.

---

## Common HTTP error codes from the API

| Code | Where it comes from | Common cause |
|------|---------------------|--------------|
| 400 | Handler validation | Missing required field, malformed JSON, expired nonce |
| 401 | JWT authorizer Lambda | Cookie missing, expired, or signature invalid |
| 403 | JWT authorizer Lambda | Cookie valid but role check failed (role-guard.ts) |
| 404 | Handler / API Gateway | No row for the requested actionId / drepId, OR an unmapped route |
| 429 | API Gateway throttle | Stage-level burst (200) exceeded; rare |
| 502 | API Gateway -> Lambda | Lambda crashed (uncaught exception); read CloudWatch |
| 503 | WAF rate-limit | 2000 req / 5 min / IP exceeded; 5-min cooldown |
| 504 | API Gateway timeout | Handler ran past 30s (or 10s connect); usually upstream Koios/Blockfrost hang |

**Debug steps for any 5xx**:

```bash
# Find the handler's CloudWatch log group from the function arn
aws lambda list-functions \
  --profile drep-platform \
  --query 'Functions[?starts_with(FunctionName, `DRepPlatform-Api-prod`)].FunctionName' \
  --output text

# Tail the suspect handler
aws logs tail /aws/lambda/<FunctionName> \
  --profile drep-platform --since 15m
```

The structured response helpers in `backend/src/handlers/_response.ts`
emit predictable JSON bodies (`{"error": "...", "code": "..."}`) that the
SPA can match on. Check that file when adding new error paths.
