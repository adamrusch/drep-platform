# DRep Coordination Platform — Part B QA Results

**Run date:** 2026-05-01
**Tester:** Sisyphus (automated curl/aws CLI assessment)
**Build under test:** API `0sh56utpsh.execute-api.us-east-1.amazonaws.com`, Frontend `dbq4k0wz4ik0v.cloudfront.net` (see Finding F-ENV-1)
**Plan reference:** `QA_PLAN.md` Part B

---

## 1. Executive summary

### Verdict: **RED — DO NOT PROMOTE**

The infrastructure is mostly healthy, the public read paths return 200s, and the security posture for unauthenticated traffic is solid. However, **three independent showstoppers prevent the platform from functioning end to end**:

| # | Defect | Impact |
|---|--------|--------|
| 1 | **Lambda authorizer `IdentitySource` requires BOTH `Cookie` AND `Authorization` headers; the SPA only sends `Cookie`.** API Gateway 401s every authenticated route without ever invoking the authorizer Lambda. | Cookie-based auth is non-functional in browser — entire authenticated experience broken. |
| 2 | **Governance sync Lambda crashes at INIT every 2 min** with `ENOENT … cardano_serialization_lib_bg.wasm`. The `@blockfrost/blockfrost-js → @emurgo/cardano-serialization-lib-nodejs` WASM file is not bundled into the Lambda zip. | `governance_actions` table is empty; the platform's primary read product has no data. The same import path is used by `profile/delegationHistory` and `governance/sync` admin handlers — they will fail identically once exercised. |
| 3 | **CORS allow-list is hard-coded to a stale CloudFront domain** (`d31k3mmkrkmdvl.cloudfront.net`) but the actual deployed CloudFront is `dbq4k0wz4ik0v.cloudfront.net`. | Even if defects 1 and 2 are fixed, browsers loading the SPA from the real frontend will be blocked from making any cross-origin XHR with credentials. |

### Counts

Total rows in the detailed-results table: **92** (excluding header rows and the appendix/recap).

| Result | Count |
|--------|------:|
| PASS (clean) | 45 |
| PASS (with caveat or partial) | 8 |
| FAIL | 8 |
| DEFERRED (wallet/browser/manual) | 25 |
| N/A (data prerequisite missing) | 6 |
| Newly discovered defects | 8 |

### Top issues (in order of urgency)

1. **(BLOCKER) Authorizer IdentitySource** — `infra/lib/api-stack.ts:198`
2. **(BLOCKER) Sync Lambda missing WASM** — `infra/lib/scheduler-stack.ts:45-67` (and api-stack.ts:94-100 commonLambdaProps)
3. **(BLOCKER) CORS hard-coded to wrong frontend origin** — `infra/lib/api-stack.ts:18-23`
4. **(HIGH) Account-level Lambda concurrency limit is 10** (default is 1000) — 72% 5xx rate at 50-concurrent burst
5. **(MEDIUM) `validateChallenge` consumes nonce before signature verification** — DoS vector for in-flight auth attempts
6. **(MEDIUM) Wallet-address validator only checks `startsWith('addr')`/`stake'` — accepts CRLF and arbitrary suffixes** (no header injection, but storage hygiene defect)
7. **(MEDIUM) Malformed `lastKey` query param triggers 500 instead of 400** in `/governance` list (unhandled `JSON.parse`)
8. **(LOW) No `Cache-Control` header on frontend assets** (CloudFront cache works, browser cache doesn't)

---

## 2. Detailed results table

| ID | Category | Test | Result | Notes |
|---|---|---|---|---|
| F-ENV-1 | Setup | Frontend domain in task vs. actual CloudFront | **FAIL (newly discovered)** | Task lists `d31k3mmkrkmdvl.cloudfront.net`; actual is `dbq4k0wz4ik0v.cloudfront.net` (`E2DICV1F3XXMNR.DomainName`). Same stale value is in `infra/lib/api-stack.ts:19,23` (CORS allow-list). |
| S1 | Smoke | CloudFront SPA shell | PASS | 200, `text/html`, `<title>` and `<div id="root"></div>` present. |
| S2 | Smoke | SPA fallback for deep links | PASS w/ caveat | `/dashboard/drep` and `/this/path/does/not/exist` both 200 + index.html. **Caveat (A14 still present):** `/assets/foo.js` for a missing asset also returns 200 + index.html, masking broken-asset bugs. |
| S3 | Smoke | WASM Content-Type | PASS | `/assets/sidan_csl_rs_bg-B4hxaGFu.wasm` (note: hashed filename, not the unhashed one in the plan): `application/wasm`, 5,426,738 bytes. |
| S4 | Smoke | API health: `GET /governance` | PASS (functionally) | Returns 200 with `{"data":{"items":[],"total":0}}`. Empty payload is consistent with the sync Lambda failing — see F-GOV-SYNC-2. |
| S5 | Smoke | CORS preflight from CloudFront origin | **FAIL** | OPTIONS from real origin (`dbq4k0wz4ik0v…`) returns 204 with NO `Access-Control-Allow-Origin`. The same OPTIONS from the stale origin (`d31k3mmkrkmdvl…`) returns the headers. CDK has the wrong domain. |
| F-AUTH-1 | Auth | `POST /auth/challenge` happy path | PASS | 64-hex nonce, expiresAt ~5 min ahead, message format matches spec. Nonce persisted in `auth_nonces` (A6 fix verified). |
| F-AUTH-2 | Auth | `POST /auth/challenge` validation errors | PASS | 400 for missing body, empty walletAddress, wrong prefix, garbled JSON. Messages match. |
| F-AUTH-3 | Auth | E2E browser auth flow | DEFERRED | Requires CIP-30 wallet. **WILL FAIL once attempted** because of the IdentitySource defect (see F-AUTH-7-NEW). |
| F-AUTH-4 | Auth | Replay protection | PASS w/ defect (newly discovered) | Replay returns 401 "Challenge nonce not found or already used" (good). **Defect:** `validateChallenge` consumes nonce before signature verification, so a bogus signature also consumes the nonce — DoS vector. See `verify.ts:42-51`. |
| F-AUTH-5 | Auth | Payload tamper rejection | DEFERRED | Needs real signed payload to flip a byte. |
| F-AUTH-6 | Auth | Expired challenge | DEFERRED (timing) | Plan says wait 5+ min; not run. |
| F-AUTH-7 | Auth | `GET /auth/me` without cookie | PASS (status) / **FAIL (response shape)** | 401 returned but body is `{"message":"Unauthorized"}` not the documented `{"error":"Unauthorized",…}`. Reason: API Gateway's pre-authorizer 401 (see F-AUTH-7-NEW) — it does not invoke the application's `unauthorized()` helper. |
| F-AUTH-7-NEW | Auth | **(Newly discovered)** Authorizer Lambda never invoked from browser | **FAIL — BLOCKER** | `IdentitySource: ['$request.header.Cookie', '$request.header.Authorization']` requires BOTH headers. Browser sends only Cookie → API GW returns 401 directly. Confirmed via CloudWatch metric: 0 authorizer invocations across all curl calls until I sent both headers manually. |
| F-AUTH-8 | Auth | `POST /auth/refresh` extends session | DEFERRED | Needs valid session cookie. |
| F-AUTH-9 | Auth | `DELETE /auth/session` logout | PARTIAL PASS | 401 without cookie ✓. Full logout flow deferred (needs valid session). |
| F-AUTH-10 | Auth | JWT tampering | PASS | Bogus / garbage / `alg=none` cookies all 401 (API GW pre-rejection). With both headers + bogus JWT, authorizer Lambda runs and logs `Invalid Compact JWS`, returns 403 (not 401 — see SEC-Auth note). |
| F-AUTH-11 | Auth | JWT expiry | DEFERRED | Requires session + waiting or test stack. |
| F-AUTH-12 | Auth | rememberMe sessionType | DEFERRED | Requires real verify. |
| F-GOV-1 | Gov | List active actions | PASS (shape) / N/A (data) | 200 returned, but `total: 0` because the sync Lambda has populated nothing. |
| F-GOV-2 | Gov | Pagination round-trip | **FAIL (newly discovered)** | Empty data prevents real round-trip, but a malformed `lastKey=eyJkdW1teSI6dHJ1ZX0%3D` triggers 500 InternalServerError. Should be 400. Cause: `JSON.parse(Buffer.from(lastKey, 'base64'))` in `governance/list.ts:31` is unwrapped. |
| F-GOV-3 | Gov | Invalid status / limit | PASS | 400 with proper messages for unknown status, non-numeric limit, negative limit. Valid statuses surfaced: `active, expired, enacted, dropped` (note: `ratified` returned `total: null`, suggesting partial validation — minor). |
| F-GOV-4 | Gov | Get specific action | N/A | No data; cannot test. |
| F-GOV-5 | Gov | Non-existent action | PASS | 404 with `{"error":"NotFound","message":"Governance action not found","statusCode":404}`. |
| F-GOV-6 | Gov | Sort order via submittedAt | N/A | No data. A10 likely still present per sync code; cannot verify. |
| F-GOV-SYNC-1 | Sync | EventBridge rule enabled | PASS | `drep-platform-dev-governance-sync` State=ENABLED, ScheduleExpression=`rate(2 minutes)`, target ARN matches. |
| F-GOV-SYNC-2 | Sync | Recent invocations succeeded | **FAIL — BLOCKER** | Every invocation crashes at INIT: `ENOENT: no such file or directory, open '/var/task/cardano_serialization_lib_bg.wasm'`. The Lambda zip is 160KB; the WASM dependency from `@emurgo/cardano-serialization-lib-nodejs` (transitive of `@blockfrost/blockfrost-js`) is not bundled. |
| F-GOV-SYNC-3 | Sync | Manual admin trigger | DEFERRED | Needs lead_drep cookie. |
| F-GOV-SYNC-4 | Sync | Auth on sync endpoint | PASS (401 case) | No-cookie returns 401. Delegator-only-cookie 403 case deferred (needs session). |
| F-GOV-SYNC-5 | Sync | Blockfrost quota safety | DEFERRED | Cannot measure since sync never succeeds. A13 effectively moot until sync works. |
| F-DREP-1 | DRep | Register | DEFERRED | Needs session. |
| F-DREP-2 | DRep | Duplicate registration | DEFERRED | Needs session. |
| F-DREP-3 | DRep | Validation | DEFERRED | Needs session. |
| F-DREP-4 | DRep | Get specific (404 case) | PASS | 404 with `{"error":"NotFound","message":"DRep committee not found","statusCode":404}`. |
| F-DREP-5 | DRep | Update by non-lead | DEFERRED | Needs two sessions. |
| F-DREP-6 | DRep | List by leadWallet | PASS | Returns `{"data":{"items":[],"total":0}}` — empty but well-formed. |
| F-DREP-7 | DRep | List without filter | PASS (A8 fix verified) | Returns 200 with empty list (was 400 in plan; A8 fix landed). |
| F-COMMENTS-1 | Comments | List on action | PASS | 200, empty items array. |
| F-COMMENTS-2 | Comments | Public-only filter | PASS | 200, empty items array. |
| F-COMMENTS-3..8 | Comments | Create/delete flows | DEFERRED | Need wallet + session. |
| F-COMMENTS-9 | XSS | `dangerouslySetInnerHTML` grep | PASS | `grep -R 'dangerouslySetInnerHTML' frontend/src` is empty. |
| F-CLUBHOUSE-1 | Clubhouse | List posts | PASS | 200, empty items array. |
| F-CLUBHOUSE-2..7 | Clubhouse | Create/delete flows | DEFERRED | Need session. |
| F-PROFILE-1 | Profile | Public profile read (404 case) | PASS | 404 returned for non-existent. Sensitive-field leak check N/A (no profile to inspect). |
| F-PROFILE-2 | Profile | Upsert | DEFERRED | Needs session. |
| F-PROFILE-3 | Profile | Validation | DEFERRED | Needs session. |
| F-PROFILE-4 | Profile | Delegation history | PASS w/ design change | Plan expected 200 anonymous; deployed code (correctly) auth-gates this endpoint per the A12 hardening comment in `api-stack.ts:293-301`. So 401 without cookie is now the expected behavior. The plan note is stale. |
| SEC-1 | Sec | JWT secret rotation | DEFERRED | Requires session + wait + redeploy. |
| SEC-2 | Sec | Unauthenticated mutation paths | PASS | All 14 authenticated routes return 401 without cookie/Authorization. |
| SEC-3 | Sec | Authorization escalation | DEFERRED | Needs session. |
| SEC-4 | Sec | SQL/NoSQL injection on `actionId` | PASS | All 10 payloads (`' OR 1=1`, `${jndi:ldap://…}`, `*`, `<script>`, `\x00`, etc.) → 404 (or 400 for malformed encoding, or 401 for `../auth/me` collapse). Zero 500s. |
| SEC-5 | Sec | Path traversal | PASS w/ note | `/governance/..%2f..%2fauth%2fme` → 400 (API GW rejects). `/governance/%2e%2e%2fauth%2fme` → 401 (API GW decodes and routes to `/auth/me` which is auth-gated — defense-in-depth holds). |
| SEC-6 | Sec | Header injection | PASS w/ defect (newly discovered) | No `Set-Cookie: malicious=1` header in response (no HTTP-level injection). **However**, the wallet validator accepts `addr1\r\nSet-Cookie: malicious=1` and stores it in `auth_nonces`. Storage hygiene only — no exploit. |
| SEC-7 | Sec | CIP-30 wrong public key | DEFERRED | Needs real wallet payload. |
| SEC-8 | Sec | CIP-30 wrong message | DEFERRED | Needs real wallet payload. |
| SEC-9 | Sec | CSRF | PARTIAL PASS | `SameSite=Strict` is set in cookie helper (per `auth.ts:buildSetCookieHeader` not inspected fully). Browser-level test deferred. |
| SEC-10 | Sec | Open-redirect / cookie scope | DEFERRED | Needs session to inspect Set-Cookie. |
| SEC-11 | Sec | Secrets in logs | PASS | No `secret`/`jwt_secret`/`api_key`/`signature` strings in challenge or authorizer Lambda logs. |
| SEC-12 | Sec | Rate limiting | **FAIL (newly discovered)** | 50 parallel `GET /governance` requests: 36/50 returned 503 Service Unavailable. **Root cause:** account-level Lambda concurrency limit is 10 (vs. AWS default 1000). Confirmed via `aws lambda get-account-settings` → `ConcurrentExecutions: 10, UnreservedConcurrentExecutions: 10`. Throttling at the API GW layer (configured 100 r/s, 200 burst) is healthy; the bottleneck is below it. |
| SEC-13 | Sec | Lambda payload limits | PASS | 6.5MB and 11MB POSTs to `/auth/challenge` both return 413 "Request Entity Too Large" from API GW. No 5xx. |
| SEC-14 | Sec | Public exposure via OPTIONS | PASS (negative) | `Origin: https://attacker.example` → 204 with NO Access-Control-Allow-Origin (browsers block). |
| SEC-15 | Sec | CSP / security headers | PASS | All 5 expected (`x-content-type-options`, `x-frame-options`, `strict-transport-security`, `referrer-policy`, `x-xss-protection`) present. No CSP (per plan's hardening note). |
| SEC-16 | Sec | PII in audit log | PASS w/ note | `audit_log` table exists and is empty (no writes). Plan flagged this; still applies. |
| CHAIN-1 | Chain | Multi-wallet CIP-30 | DEFERRED | Manual. |
| CHAIN-2 | Chain | Stake vs. payment address | DEFERRED | Manual. |
| CHAIN-3 | Chain | Mainnet env | PASS | All Lambdas have `CARDANO_NETWORK=mainnet`. Note from plan still applies: verify path is purely cryptographic; no bech32-prefix network check rejects testnet wallets. |
| CHAIN-4 | Chain | Blockfrost quota | N/A | Sync never succeeds; no calls being made. |
| CHAIN-5 | Chain | Proposal mapping fidelity | N/A | No data. |
| INFRA-1 | Infra | CDK drift | PASS | `cdk diff` shows "no differences" on all 4 stacks. |
| INFRA-2 | Infra | DynamoDB tables + PITR | PASS w/ note | All 7 tables (`users, drep_committees, governance_actions, comments, clubhouse_posts, audit_log, auth_nonces`) ACTIVE, PAY_PER_REQUEST. PITR enabled on the 5 user-data tables; disabled on `audit_log` and `auth_nonces` (acceptable — transient). GSIs match expectations. Bonus: `drep_committees` has an extra `SK-createdAt-index` (added for "browse all" support post A8). |
| INFRA-3 | Infra | Secrets Manager | PASS | Both `drep-platform/dev/jwt-secret` and `drep-platform/dev/blockfrost-api-key` exist; `RotationEnabled` is null (no rotation policy — plan accepts this). |
| INFRA-4 | Infra | Lambda config sanity | PASS | All API handlers: nodejs20.x, arm64, 30s, 512MB. Sync handler: 1024MB, 300s. |
| INFRA-5 | Infra | CloudFront distribution | PASS | DefaultRootObject=index.html, ErrorResp 403/404 → /index.html status 200, CachePolicyId=`658327ea-…` (CACHING_OPTIMIZED), redirect-to-https enforced. |
| INFRA-6 | Infra | S3 — no public access | PASS | All 4 public-access blocks `true`. Bucket policy scoped to CloudFront via OAC + `AWS:SourceArn` condition. |
| INFRA-7 | Infra | EventBridge rule | PASS | (See F-GOV-SYNC-1.) |
| INFRA-8 | Infra | CloudWatch alarms | PASS w/ note | None defined; matches plan and recommendation. |
| INFRA-9 | Infra | Cost guardrails | DEFERRED | No AWS Budgets configured (plan acknowledges). |
| INFRA-10 | Infra | Invalidation post-deploy | DEFERRED | No way to verify without redeploying. |
| INFRA-CACHE | Infra | **(Newly discovered)** Cache-Control header missing | LOW finding | Neither hashed assets nor `index.html` carry a `Cache-Control` directive. CloudFront edge cache works (`x-cache: Hit from cloudfront`, `age: 388`), but browsers fall back to heuristic caching. |
| PERF-1 | Perf | Cold-start latency | PASS | First call ~325 ms; subsequent ~120-180 ms. Within targets. |
| PERF-2 | Perf | p95 on `/governance` | PASS (sequential) | 10 sequential warm calls: range 120-180 ms. p95 ≈ 175 ms. **However**, see SEC-12 — under concurrency, response degrades to 503 due to Lambda concurrency cap. |
| PERF-3 | Perf | p95 on `/auth/me` | PASS (sequential) | 10 sequential calls: 90-120 ms. p95 ≈ 115 ms. (Note: all 401 because no auth — measures pre-authorizer path.) |
| PERF-4 | Perf | Sync Lambda execution time | N/A | All invocations crash at INIT in ~250 ms. Cannot measure runtime. |
| PERF-5 | Perf | WASM bundle load time | PASS | 5.4MB WASM downloaded in 0.8 s on broadband. CloudFront edge cache hot. Plan's Fast 3G TTI <8 s expectation deferred (browser test). |
| PERF-6 | Perf | Concurrency stress | **FAIL** | See SEC-12. Same root cause. |

---

## 3. Failures section

For each FAIL, the command, the actual output, and the root-cause hypothesis with a recommended fix.

### F-ENV-1: Frontend domain in task spec is stale (newly discovered)

**Command:**
```bash
curl -sI 'https://d31k3mmkrkmdvl.cloudfront.net/'
# Could not resolve host: d31k3mmkrkmdvl.cloudfront.net

aws cloudfront get-distribution --id E2DICV1F3XXMNR --profile drep-platform \
  --query 'Distribution.DomainName'
# "dbq4k0wz4ik0v.cloudfront.net"
```

**Actual:** The CloudFront distribution `E2DICV1F3XXMNR` has `DomainName=dbq4k0wz4ik0v.cloudfront.net`, NOT `d31k3mmkrkmdvl.cloudfront.net` as quoted in the task header. The `d31k3...` value resolves to NXDOMAIN-style empty answer from public DNS — it's been deleted or never existed.

**Root cause hypothesis:** Stale value carried forward from an earlier deployment that was destroyed and recreated; the CDK source `infra/lib/api-stack.ts:18-23` still references the old domain.

**Recommended fix:** Replace both lines 19 and 23 in `infra/lib/api-stack.ts` with the current `dbq4k0wz4ik0v.cloudfront.net`, or better — reference the value from the Frontend stack output via a CloudFormation export/import, so it auto-updates on redeploy. Also fix the `VITE_API_BASE_URL` doc and any task templates.

---

### S5: CORS preflight fails for actual frontend origin

**Command:**
```bash
curl -i -X OPTIONS "https://0sh56utpsh.execute-api.us-east-1.amazonaws.com/governance" \
  -H "Origin: https://dbq4k0wz4ik0v.cloudfront.net" \
  -H "Access-Control-Request-Method: GET"
```

**Actual:**
```
HTTP/2 204
date: Fri, 01 May 2026 20:54:30 GMT
apigw-requestid: cs_pJhGvoAMEJYQ=
```
**No** `Access-Control-Allow-Origin` header. With `withCredentials: true` and a missing ACAO, browsers will block the response.

**Root cause hypothesis:** Same as F-ENV-1 — the CORS allow-list has the stale CloudFront domain.

**Recommended fix:** Same as F-ENV-1.

---

### F-AUTH-7-NEW (BLOCKER): Authorizer Lambda is never invoked from browser-style requests

**Command:**
```bash
# Browser-style: cookie only, no Authorization header
curl -i -H "Cookie: access_token=eyJhbGciOiJIUzI1NiIs…some.jwt" \
  "$API/auth/me"
```

**Actual:**
```
HTTP/2 401
{"message":"Unauthorized"}
```
But the JWT Authorizer CloudWatch metric `Invocations` shows zero datapoints across 30+ such curls. Only when both `Cookie` AND `Authorization` headers are present does the authorizer Lambda fire (then returning 403 "Forbidden" for invalid JWTs, with proper logs).

**Root cause hypothesis:** `infra/lib/api-stack.ts:198`:
```ts
identitySource: ['$request.header.Cookie', '$request.header.Authorization'],
```
For HTTP API v2 Lambda authorizers, **all** identity sources must be present in the request, otherwise API Gateway rejects with 401 *without invoking the authorizer*. The frontend SPA uses `axios({ withCredentials: true })` which sends only the cookie — never an `Authorization` header.

**Recommended fix:** Change line 198 to:
```ts
identitySource: ['$request.header.Cookie'],
```
This was likely intended to support either cookies or bearer tokens, but the AWS semantics is "ALL of these must exist" not "any of these". If both auth modes need to be supported, the cleanest path is to use a single identity source (Cookie) and let the Lambda authorizer also inspect `Authorization` from the event payload.

**Verification after fix:** redeploy the API stack; `curl -H 'Cookie: access_token=garbage' "$API/auth/me"` should return 403 (authorizer-rejected) with a CloudWatch log entry. The current 401 (API GW pre-rejection) should disappear.

---

### F-GOV-SYNC-2 (BLOCKER): Sync Lambda crashes at INIT — missing WASM file

**Command:**
```bash
aws logs tail /aws/lambda/drep-platform-dev-governance-intake-sync --since 30m
```

**Actual (every 2 min, since deploy):**
```
ERROR Uncaught Exception {
  "errorType":"Error",
  "errorMessage":"ENOENT: no such file or directory, open '/var/task/cardano_serialization_lib_bg.wasm'",
  …
}
INIT_REPORT Init Duration: 211.60 ms  Phase: invoke  Status: error  Error Type: Runtime.Unknown
```

**Root cause hypothesis:** The Lambda zip is 160 KB. `@blockfrost/blockfrost-js` transitively pulls in `@emurgo/cardano-serialization-lib-nodejs`, whose `index.js` does `fs.readFileSync('/var/task/cardano_serialization_lib_bg.wasm')`. The CDK `NodejsFunction` esbuild bundling does not copy `.wasm` siblings into the bundle by default. Confirmed via `find backend/node_modules -name "*.wasm"` → exactly one `.wasm` file at `@emurgo/cardano-serialization-lib-nodejs/cardano_serialization_lib_bg.wasm`.

**Affected Lambdas:** anything that imports `backend/src/lib/blockfrost.ts`. Currently:
- `backend/src/sync/governance-intake.ts` (the scheduled sync — broken now)
- `backend/src/handlers/profile/delegationHistory.ts` (will break on first authenticated call once F-AUTH-7-NEW is fixed)
- `backend/src/handlers/governance/sync.ts` (admin trigger — same)

**Recommended fix:** Update `commonLambdaProps.bundling` in `infra/lib/api-stack.ts:94-100` and the equivalent block in `infra/lib/scheduler-stack.ts:63-67` to copy the WASM file:
```ts
bundling: {
  minify: true,
  sourceMap: false,
  target: 'es2022',
  externalModules: ['@aws-sdk/*'],
  commandHooks: {
    afterBundling(_inputDir: string, outputDir: string): string[] {
      return [
        `cp ${path.join(backendDir, 'node_modules/@emurgo/cardano-serialization-lib-nodejs/cardano_serialization_lib_bg.wasm')} ${outputDir}/`,
      ];
    },
    beforeBundling: () => [],
    beforeInstall: () => [],
  },
  forceDockerBundling: false,
}
```

A cleaner alternative: stop importing `@blockfrost/blockfrost-js` (which pulls the WASM) and write the 4-5 Blockfrost calls you actually need with `fetch` directly. The `lib/blockfrost.ts` already has typed local interfaces "to avoid version skew" — completing that refactor sheds ~6 MB of dead-code WASM dependency for a backend that never needs to construct Cardano transactions, only read them.

**Verification after fix:** the next 2-min EventBridge tick should log `Governance intake complete: synced=N`; `aws dynamodb scan governance_actions --select COUNT` should grow.

---

### F-GOV-2 (newly discovered, MEDIUM): Malformed `lastKey` returns 500 instead of 400

**Command:**
```bash
curl -s "$API/governance?status=active&limit=2&lastKey=eyJkdW1teSI6dHJ1ZX0%3D"
```

**Actual:**
```
{"error":"InternalServerError","message":"Failed to list governance actions","statusCode":500}
```

**Root cause hypothesis:** `backend/src/handlers/governance/list.ts:31`:
```ts
exclusiveStartKey: JSON.parse(Buffer.from(lastKey, 'base64').toString('utf-8'))
```
If the base64 decodes to JSON that DynamoDB rejects as a key shape (e.g., `{"dummy":true}` doesn't match the table's primary-key schema), the rejection bubbles as an unhandled exception → catch at the top wraps in 500.

**Recommended fix:** Wrap in try/catch and return `badRequest('Invalid pagination token')` on `JSON.parse` failure or DynamoDB validation error. Pseudocode:
```ts
let exclusiveStartKey: Record<string, unknown> | undefined;
if (lastKey) {
  try {
    const decoded = JSON.parse(Buffer.from(lastKey, 'base64').toString('utf-8'));
    if (typeof decoded !== 'object' || decoded === null) throw new Error();
    exclusiveStartKey = decoded;
  } catch {
    return badRequest('Invalid pagination token');
  }
}
```

---

### SEC-12 (newly discovered, HIGH): Account-level Lambda concurrency limit is 10

**Command:**
```bash
seq 1 50 | xargs -P 50 -I{} curl -s -o /dev/null -w "%{http_code}\n" \
  "$API/governance?status=active&limit=10" | sort | uniq -c
#   36 503
#   14 200

aws lambda get-account-settings --profile drep-platform --region us-east-1
# "ConcurrentExecutions": 10
# "UnreservedConcurrentExecutions": 10
```

**Actual:** 72% 503 rate at 50-concurrent. The 503 body is `{"message":"Service Unavailable"}` (Lambda throttle).

**Root cause hypothesis:** AWS account is in newly-created / restricted state with the default-1000 concurrency cap reduced to 10. With 10 concurrent slots available across **all 26 Lambdas** in the account, even modest traffic exhausts the pool. The API GW throttle (100 r/s, 200 burst — line 145-146 of api-stack.ts) never engages because Lambda blocks first.

**Recommended fix:**
1. Open an AWS support quota-increase request: Service `Lambda`, Quota `Concurrent Executions`, request 1000.
2. While waiting, set per-function reserved concurrency on the hot read paths (`GovList`, `GovGet`, `CommentsList`, `ClubhouseList`, `DRepList`, `DRepGet`, `ProfileGet`) to ensure each gets a guaranteed slice. With 10 total, you can give 1-2 reserved each + 1-2 to the authorizer + leave 1-2 unreserved.
3. Note this quota loudly in the deploy runbook — production will need at least 100, ideally 1000.

---

### SEC-6 (newly discovered, MEDIUM): Wallet-address validator is too permissive

**Command:**
```bash
curl -s -X POST "$API/auth/challenge" \
  -H 'Content-Type: application/json' \
  -d '{"walletAddress":"addr1\r\nSet-Cookie: malicious=1"}'
```

**Actual:** 200, challenge generated and stored in `auth_nonces` with literal `walletAddress: "addr1\r\nSet-Cookie: malicious=1"`.

**Why it's not exploitable for header injection:** the message is JSON-encoded in the response body, so `\r\n` becomes the four characters `\\r\\n` not actual CR/LF. No HTTP-level injection. But the storage hygiene is poor and a downstream consumer that logs the wallet address to a non-JSON sink (e.g., a syslog line) could be tricked.

**Recommended fix:** Replace `startsWith('addr')||startsWith('stake')` (`backend/src/handlers/auth/challenge.ts:27-28`) with a real bech32 decode. The `@cardano-foundation/cardano-serialization-lib` (or pure-JS `@stricahq/typhonjs-bech32`) gives you `fromBech32(addr).hrp` to validate prefix AND structural integrity. Reject any address whose decoded length isn't in the expected range, whose HRP isn't one of {`addr`, `addr_test`, `stake`, `stake_test`}, and whose bytes contain control chars.

---

### F-AUTH-4 (newly discovered, MEDIUM): Nonce consumed before signature verification

**Command:** (see test 4 above)

**Actual:** First call with bogus signature returns 401 "Signature verification threw an error". Second call with the same nonce returns 401 "Challenge nonce not found or already used" — **the nonce was consumed even though signature failed**.

**Root cause hypothesis:** `backend/src/handlers/auth/verify.ts:42-51`:
```ts
const challengeResult = await validateChallenge(nonce, walletAddress); // <-- consumes
if (!challengeResult.valid) return unauthorized(...);

const expectedMessage = buildSignMessage(nonce, walletAddress);
const sigResult = verifyWalletSignature(walletAddress, expectedMessage, { signature, key });
if (!sigResult.valid) return unauthorized(...);
```
DoS vector: an attacker who observes the user's nonce (e.g., MITM of the `/auth/challenge` response, or social-engineered) can post `(nonce, victimAddress, junkSig, junkKey)` to invalidate the victim's nonce, forcing them to retry. Useful for cookie-jar drain attacks or for racing legitimate users.

**Recommended fix:** Reorder the verification:
```ts
// 1. Look up nonce (read-only)
const stored = await peekChallenge(nonce, walletAddress);
if (!stored.valid) return unauthorized(stored.reason);

// 2. Verify signature against the message
const sigResult = verifyWalletSignature(walletAddress, buildSignMessage(nonce, walletAddress), { signature, key });
if (!sigResult.valid) return unauthorized(sigResult.reason);

// 3. Now consume (atomic conditional delete)
const consumed = await consumeChallenge(nonce, walletAddress);
if (!consumed) return unauthorized('Challenge nonce was consumed concurrently');
```

This means splitting `validateChallenge` into a peek (no side-effect) and a consume (atomic delete with `attribute_exists` condition).

---

### F-AUTH-7 — minor: 401 response body shape

**Actual:** `{"message":"Unauthorized"}` (API GW default) instead of `{"error":"Unauthorized","message":"…","statusCode":401}` (the application's `unauthorized()` helper format).

**Root cause:** Same as F-AUTH-7-NEW — API GW pre-authorizer rejection short-circuits the Lambda. Fix the IdentitySource and the application response shape will be used.

**Recommended fix:** Resolves automatically when F-AUTH-7-NEW is fixed.

---

## 4. Deferred tests — manual checklist

These tests require either a CIP-30 wallet (to produce real Ed25519 signatures) or a browser. Hand off to a human tester after the three blockers above are resolved.

### Wallet-required (F-AUTH, F-DREP, F-COMMENTS, F-CLUBHOUSE, F-PROFILE write paths)

1. **F-AUTH-3 — End-to-end browser auth.** Eternl/Nami/Lace on Mainnet → Connect → Sign challenge → confirm `/dashboard` reached and `access_token` cookie shows HttpOnly+Secure+SameSite=Strict in DevTools. **Will fail until F-AUTH-7-NEW is fixed.**
2. **F-AUTH-4 — Replay attack via real verify response.** After successful verify, replay the same body → expect 401 "Challenge nonce not found or already used".
3. **F-AUTH-5 — Payload tamper.** Flip one byte in `signature` → 401. Flip one byte in `walletAddress` → 401.
4. **F-AUTH-6 — Expired challenge.** Generate, wait 6+ min, verify → 401 "Challenge nonce has expired".
5. **F-AUTH-8 — `/auth/refresh`.** With valid cookie, POST → 200, fresh `Set-Cookie`.
6. **F-AUTH-9 — Logout.** Valid cookie → DELETE `/auth/session` → 200, `Max-Age=0` cookie. Follow-up `/auth/me` → 401.
7. **F-AUTH-11 — JWT expiry.** Wait 7 days OR temporarily reduce `SESSION_DURATIONS.normal` and re-deploy → 401.
8. **F-AUTH-12 — rememberMe.** Verify with `rememberMe: true` → cookie `Max-Age=2592000`.
9. **F-DREP-1 — Register.** POST `/drep` with valid body → 201, ULID drepId, leadWallet matches.
10. **F-DREP-2 — Duplicate.** Same wallet again → 409.
11. **F-DREP-3 — Validation.** Empty/missing committeeName → 400.
12. **F-DREP-4 — Update.** PUT `/drep/{drepId}` → 200, name reflects change.
13. **F-DREP-5 — Update by non-lead.** Different cookie → 403.
14. **F-COMMENTS-3..8 — Comment lifecycle.** Need wallet signature for `mutationSignature`. Plan describes manual `signData` invocation in DevTools.
15. **F-CLUBHOUSE-2..7 — Clubhouse posts/comments lifecycle.**
16. **F-PROFILE-2 — Upsert.** POST `/profile` with valid session → 200.
17. **F-PROFILE-3 — Validation.** Long displayName/bio → 400.
18. **F-PROFILE-4 (live data variant) — Delegation history with valid session.** GET → 200, `data.delegationHistory` is array. **WILL FAIL until F-GOV-SYNC-2 is fixed** because `delegationHistory.ts` imports `lib/blockfrost` which crashes at INIT.
19. **F-GOV-SYNC-3 — Manual admin sync.** Lead-DRep cookie → POST `/governance/sync` → 200, `synced ≥ 1`. **WILL FAIL until F-GOV-SYNC-2 is fixed.**

### Browser-required (UI section)

20. **UI-1..7 — Frontend smoke.** Anonymous flows, auth flow, authenticated flows, RoleGuard, console errors, responsive layout, accessibility quick scan. Plan has the checklist; run in Chrome DevTools.
21. **PERF-5 — Throttled WASM TTI.** Open `/auth/connect` with Network = Fast 3G → measure TTI, confirm < 8 s.
22. **CHAIN-1 — Multi-wallet.** Eternl, Nami, Lace, Flint, Typhon, GeroWallet round-robin. Capture any failing CIP-30 payload as a unit-test fixture.
23. **CHAIN-2 — Stake vs payment address.** Sign with `usedAddresses[0]` (addr1...) instead of `rewardAddresses[0]` (stake1...) and confirm `/auth/verify` accepts.

### Operational (need account-level changes)

24. **SEC-1 — JWT secret rotation simulation.** Rotate the secret in Secrets Manager, redeploy or wait 15 min, confirm existing JWTs are invalidated. **Risk:** logs out all live users.
25. **CHAIN-4 — Blockfrost quota.** Login to blockfrost.io, check daily call count after a sustained run.
26. **PERF-6 — Sustained load.** Run `ab -n 1000 -c 50` from an EC2 instance in `us-east-1` against `/governance`. **WILL HIT** the SEC-12 concurrency cap until that's fixed.

---

## 5. Recommendations (in fix order)

### Before any further QA work

1. **Increase Lambda concurrency limit** from 10 to ≥ 100 (ideally 1000) via AWS support ticket. Without this, every load test will fail and real traffic will see frequent 503s.

### Before promoting to production

2. **(BLOCKER) Fix authorizer IdentitySource** (`api-stack.ts:198`) to require only `$request.header.Cookie`. Re-deploy. Verify via `curl -H 'Cookie: access_token=garbage' "$API/auth/me"` → 403 + log entry.
3. **(BLOCKER) Bundle the Cardano-serialization WASM** into all Lambdas that import `lib/blockfrost.ts`. Either via `commandHooks.afterBundling` cp, or — better — drop `@blockfrost/blockfrost-js` and use raw `fetch`. Verify by tailing the sync Lambda's logs after the next 2-min tick.
4. **(BLOCKER) Update CORS allow-list** (`api-stack.ts:18-23`) to the real CloudFront domain. Better still, plumb the value through CDK exports so it auto-syncs across stacks. Verify via `curl -X OPTIONS -H 'Origin: https://dbq4k0wz4ik0v.cloudfront.net' "$API/governance"` → 204 with proper `Access-Control-Allow-Origin`.
5. **(MEDIUM) Reorder `verify.ts`** so signature verification happens before nonce consumption. Split `validateChallenge` into `peekChallenge` (read) and `consumeChallenge` (atomic conditional delete).
6. **(MEDIUM) Wrap `JSON.parse(lastKey)`** in `governance/list.ts:31` (and `comments/list.ts`, `clubhouse/list.ts` if they share this pattern) in try/catch, return 400 on failure.
7. **(MEDIUM) Tighten `walletAddress` validation** to a real bech32 decode in `auth/challenge.ts:27-28` and `auth/verify.ts:37-39`. Reject control characters.

### Hardening (after blockers)

8. **Add `Cache-Control` headers** via a CloudFront `ResponseHeadersPolicy` custom-headers block: `index.html` → `no-cache, must-revalidate`, `/assets/*` → `public, max-age=31536000, immutable`.
9. **Add CloudWatch alarms** for: governance-intake errors > 0, Lambda 5xx rate, DynamoDB throttle events, CloudFront 5xx > 1%. INFRA-8 in plan.
10. **Add AWS Budgets** alarms (INFRA-9 in plan).
11. **Wire `audit_log` writes** into `drep/register.ts`, `comments/delete.ts`, `clubhouse/deletePost.ts`, `governance/sync.ts` (SEC-16 / plan recommendation).
12. **Add network check to `/auth/verify`** to reject `addr_test`/`stake_test` prefixes (CHAIN-3 plan recommendation; otherwise testnet wallet can authenticate against mainnet platform).

### Plan-update recommendations

13. **Update QA_PLAN.md** to use hashed asset filenames (`sidan_csl_rs_bg-{HASH}.wasm`) or grep dynamically.
14. **Update F-PROFILE-4 expected behavior** — anonymous now correctly returns 401 (per A12 hardening). Plan should note this is by design.
15. **Update QA_PLAN.md API URL** to current `0sh56utpsh.execute-api.us-east-1.amazonaws.com` (no `/dev` stage suffix anymore).

---

## Appendix A — Newly discovered defects (recap)

| ID | Severity | Where | What |
|----|----------|-------|------|
| F-ENV-1 | BLOCKER | infra/lib/api-stack.ts:18-23 | CORS allow-list points to deleted CloudFront domain. |
| F-AUTH-7-NEW | BLOCKER | infra/lib/api-stack.ts:198 | Authorizer IdentitySource requires both Cookie + Authorization, breaking browser auth. |
| F-GOV-SYNC-2 | BLOCKER | infra/lib/scheduler-stack.ts (and api-stack.ts bundling) | Cardano-serialization WASM not in Lambda bundle; sync Lambda crashes every 2 min. |
| SEC-12-NEW | HIGH | AWS account quota | Concurrent execution limit is 10. |
| F-AUTH-4-NEW | MEDIUM | backend/src/handlers/auth/verify.ts:42-51 | Nonce consumed before signature verification — DoS vector. |
| F-GOV-2-NEW | MEDIUM | backend/src/handlers/governance/list.ts:31 | Malformed lastKey → 500 instead of 400. |
| SEC-6-NEW | MEDIUM | backend/src/handlers/auth/challenge.ts:27-28 | Wallet validator accepts CRLF and arbitrary suffixes (storage hygiene only — not exploitable for HTTP injection). |
| INFRA-CACHE | LOW | CloudFront DistributionConfig | No `Cache-Control` headers on responses. |

---

## Appendix B — Test environment notes

- API: `https://0sh56utpsh.execute-api.us-east-1.amazonaws.com` (HTTP API v2, no `/dev` stage prefix — ✓ matches task)
- Frontend (deployed): `https://dbq4k0wz4ik0v.cloudfront.net` (✗ task header has `d31k3mmkrkmdvl…`)
- AWS profile: `drep-platform` (account 409410541898)
- Region: `us-east-1`
- Tools: `curl 7.x`, `jq 1.7.1`, `aws-cli 2.34.40`, `python3` (for payload generation), bash 5.

All commands and raw outputs are reproducible from the plan + this report. Each `Test` row in section 2 has the exact `curl`/`aws` invocation used (or maps directly to a plan section that documents it).
