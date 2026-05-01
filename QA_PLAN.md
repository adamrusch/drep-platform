# DRep Coordination Platform — QA Plan

**Target environment:** dev stack (live)
**Frontend:** https://d31k3mmkrkmdvl.cloudfront.net
**API:** https://i9la4x29c6.execute-api.us-east-1.amazonaws.com/dev
**AWS account:** 409410541898 (us-east-1, profile `drep-platform`)
**Date:** 2026-05-01

This plan was assembled by reading the actual implementation under `/Users/admin/Developer/drep-platform/`. It is structured into two parts:

1. **Part A — Pre-execution remediation.** Defects found during the code review that will cause whole categories of tests to fail or that fundamentally undermine the validity of any green test result. Fix these before running the rest of the plan.
2. **Part B — QA execution.** Functional, security, blockchain/wallet, infrastructure, and performance tests with concrete commands and expected outcomes.

A glossary, environment-variable cheatsheet, and a recommended execution order are at the bottom.

---

## Part A — Issues to fix BEFORE executing the QA plan

These are not test concerns. They are correctness defects identified by reading the deployed source. Running the QA plan against the current build will produce confusing red results because the system can't function as designed.

### A1. (BLOCKER) Lambda authorizer wired as `TokenAuthorizer` against a REST API but written for HTTP API v2

**Location:** `infra/lib/api-stack.ts:157-162` and `backend/src/middleware/jwt-authorizer.ts`.

**What the code does:**
- `api-stack.ts` creates `apigateway.RestApi` (REST API v1) and a `apigateway.TokenAuthorizer` with `identitySource: 'method.request.header.Authorization'`.
- `jwt-authorizer.ts` types its event as `APIGatewayRequestAuthorizerEventV2` (HTTP API v2) and returns `{ isAuthorized: true, context: {...} }` — the simple-authorizer response shape, which only HTTP API v2 understands.

**Why every authenticated route will fail:**
- A `TokenAuthorizer` invokes Lambda with an `APIGatewayTokenAuthorizerEvent` — no `event.headers`, no `event.cookies`. `extractToken()` reads `event.headers?.['authorization']`, so `event.headers` is `undefined` → returns `null` → `{ isAuthorized: false }` (best case) or the function throws (likely case, given the optional chaining).
- Even if it returned a value, REST API expects a `policyDocument`-shaped IAM policy, not `{ isAuthorized }`. API Gateway will reject the response and 500 every authenticated request.
- Downstream handlers read `event.requestContext.authorizer.jwt.claims` (`role-guard.ts:15`), but REST API delivers authorizer context at `event.requestContext.authorizer.<key>` directly with no `.jwt.claims` nesting. Even if the authorizer worked, `extractAuthContext` would throw `AuthorizationError('No authorizer context found')`.

**Remediation (pick ONE; option 1 is least invasive):**

1. **Switch ApiStack to `apigatewayv2-alpha` HTTP API** with `HttpJwtAuthorizer`/`HttpLambdaAuthorizer` and version `'2.0'`. Matches the handler types already in `backend/`. Recommended.
2. Keep REST API but rewrite `jwt-authorizer.ts` to accept `APIGatewayTokenAuthorizerEvent`/`APIGatewayRequestAuthorizerEvent`, return an IAM policy document, and rewrite `extractAuthContext` to read `event.requestContext.authorizer.<key>`.

Until this is fixed, do not bother executing test sections **F-AUTH**, **F-DREP-WRITE**, **F-COMMENTS-WRITE**, **F-CLUBHOUSE-WRITE**, **F-PROFILE-WRITE**, or **F-GOV-SYNC**.

### A2. (BLOCKER) `TokenAuthorizer.identitySource = 'method.request.header.Authorization'` makes cookie-based auth physically impossible

**Location:** `infra/lib/api-stack.ts:159`.

A `TokenAuthorizer` requires a non-empty value at the configured identity source before API Gateway will even invoke the authorizer. Browsers will only ever send the `Cookie` header; they will not synthesize an `Authorization` header. The frontend (`api.ts` uses `withCredentials: true`, no `Authorization` header) will get 401 from API Gateway directly without the authorizer running.

**Remediation:** as part of A1, switch to `RequestAuthorizer`/HTTP API v2 authorizer with `identitySources: ['$request.header.Cookie']` (HTTP API) or pass the cookie via the request authorizer (REST API). Disable `resultsCacheTtl` for cookie-keyed identity, or set the identity source to the cookie itself so cache invalidation tracks it.

### A3. (BLOCKER) `/auth/session` logout: frontend uses GET, backend exposes DELETE

**Locations:**
- Frontend: `frontend/src/auth/useWalletAuth.ts:112` — `await apiGet('/auth/session');`
- Backend: `infra/lib/api-stack.ts:174` — `r('/auth/session').addMethod('DELETE', integ(logoutFn), authOptions);`

**Effect:** logout will always 403/405. Cookie is never cleared server-side. The Zustand store is wiped client-side, but the JWT remains valid until natural expiry; if the user re-logs-in on another machine, the old cookie still authorizes API calls.

**Remediation:** change `useWalletAuth.ts` to `await apiClient.delete('/auth/session')` (or change the backend route to GET).

### A4. (BLOCKER) Mutation nonce is required by `comments/create` but no endpoint issues one

**Locations:**
- `backend/src/handlers/comments/create.ts:48-66` — requires `mutationNonce`, `mutationSignature`, `mutationKey`; calls `validateMutationNonce` which only succeeds for nonces previously created by `generateMutationNonce`.
- `backend/src/lib/auth.ts:289-324` — `generateMutationNonce` exists.
- `infra/lib/api-stack.ts` — no route maps to a handler that calls `generateMutationNonce`. Grep confirms there is no `/auth/mutation-nonce` or similar.

**Effect:** every authenticated `POST /comments/{actionId}` returns 401 ("Mutation nonce not found or already used").

**Remediation:** add a `POST /auth/mutation-nonce` Lambda + route that calls `generateMutationNonce(authCtx.walletAddress)` and returns `{ nonce, message, expiresAt }`. Frontend then signs the message with CIP-30 and includes the three fields in the comment payload. This is also a **shared-state correctness bug** — see A6.

### A5. (HIGH) CORS: `allow-origin: *` with `allow-credentials: true` is invalid; browsers will block

**Locations:**
- `infra/lib/api-stack.ts:148-153` — `allowOrigins: apigateway.Cors.ALL_ORIGINS, allowCredentials: true`.
- `backend/src/handlers/_response.ts:5-8` — `'Access-Control-Allow-Origin': process.env['CORS_ORIGIN'] ?? '*'`, `'Access-Control-Allow-Credentials': 'true'`.

Per the CORS spec, when `Access-Control-Allow-Credentials: true`, `Access-Control-Allow-Origin` MUST be a specific origin (not `*`). All browser-driven authenticated calls will be blocked at the CORS preflight stage.

**Remediation:** set `CORS_ORIGIN` env var on every Lambda to `https://d31k3mmkrkmdvl.cloudfront.net` (and to the dev preview domain as needed); change `defaultCorsPreflightOptions.allowOrigins` in CDK to the explicit origin list. Re-deploy.

### A6. (HIGH) In-memory nonce stores will not work on Lambda

**Location:** `backend/src/lib/auth.ts:42` (`challengeStore`) and `:287` (`mutationNonceStore`).

A Lambda function instance lives in its own memory. EventBridge concurrency, traffic spikes, scheduled scaling, or a cold start between `/auth/challenge` and `/auth/verify` will land the verify call on a different instance that has no record of the nonce. Even today on quiet traffic, you will get intermittent "Challenge nonce not found or already used" errors that are not user error.

**Remediation:** replace both `Map`s with a DynamoDB table (suggested name `${TABLE_PREFIX}auth_nonces`, partition key `nonce`, TTL attribute pointing to `expiresAt` epoch seconds). The TTL handles cleanup. Single-use semantics: use `PutItem` with `ConditionExpression: 'attribute_not_exists(nonce)'` to insert, and `DeleteItem` with `ReturnValues: 'ALL_OLD'` (or a transactional read-then-conditional-delete) to atomically consume.

**This is not optional** — without it, auth and mutation flows are flaky in production no matter how green the tests look.

### A7. (HIGH) Authorizer event-shape and DynamoDB schema bug shadow the same flaws (related to A1)

When you fix A1, also verify that `extractAuthContext`'s `event.requestContext.authorizer.jwt.claims` path matches whatever authorizer you choose. For HTTP API v2 simple-response Lambda authorizer, the path is `event.requestContext.authorizer.lambda.<key>`, NOT `.jwt.claims`. For HTTP API v2 JWT authorizer, it IS `.jwt.claims` — but you can't use that for cookie-based sessions.

**Recommendation:** use HTTP API v2 + Lambda authorizer + `event.requestContext.authorizer.lambda` and update `role-guard.ts` accordingly.

### A8. (HIGH) `GET /drep` always 400s

**Location:** `backend/src/handlers/drep/list.ts:27-31`. When `leadWallet` is not provided, the handler returns `badRequest('Either leadWallet query parameter is required, or use pagination. Full table scan is disabled — specify leadWallet to filter.')`. There is no other code path.

**Effect:** the DRep discovery page (and any landing experience listing DReps) cannot load.

**Remediation options:**
- Add a real listing path that uses a dedicated GSI keyed on something like `entityType` (constant `'DREP'`) sorted by `createdAt`, then `Query` that GSI.
- Or, accept a `leadWallet` filter as the only listing mode and update the frontend not to call `GET /drep` without one.

### A9. (HIGH) `epochDeadline-index` will hot-partition on `epochDeadline=0`

**Locations:**
- `infra/lib/database-stack.ts:74-79` — GSI partition key is `epochDeadline` (NUMBER).
- `backend/src/lib/blockfrost.ts:209` — `epochDeadline: raw.expiration ?? 0`.

When Blockfrost returns proposals with `expiration: null`, every record lands on the same partition (`0`). DynamoDB's adaptive capacity will mitigate this on PAY_PER_REQUEST, but you'll throttle under burst.

**Remediation:** drop this GSI (it is not used by any handler — a code search confirms), or change the partition key to a bucketed value like `epochDeadlineBucket = Math.floor(epochDeadline / 100)` and use a sort key for the precise epoch.

### A10. (MEDIUM) `governance/list` queries `status-submittedAt-index` but `submittedAt` is set to `new Date(0).toISOString()`

**Location:** `backend/src/lib/blockfrost.ts:206` — `submittedAt: new Date(0).toISOString()`.

Every governance action gets the same `submittedAt`. Sorting by submission time within a status returns deterministic-but-meaningless order. The frontend will display proposals in lexicographic order of action ID instead of chronological order.

**Remediation:** populate `submittedAt` from the on-chain transaction time. Blockfrost exposes the block time of the proposal-submitting transaction via `txs/:tx_hash` — fetch and store. Alternatively, store the epoch in which the proposal was first ingested and sort by that.

### A11. (MEDIUM) `clubhouse/createPost` accepts role `delegator`, defeating the membership restriction

**Location:** `backend/src/handlers/clubhouse/createPost.ts:24` — `requireRole(authCtx, 'lead_drep', 'committee_member', 'trusted_delegator', 'delegator');`. Every authenticated user has `delegator` (default in `verify.ts:70`), so the role check is a no-op. The membership check at line 54 is the only real gate, but the DRep-post flag at line 62 trusts the global `roles` array, not membership in this specific committee.

**Remediation:** drop `'delegator'` from `requireRole` (line 24), or remove the call entirely and rely on the explicit membership check below. Set `isDRepPost` based on whether the caller's `walletAddress` matches `committee.leadWallet` or appears in `committee.members` with role `lead_drep`/`committee_member` for **this** committee.

### A12. (MEDIUM) Public profile delegation-history endpoint hits Blockfrost on every request — DoS amplifier

**Location:** `backend/src/handlers/profile/delegationHistory.ts:28-34` — unauthenticated GET; for every stake address a Blockfrost API call is made. With a free-tier 50k req/day limit and a 2-minute sync already running, an attacker scripting requests against this endpoint with random stake addresses can drain the Blockfrost quota and break the sync.

**Remediation:**
- Cache Blockfrost account info in DynamoDB with a short TTL (e.g., 60–300s). Return cached value when fresh.
- Add a per-IP rate limit at API Gateway (usage plan + API key, or WAF rate-based rule).

### A13. (MEDIUM) Governance sync paginates ALL pages every 2 minutes

**Location:** `backend/src/sync/governance-intake.ts:24-81`. The sync walks every page until Blockfrost returns < 100 items. With N proposals, every cycle costs `ceil(N/100) + 1` Blockfrost calls plus N DynamoDB GetItem + PutItem pairs. If N grows past a few hundred, Blockfrost free-tier 10 r/s is hit and the function backs off via the SDK's retry settings, extending wall time.

**Remediation:**
- After cold-start backfill, switch to incremental sync: track the highest-seen `actionId` (or block height of latest proposal) in a metadata item; only page until you've encountered known IDs.
- Increase EventBridge cadence (every 10–15 minutes is plenty for governance).
- Wrap the Blockfrost client in a token-bucket limiter (e.g., 8 req/s) to stay under the 10 req/s free-tier ceiling.

### A14. (MEDIUM) WASM `Content-Type` is set by S3, not CloudFront — verify the upload step

**Locations:** `infra/lib/frontend-stack.ts` (S3 + OAC + CloudFront), and the (out-of-CDK) Vite build/upload script.

CloudFront with OAC just streams the S3 object, including its `Content-Type`. If the upload (`aws s3 cp`/`s3 sync`) didn't set `--content-type application/wasm`, browsers will refuse to instantiate the WASM module ("Incorrect MIME type").

**Remediation (verification step + fix):**
```bash
aws s3 ls s3://drep-platform-dev-frontend-409410541898/ --recursive --profile drep-platform | grep -i '\.wasm$'
aws s3api head-object \
  --bucket drep-platform-dev-frontend-409410541898 \
  --key assets/sidan_csl_rs_bg.wasm \
  --profile drep-platform | jq .ContentType
```

If `ContentType` is not `application/wasm`, re-upload that single file:
```bash
aws s3 cp \
  ./frontend/dist/assets/sidan_csl_rs_bg.wasm \
  s3://drep-platform-dev-frontend-409410541898/assets/sidan_csl_rs_bg.wasm \
  --content-type application/wasm \
  --profile drep-platform
```

Then invalidate CloudFront for that path:
```bash
aws cloudfront create-invalidation \
  --distribution-id E2DICV1F3XXMNR \
  --paths '/assets/sidan_csl_rs_bg.wasm' \
  --profile drep-platform
```

### A15. (LOW) Cookie `SameSite=Strict` will break OAuth-style callbacks if you ever add them

`auth.ts:276` sets `SameSite=Strict`. Today this is fine because there are no third-party redirects. If you ever add a flow where the user lands on the app from an external domain (email link, wallet QR redirect), the browser will withhold the cookie for the first request after navigation and the user appears logged out. Consider `SameSite=Lax` for read flows; `Strict` only protects against CSRF on cookie-authed mutations, and you already gate mutations with a per-request signed nonce.

### A16. (LOW) Lambda authorizer cache TTL of 5 min plus per-request mutation nonce ⇒ cached "isAuthorized: true" survives logout

`api-stack.ts:161` — `resultsCacheTtl: cdk.Duration.minutes(5)`. After logout, API Gateway can still return cached "authorized" results until the TTL elapses (because the identity source is the static `Authorization` header value — once cookie auth is fixed, this becomes the cookie value). Acceptable for read endpoints; concerning for write endpoints if the user expects immediate revocation.

**Remediation:** disable authorizer caching (`resultsCacheTtl: cdk.Duration.seconds(0)`), or require a fresh JWT for high-risk routes by validating server-side as well.

### A17. (LOW) `/governance/{actionId}` handler will receive `actionId=sync` for `GET /governance/sync`

`/governance/sync` is registered as `POST` and `/governance/{actionId}` as `GET`, so under normal use this is fine. But a curious client doing `GET /governance/sync` will reach `governance/get.ts` with `actionId="sync"`, returning 404 ("Governance action not found"). It is technically harmless but surprising. Consider moving `/governance/sync` to `/governance/admin/sync` to avoid the namespace collision.

### A18. (LOW) Profile bio limit is 2,000 chars but `body` field on comments is 10,000 — be aware of DynamoDB item-size implications

DynamoDB items are capped at 400KB. Realistic ASCII text won't approach this, but if the schema later allows attachments or HTML, set explicit byte limits (UTF-8 multi-byte chars can balloon length).

---

## Part B — QA Test Plan

The plan is organized by area. Each test case is numbered, includes preconditions, exact commands or browser steps, and expected outcomes. Run sections in the listed order; later sections depend on earlier setup (an authenticated session, a registered DRep committee, a known governance action ID).

### Conventions

- All curl examples assume bash, `jq` installed, and these env exports:
  ```bash
  export API='https://i9la4x29c6.execute-api.us-east-1.amazonaws.com/dev'
  export FE='https://d31k3mmkrkmdvl.cloudfront.net'
  export AWS_PROFILE='drep-platform'
  export AWS_REGION='us-east-1'
  ```
- Cookies are persisted via `-c cookie.jar -b cookie.jar`.
- A **passing** test case is one whose actual output matches the **Expected** block precisely (status code + key fields). Anything else is a finding to file.

### Section S — Smoke (run first; ~5 min)

#### S1. CloudFront serves the SPA shell

```bash
curl -sI "$FE/" | head -n 20
curl -s "$FE/" | grep -E '<title>|<div id="root"' | head -n 5
```

**Expected:** `HTTP/2 200`, `content-type: text/html`, body contains `<div id="root"></div>` and a `<title>` tag.

#### S2. CloudFront SPA fallback returns index.html for deep links

```bash
curl -sI "$FE/dashboard/drep" | grep -i 'http/\|content-type\|x-cache'
curl -s  "$FE/this/path/does/not/exist" | grep -c '<div id="root"'
```

**Expected:** the deep-link request returns `HTTP/2 200` and `content-type: text/html`. The body still contains exactly one `<div id="root"`.

**Failure mode if A14 is not fixed:** asset deep-links (`/assets/foo.js`) that are missing will also resolve to index.html with status 200, masking real broken-asset bugs.

#### S3. WASM Content-Type is correct

```bash
curl -sI "$FE/assets/sidan_csl_rs_bg.wasm" | grep -i 'content-type\|content-length'
```

**Expected:** `content-type: application/wasm`, `content-length: ~5.4 MB`. If anything else (e.g., `application/octet-stream` or `text/html`) appears, run the remediation in A14 before proceeding.

#### S4. API health: a public route responds

```bash
curl -s -w '\n%{http_code}\n' "$API/governance?status=active&limit=5" | tail -n 5
```

**Expected:** `200`, body shape `{"data":{"items":[…],"lastEvaluatedKey":…,"total":N}}`. If you get 502/500, the Lambda or its bundling is broken — check CloudWatch.

#### S5. CORS preflight from CloudFront origin

```bash
curl -s -i -X OPTIONS "$API/governance" \
  -H "Origin: $FE" \
  -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: Content-Type" | head -n 25
```

**Expected after A5 is fixed:** `200`, `Access-Control-Allow-Origin: https://d31k3mmkrkmdvl.cloudfront.net`, `Access-Control-Allow-Credentials: true`. Before A5: `*` is returned and any browser request with credentials is blocked. **Do not declare CORS passing if you only see `*`.**

---

### Section F-AUTH — Authentication (after A1, A2, A3 are fixed)

The tests in this section require A1, A2, A3 (and ideally A6) to be completed.

#### F-AUTH-1. `POST /auth/challenge` — happy path

```bash
curl -s -X POST "$API/auth/challenge" \
  -H 'Content-Type: application/json' \
  -d '{"walletAddress":"stake1u9k4h0ahf63xqgskk44k0d3p3z7e0a3w29gz3rjkkk0g4lqss70wj"}' | jq
```

**Expected:** `data.nonce` is 64 hex chars, `data.expiresAt` is ~5 minutes in the future, `data.message` matches `drep-platform wants you to sign in:\n\nWallet: …\nNonce: …`.

#### F-AUTH-2. `POST /auth/challenge` — validation errors

```bash
# Missing body
curl -s -X POST "$API/auth/challenge" -H 'Content-Type: application/json' | jq
# Empty walletAddress
curl -s -X POST "$API/auth/challenge" -H 'Content-Type: application/json' -d '{"walletAddress":""}' | jq
# Invalid prefix
curl -s -X POST "$API/auth/challenge" -H 'Content-Type: application/json' -d '{"walletAddress":"BTC123"}' | jq
# Garbled JSON
curl -s -X POST "$API/auth/challenge" -H 'Content-Type: application/json' -d '{not-json' | jq
```

**Expected:** all four return `400`. Messages match the strings in `challenge.ts:11/22/27/19`.

#### F-AUTH-3. End-to-end browser auth flow (manual)

1. Open `$FE/auth/connect` in a browser with **Eternl** (recommended), Nami, or Lace installed and a wallet selected on Cardano Mainnet.
2. Click "Connect Wallet" → select wallet.
3. Wallet popup should display the exact challenge message (`drep-platform wants you to sign in: …`).
4. Sign.
5. **Expected:** redirect to `/dashboard`, `access_token` cookie present in DevTools (HttpOnly checkbox ✓, Secure ✓, SameSite=Strict), `Set-Cookie` header observed once on `/auth/verify` response.
6. Call `GET /auth/me` from DevTools console:
   ```js
   await fetch('/auth/me', {credentials: 'include'}).then(r => r.json())
   ```
   **Expected:** body contains `walletAddress`, `roles: ['delegator']` (default for first login), `sessionType: 'normal'`.

#### F-AUTH-4. `POST /auth/verify` — replay protection

After completing F-AUTH-3 once, capture the request body in DevTools and replay it via curl. **Expected:** `401 Unauthorized — Challenge nonce not found or already used`. This proves single-use semantics.

If A6 is not yet fixed, this test will pass on a warm Lambda and **fail intermittently when Lambda cold-starts.**

#### F-AUTH-5. `POST /auth/verify` — payload tamper rejection

Replay F-AUTH-3 but flip a single byte in `signature`. **Expected:** `401 Unauthorized — Ed25519 signature verification failed`. Then flip a single byte in the `walletAddress` while keeping signature/key. **Expected:** `401 Unauthorized — Challenge nonce does not match wallet address`.

#### F-AUTH-6. `POST /auth/verify` — expired challenge

Generate a challenge, wait > 5 minutes, then submit a verify. **Expected:** `401 Unauthorized — Challenge nonce has expired`.

#### F-AUTH-7. `GET /auth/me` — without cookie

```bash
curl -s -w '\n%{http_code}\n' "$API/auth/me"
```

**Expected:** `401`. Body: `{"error":"Unauthorized",…}`.

#### F-AUTH-8. `POST /auth/refresh` — extends session

After F-AUTH-3:
```bash
curl -s -b cookie.jar -c cookie.jar -X POST "$API/auth/refresh" -i | head -n 30
```

**Expected:** `200`, a fresh `Set-Cookie: access_token=…; Max-Age=604800`. Compare against the prior cookie — the JWT payload should reflect a new `iat`/`exp`.

#### F-AUTH-9. `DELETE /auth/session` — logout

```bash
curl -s -b cookie.jar -c cookie.jar -X DELETE "$API/auth/session" -i | head -n 20
curl -s -b cookie.jar -c cookie.jar "$API/auth/me" -w '\n%{http_code}\n'
```

**Expected:** the DELETE returns `200` plus `Set-Cookie: access_token=; Max-Age=0`. The follow-up `me` returns `401`. Until A3 is fixed, the frontend logout button will appear to work (Zustand cleared) but the cookie persists until expiry.

#### F-AUTH-10. JWT tampering

Decode the JWT from the cookie, change a role to `lead_drep`, re-encode WITHOUT re-signing, set the cookie back, hit `/auth/me`. **Expected:** `401`. Then attempt the same with a known-bad signature. **Expected:** `401`.

#### F-AUTH-11. JWT expiry

Issue a JWT, then either wait 7 days or temporarily reduce `SESSION_DURATIONS.normal` in `auth.ts` for a test stack. Hit `/auth/me`. **Expected:** `401`.

#### F-AUTH-12. Remember-me sessionType

Set `rememberMe: true` in F-AUTH-3 verify. **Expected:** `Set-Cookie: access_token=…; Max-Age=2592000` (30 days).

---

### Section F-GOV — Governance read paths

#### F-GOV-1. List active actions

```bash
curl -s "$API/governance?status=active&limit=10" | jq '.data | {count: (.items|length), total, lastEvaluatedKey}'
```

**Expected:** count ≤ 10, `total` is the page count returned, `lastEvaluatedKey` is a non-empty base64 string if there are more.

#### F-GOV-2. Pagination round-trip

```bash
LK=$(curl -s "$API/governance?status=active&limit=2" | jq -r '.data.lastEvaluatedKey')
curl -s "$API/governance?status=active&limit=2&lastKey=$LK" | jq '.data.items | length'
```

**Expected:** the second call returns up to 2 different items. No item from page 1 appears on page 2.

#### F-GOV-3. Invalid status

```bash
curl -s "$API/governance?status=foo" -w '\n%{http_code}\n'
```

**Expected:** `400`, message includes `Invalid status`.

#### F-GOV-4. Get specific action

```bash
ACTION_ID=$(curl -s "$API/governance?status=active&limit=1" | jq -r '.data.items[0].actionId')
echo "$ACTION_ID"
curl -s "$API/governance/$(printf %s "$ACTION_ID" | jq -sRr @uri)" | jq '.data | {actionId, actionType, status, lastSyncedAt}'
```

**Expected:** `actionId` matches, `lastSyncedAt` is within the last few minutes (proving the EventBridge sync is alive).

#### F-GOV-5. Non-existent action

```bash
curl -s "$API/governance/abc123%23999" -w '\n%{http_code}\n'
```

**Expected:** `404`, body `{"error":"NotFound", "message":"Governance action not found", …}`.

#### F-GOV-6. Sort order via `submittedAt`

If A10 is unresolved: items in `data.items` will be in lexicographic order of action ID, NOT chronological — verify by spot-checking. Tag this as a finding even if "passing".

---

### Section F-GOV-SYNC — EventBridge sync (requires AWS access)

#### F-GOV-SYNC-1. Confirm the schedule rule is enabled and firing

```bash
aws events describe-rule --name drep-platform-dev-governance-sync --profile $AWS_PROFILE --region $AWS_REGION
aws events list-targets-by-rule --rule drep-platform-dev-governance-sync --profile $AWS_PROFILE --region $AWS_REGION
```

**Expected:** `State: ENABLED`, `ScheduleExpression: rate(2 minutes)`, target ARN is the governance-intake Lambda.

#### F-GOV-SYNC-2. Recent invocations succeeded

```bash
aws logs tail /aws/lambda/drep-platform-dev-governance-intake-sync \
  --since 10m \
  --profile $AWS_PROFILE \
  --region $AWS_REGION | tail -n 80
```

**Expected:** at least one log line per 2 min window matching `Governance intake complete: synced=N, skipped=0, errors=0`. No `Failed to sync governance action` lines. If errors are non-zero, dig into the failed `tx_hash` and check Blockfrost/DynamoDB.

#### F-GOV-SYNC-3. Manual admin trigger via `POST /governance/sync`

Requires a JWT with `lead_drep` role (set via DynamoDB after F-AUTH-3 — see "Helpers" below).

```bash
# Promote your wallet to lead_drep manually for testing:
aws dynamodb update-item \
  --table-name drep-platform-dev-users \
  --key '{"walletAddress":{"S":"stake1..."}, "SK":{"S":"PROFILE"}}' \
  --update-expression 'SET #r = :r' \
  --expression-attribute-names '{"#r":"roles"}' \
  --expression-attribute-values '{":r":{"L":[{"S":"delegator"},{"S":"lead_drep"}]}}' \
  --profile $AWS_PROFILE --region $AWS_REGION

# Then re-login (so JWT carries the new roles), and:
curl -s -b cookie.jar -X POST "$API/governance/sync" | jq
```

**Expected:** `200`, `data.synced` ≥ 1.

#### F-GOV-SYNC-4. Authorization on sync endpoint

```bash
curl -s -X POST "$API/governance/sync" -w '\n%{http_code}\n'                        # no cookie
curl -s -b cookie-as-delegator.jar -X POST "$API/governance/sync" -w '\n%{http_code}\n'  # delegator only
```

**Expected:** `401` and `403` respectively.

#### F-GOV-SYNC-5. Blockfrost-quota safety

```bash
# Check daily Blockfrost usage (login to blockfrost.io dashboard, OR call /metrics endpoint)
# At present: 2-min cadence × full pagination = ~30 calls per cycle if N=300 proposals × 720 cycles/day = 21,600 calls/day, plus 720 latest-epoch calls = 22,320/day. Under 50k/day, OK.
```

If A13 is unresolved, file the cadence as a finding with a remediation suggestion.

---

### Section F-DREP — DRep committees

These tests assume A1-A4 fixed and you have an authenticated session.

#### F-DREP-1. Register a DRep committee

```bash
curl -s -b cookie.jar -X POST "$API/drep" \
  -H 'Content-Type: application/json' \
  -d '{"committeeName":"QA Test Committee","description":"Smoke-test entity"}' | jq
```

**Expected:** `201`, `data.drepId` is a ULID, `data.leadWallet` matches your wallet, `data.members[0].role === 'lead_drep'`.

Verify role elevation:
```bash
curl -s -b cookie.jar "$API/auth/me" | jq '.data.roles'
```

**Expected:** array contains `lead_drep`. Note: this elevation is in DynamoDB, not in the JWT. The JWT still carries the old roles until refresh — confirm by hitting any `lead_drep`-only endpoint and observing 403; refresh the JWT (F-AUTH-8) and retry → 200. **File this as a UX bug if not desired.**

#### F-DREP-2. Duplicate registration

Repeat F-DREP-1 with the same wallet. **Expected:** `409 Conflict — You have already registered a DRep committee`.

#### F-DREP-3. Validation

```bash
curl -s -b cookie.jar -X POST "$API/drep" -H 'Content-Type: application/json' -d '{"committeeName":""}' -w '\n%{http_code}\n'
curl -s -b cookie.jar -X POST "$API/drep" -H 'Content-Type: application/json' -d '{}' -w '\n%{http_code}\n'
```

**Expected:** both `400`.

#### F-DREP-4. Get and update

```bash
DREP=$(curl -s -b cookie.jar "$API/auth/me" | jq -r '.data.drepId')
curl -s "$API/drep/$DREP" | jq '.data | {drepId, committeeName, leadWallet}'
curl -s -b cookie.jar -X PUT "$API/drep/$DREP" \
  -H 'Content-Type: application/json' \
  -d '{"committeeName":"Renamed Committee"}' | jq '.data.committeeName'
```

**Expected:** initial name, then `Renamed Committee`.

#### F-DREP-5. Update by non-lead

Authenticate as a different wallet (without `lead_drep` role for this committee):
```bash
curl -s -b cookie-other.jar -X PUT "$API/drep/$DREP" -d '{"committeeName":"Hijacked"}' -H 'Content-Type: application/json' -w '\n%{http_code}\n'
```

**Expected:** `403 Forbidden — Only the lead DRep can update the committee`. Note the role-guard requires `lead_drep` OR `committee_member`, but the in-handler check at `update.ts:47` is an additional ownership check.

#### F-DREP-6. List by leadWallet

```bash
curl -s "$API/drep?leadWallet=$(printf %s "$YOUR_WALLET" | jq -sRr @uri)" | jq '.data.items | length'
```

**Expected:** ≥ 1.

#### F-DREP-7. List without filter

```bash
curl -s "$API/drep" -w '\n%{http_code}\n'
```

**Expected:** `400` (until A8 is fixed). Document the failure mode for a frontend perspective: any "Browse all DReps" UI cannot work today.

---

### Section F-COMMENTS — Comments on governance actions

These require A4 (mutation nonce endpoint) and an authenticated session.

#### F-COMMENTS-1. List comments on an action

```bash
curl -s "$API/comments/$(printf %s "$ACTION_ID" | jq -sRr @uri)?limit=10" | jq '.data.items | length'
```

**Expected:** an integer; new actions return 0.

#### F-COMMENTS-2. List public-only

```bash
curl -s "$API/comments/$(printf %s "$ACTION_ID" | jq -sRr @uri)?public=true" | jq '.data.items | map(.isPublic) | unique'
```

**Expected:** `[true]` or `[]`.

#### F-COMMENTS-3. Create a comment (after A4)

Issue a mutation nonce, sign it via your wallet (manual step in DevTools console using `window.cardano.<wallet>.signData(addr, hex)`), then POST:
```bash
curl -s -b cookie.jar -X POST "$API/comments/$(printf %s "$ACTION_ID" | jq -sRr @uri)" \
  -H 'Content-Type: application/json' \
  -d '{
    "body":"This is a QA comment",
    "isPublic":true,
    "mutationNonce":"<from /auth/mutation-nonce>",
    "mutationSignature":"<hex from signData>",
    "mutationKey":"<hex from signData>"
  }' | jq
```

**Expected:** `201`, `data.commentId` is a ULID, `data.isDRep` is `false` (or `true` if your wallet has `lead_drep`/`committee_member` roles), `data.walletAddress` is yours.

#### F-COMMENTS-4. Body length validation

Try `body` longer than 10,000 chars; `body` empty; `body` with only whitespace. **Expected:** all `400`.

#### F-COMMENTS-5. Replay attack on mutation nonce

Submit the same `mutationNonce`/`mutationSignature` twice. **Expected:** second call `401 — Mutation nonce not found or already used`. (Same flakiness caveat as A6.)

#### F-COMMENTS-6. Cross-wallet nonce attempt

Generate nonce as wallet A, sign as wallet A, but post with wallet B's session cookie. **Expected:** `401 — Mutation nonce does not match wallet address`.

#### F-COMMENTS-7. Delete own comment

```bash
curl -s -b cookie.jar -X DELETE "$API/comments/$ACTION_ID/$COMMENT_ID" -w '\n%{http_code}\n'
```

**Expected:** `204`.

#### F-COMMENTS-8. Delete other user's comment as non-lead

**Expected:** `403`. Then escalate the wallet to `lead_drep` and retry → `204`.

#### F-COMMENTS-9. XSS payload in body

Submit `body` with `<script>alert(1)</script>` plus other HTML and JS-template payloads. **Expected:** the API stores the raw text; frontend renders it as plain text (verify in DevTools that the DOM shows escaped entities, not a live script tag). If the frontend uses `dangerouslySetInnerHTML` anywhere, **stop and fix.** Quick grep:
```bash
grep -R 'dangerouslySetInnerHTML' /Users/admin/Developer/drep-platform/frontend/src
```

---

### Section F-CLUBHOUSE — DRep clubhouse posts

#### F-CLUBHOUSE-1. List posts

```bash
curl -s "$API/clubhouse/$DREP?limit=10" | jq '.data.items | length'
```

#### F-CLUBHOUSE-2. Create post as lead_drep

```bash
curl -s -b cookie.jar -X POST "$API/clubhouse/$DREP/post" \
  -H 'Content-Type: application/json' \
  -d '{"body":"QA post"}' | jq '.data | {postId, isDRepPost, authorWallet}'
```

**Expected:** `201`, `isDRepPost: true` (since the wallet has `lead_drep` after F-DREP-1).

#### F-CLUBHOUSE-3. Create post as non-member

Authenticate as a wallet that is not in `committee.members` and not `leadWallet`. **Expected:** `403 — You must be a member of this committee to post`. (Note the bug A11: the role-check prelude accepts everyone, so the membership check is the only real gate.)

#### F-CLUBHOUSE-4. Add a comment

```bash
curl -s -b cookie.jar -X POST "$API/clubhouse/$DREP/post/$POSTID/comment" \
  -H 'Content-Type: application/json' \
  -d '{"body":"QA reply"}' | jq
```

**Expected:** `200` (note: handler returns `ok` not `created` — minor inconsistency to flag).

#### F-CLUBHOUSE-5. Delete post — owner

```bash
curl -s -b cookie.jar -X DELETE "$API/clubhouse/$DREP/post/$POSTID" -w '\n%{http_code}\n'
```

**Expected:** `204`.

#### F-CLUBHOUSE-6. Delete post — non-owner non-lead

**Expected:** `403`.

#### F-CLUBHOUSE-7. Body size cap

`body` of 50,001 chars → `400`.

---

### Section F-PROFILE — Profile read/write and delegation history

#### F-PROFILE-1. Public profile read

```bash
curl -s "$API/profile/$(printf %s "$STAKE_ADDR" | jq -sRr @uri)" | jq '.data | {walletAddress, displayName, roles}'
```

**Expected:** `200` if a profile exists, else `404`. **Verify NO `sessionTokenHash` or `sessionExpiry` field is present** (check in `profile/get.ts:23` and `me.ts:23` strip them — if any leak, that's a finding).

```bash
curl -s "$API/profile/$STAKE_ADDR" | jq '.data | has("sessionTokenHash"), has("sessionExpiry")'
```

**Expected:** both `false`.

#### F-PROFILE-2. Upsert (authenticated)

```bash
curl -s -b cookie.jar -X POST "$API/profile" \
  -H 'Content-Type: application/json' \
  -d '{"displayName":"QA Tester","bio":"qa","socialLinks":{"twitter":"https://x.com/qa"}}' | jq
```

**Expected:** `200`, fields echo back, no sensitive fields.

#### F-PROFILE-3. Validation

- `displayName` longer than 100 → 400.
- `displayName` empty string → 400.
- `bio` longer than 2,000 → 400.

#### F-PROFILE-4. Delegation history

```bash
curl -s "$API/profile/$STAKE_ADDR/delegation-history" | jq
```

**Expected:** `200`, `data.delegationHistory` is an array (possibly empty), `data.currentDrepId` is from Blockfrost (string or null). If Blockfrost is rate-limited: `data.currentDrepId` is `undefined` and the request still returns 200 — that's by design (`delegationHistory.ts:33` swallows the error).

---

### Section SEC — Security tests

#### SEC-1. JWT secret rotation simulation

After F-AUTH-3, in AWS console rotate the value of `drep-platform/dev/jwt-secret` to a new random string. Wait at least the Lambda concurrent-instance lifetime (~15 min for full reset). Re-call `/auth/me`. **Expected:** `401` (JWT signed with old secret). Existing logged-in users get logged out — confirm in browser. **Caveat:** the `_jwtSecretCache` module-level variable means warm Lambdas keep the old secret indefinitely. To validate rotation truly works, force a Lambda update (re-deploy) or wait for natural cold start.

#### SEC-2. Unauthenticated mutation paths

For every authenticated route below, hit it with NO cookie:
- `POST /auth/refresh`
- `DELETE /auth/session`
- `GET /auth/me`
- `POST /governance/sync`
- `POST /drep`
- `PUT /drep/{drepId}`
- `POST /comments/{actionId}`
- `DELETE /comments/{actionId}/{commentId}`
- `POST /clubhouse/{drepId}/post`
- `POST /clubhouse/{drepId}/post/{postId}/comment`
- `DELETE /clubhouse/{drepId}/post/{postId}`
- `POST /profile`

**Expected:** all `401`.

#### SEC-3. Authorization escalation attempts

Authenticate as a `delegator` (no other roles) and attempt:
- `POST /governance/sync` → 403
- `PUT /drep/{any}` → 403 (role gate) or 403 (ownership gate after promotion)
- `DELETE /comments/{action}/{otherUserCommentId}` → 403
- `DELETE /clubhouse/{anyDrep}/post/{otherUsersPostId}` → 403

#### SEC-4. SQL injection / NoSQL injection attempts

DynamoDB doesn't have a query-language injection surface in the same way SQL does, but attempt:
- `actionId` path parameter: `' OR 1=1`, `; drop`, `*`, `${jndi:ldap://...}`, etc. **Expected:** `404` for normal lookups, never a 500. If you see a 500 on URL-decoded curveballs (e.g., a path containing percent-encoded null or backslash), inspect logs.

#### SEC-5. Path traversal on resource params

`GET /governance/..%2f..%2fauth%2fme` and similar. **Expected:** API Gateway either rejects (400/404) or routes to `/governance/{actionId}` with the literal path-segment value. Confirm no internal redirect leaks data.

#### SEC-6. Header injection in challenge response

```bash
curl -s -X POST "$API/auth/challenge" -d '{"walletAddress":"addr1\r\nSet-Cookie: malicious=1"}' -H 'Content-Type: application/json' -i | grep -i 'set-cookie'
```

**Expected:** no `Set-Cookie: malicious=1` header. The `walletAddress` should fail validation (`!startsWith('addr')` after CRLF? — note: `\r\n` is part of the string, so `'addr1\r\n…'.startsWith('addr')` is true). If the challenge is generated and the message ends up in `Set-Cookie`, that's a header-injection vector. **Expected behaviour:** `400` from validation, OR the challenge message is correctly JSON-encoded (newlines escaped in JSON, not interpreted in HTTP).

#### SEC-7. CIP-30 signature spoofing — wrong public key

In F-AUTH-3, replay verify with `signature` from a real signing operation but `key` (COSE_Key) from a different wallet (substitute a hex blob). **Expected:** `401 — Ed25519 signature verification failed` or `Could not extract 32-byte Ed25519 public key from COSE_Key`.

#### SEC-8. CIP-30 signature spoofing — wrong message

Replay a verify where the `signature` was generated for message X but the recorded nonce in DynamoDB was for message Y. **Expected:** `401 — Signature payload does not match expected message`. The check at `auth.ts:150` enforces this.

#### SEC-9. CSRF on cookie-authed mutations

With `SameSite=Strict`, browsers will not send the cookie on cross-site requests. Confirm by hosting a static page on a different origin that POSTs to `/profile`. **Expected:** the request goes out without the cookie → 401. **Defence-in-depth note:** the mutation-nonce flow (signed by wallet) is your second layer; a CSRF that survived `SameSite=Strict` would still need to forge a wallet signature, which is infeasible.

#### SEC-10. Open-redirect / cookie scope

Confirm cookie `Path=/` and is NOT scoped to the API Gateway domain such that it leaks across stages. Inspect `Set-Cookie`:
```
access_token=…; Max-Age=604800; HttpOnly; Secure; SameSite=Strict; Path=/
```
No `Domain=` attribute → host-only cookie → only sent back to `i9la4x29c6.execute-api.us-east-1.amazonaws.com`. **This means the cookie is NOT shared with the CloudFront frontend domain — and the SPA cannot read the cookie even if it wanted to (HttpOnly).** That's correct, but confirm the frontend's `withCredentials: true` plus correct CORS origin allows the browser to attach the cookie on `apiClient` calls (it will, because the request is to the API Gateway domain directly).

#### SEC-11. Secrets exposure in logs

Trigger an error path (e.g., F-AUTH-2) and inspect CloudWatch logs:
```bash
aws logs tail /aws/lambda/drep-platform-dev-AuthVerifyFn --since 15m --profile $AWS_PROFILE | grep -i 'secret\|jwt_secret\|api_key\|signature'
```

**Expected:** no secret string, no full JWT, no full signature. Note `verify.ts:101` logs `err` with `console.error` — confirm errors don't include sensitive data.

#### SEC-12. Rate limiting on public endpoints

Hammer `/governance` with 200 reqs/sec:
```bash
ab -n 1000 -c 50 "$API/governance?status=active&limit=10"
```

**Expected:** API Gateway throttles at the configured `throttlingRateLimit: 100` (api-stack.ts:145). Some 429 responses, but no 5xx.

#### SEC-13. Lambda payload limits

Send a 7MB JSON body to `POST /comments/{actionId}`. **Expected:** API Gateway rejects with 413 (payload too large; default REST API max is 10 MB, though Lambda's hard limit is 6 MB). Check that Lambda doesn't crash on a 6 MB payload.

#### SEC-14. Public exposure of write endpoints via `OPTIONS`

```bash
curl -s -X OPTIONS "$API/auth/verify" -H "Origin: https://attacker.example" -i | head -n 20
```

**Expected after A5:** `Access-Control-Allow-Origin` is the allow-listed origin, NOT `https://attacker.example`. If `*` is returned, the endpoint can be called by any browser-driven attacker page.

#### SEC-15. CSP / security headers on frontend

```bash
curl -sI "$FE/" | grep -iE 'x-content-type-options|x-frame-options|strict-transport-security|content-security-policy|referrer-policy'
```

CloudFront's `ResponseHeadersPolicy.SECURITY_HEADERS` adds:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: SAMEORIGIN`
- `Strict-Transport-Security: max-age=31536000`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `X-XSS-Protection: 1; mode=block`

**It does NOT add a `Content-Security-Policy` header.** WASM runs without CSP, so the WASM module should load fine. **However**, if you want to add a CSP, it must include `'wasm-unsafe-eval'` in `script-src` to allow @meshsdk WASM. File this as a hardening recommendation, not a blocker.

#### SEC-16. PII in audit log

The audit_log table has TTL but no current writes (grep `tableNames.auditLog` in handlers — no usages). File as a finding: audit_log is provisioned but unused, so privileged actions (DRep registration, role escalation, comment deletion) are not auditable. **Recommend** writing audit entries from `drep/register.ts`, `comments/delete.ts`, `clubhouse/deletePost.ts`, `governance/sync.ts`.

---

### Section CHAIN — Blockchain / wallet integration

#### CHAIN-1. CIP-30 across multiple wallets

Run F-AUTH-3 with each of: Eternl, Nami, Lace, Flint, Typhon, GeroWallet. **Expected:** all succeed. Document any wallet that produces a COSE_Sign1 with a different structure (some Cardano wallets historically used `phantom: true` mode where the signature includes the wallet's stake key but the `key` field uses a different COSE_Key map shape).

If a wallet fails verification with `Could not extract 32-byte Ed25519 public key from COSE_Key`, capture the failing payload and add a unit test fixture. The handler at `auth.ts:159-169` accommodates two CBOR shapes (Map and plain object); a third may be needed.

#### CHAIN-2. Stake address vs. payment address

The frontend prefers `getRewardAddresses()[0]` (stake address `stake1…`). Validate that signing with a payment address (`addr1…`) also works:
1. In DevTools, manually call `wallet.signData(usedAddresses[0], messageHex)`.
2. Verify the backend accepts this — `auth.ts:67-69` only validates the message format; `verify.ts:28-30` checks `walletAddress` is a non-empty string, no prefix check (good).

**Expected:** both work. Ensure no code path assumes stake address.

#### CHAIN-3. Mainnet-only

`api-stack.ts:41` and `scheduler-stack.ts:55` set `CARDANO_NETWORK=mainnet` for non-staging. Confirm by:
```bash
aws lambda get-function-configuration --function-name <governance-sync-fn> --profile $AWS_PROFILE | jq '.Environment.Variables.CARDANO_NETWORK'
```

**Expected:** `"mainnet"`. A user connecting a wallet set to Preprod should NOT be able to authenticate (the Blockfrost lookups happen on the wallet's network selection only for `delegationHistory`; `verify` is purely cryptographic and doesn't check network — note this as a finding: a Preprod wallet can authenticate against the Mainnet platform). **Recommend** adding a network check to `/auth/verify` that decodes the bech32 prefix to confirm `addr_test`/`stake_test` are rejected.

#### CHAIN-4. Blockfrost API quota

Log in to blockfrost.io dashboard, dev project. Check daily call count after running the suite. **Expected:** sub-50k. If close, A13 is required.

#### CHAIN-5. Governance proposal mapping fidelity

Pick a high-profile recent action (e.g., the most recent on https://gov.tools or cardanoscan governance page), capture its `tx_hash` and `cert_index`, and verify that the platform's stored item matches:
```bash
curl -s "$API/governance/${TX_HASH}%23${CERT_INDEX}" | jq '.data | {actionId, actionType, status, title, description}'
```

**Expected:** `actionType` is correctly mapped (e.g., `ParameterChange`), `status` reflects current epoch correctly. Cross-reference with `cardanoscan.io` or `gov.tools` data for the same proposal.

---

### Section INFRA — Infrastructure / deployment

#### INFRA-1. CDK drift

```bash
cd /Users/admin/Developer/drep-platform/infra
npx cdk diff DRepPlatform-Database-dev DRepPlatform-Api-dev DRepPlatform-Frontend-dev DRepPlatform-Scheduler-dev --profile $AWS_PROFILE
```

**Expected:** "no changes" on all stacks. Any drift indicates manual console edits.

#### INFRA-2. DynamoDB table presence and PITR

```bash
for t in users drep_committees governance_actions comments clubhouse_posts audit_log; do
  aws dynamodb describe-table --table-name "drep-platform-dev-$t" --profile $AWS_PROFILE --region $AWS_REGION \
    --query 'Table.{Name:TableName,Status:TableStatus,Billing:BillingModeSummary.BillingMode,PITR:ContinuousBackupsDescription.PointInTimeRecoveryDescription.PointInTimeRecoveryStatus}' 2>/dev/null
  aws dynamodb describe-continuous-backups --table-name "drep-platform-dev-$t" --profile $AWS_PROFILE --region $AWS_REGION \
    --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription.PointInTimeRecoveryStatus' --output text
done
```

**Expected:** all 6 tables present, `ACTIVE`, PITR `ENABLED`, billing `PAY_PER_REQUEST`.

#### INFRA-3. Secrets Manager entries exist

```bash
aws secretsmanager describe-secret --secret-id drep-platform/dev/jwt-secret --profile $AWS_PROFILE
aws secretsmanager describe-secret --secret-id drep-platform/dev/blockfrost-api-key --profile $AWS_PROFILE
```

**Expected:** both present, `RotationEnabled` either absent or false. Confirm rotation policy (none today) and document.

#### INFRA-4. Lambda config sanity

```bash
for f in $(aws lambda list-functions --profile $AWS_PROFILE --region $AWS_REGION --query 'Functions[?starts_with(FunctionName, `DRepPlatform-Api-dev-`) || starts_with(FunctionName, `drep-platform-dev-`)].FunctionName' --output text); do
  aws lambda get-function-configuration --function-name "$f" --profile $AWS_PROFILE --region $AWS_REGION --query '{Name:FunctionName,Runtime:Runtime,Arch:Architectures[0],Timeout:Timeout,Mem:MemorySize,Env:keys(Environment.Variables)}'
done
```

**Expected:** runtime `nodejs20.x`, arch `arm64`, timeout `30` (or `300` for the sync), memory `512` (or `1024` for sync). Each has the expected env vars.

#### INFRA-5. CloudFront distribution

```bash
aws cloudfront get-distribution-config --id E2DICV1F3XXMNR --profile $AWS_PROFILE \
  --query 'DistributionConfig.{DefaultRoot:DefaultRootObject,ErrorResp:CustomErrorResponses,DefaultCache:DefaultCacheBehavior.CachePolicyId}' 
```

**Expected:** `DefaultRootObject: index.html`, two error responses (403 and 404 → /index.html, status 200), `CachePolicyId` matches `CACHING_OPTIMIZED` (`658327ea-f89d-4fab-a63d-7e88639e58f6`).

#### INFRA-6. S3 bucket — no public access

```bash
aws s3api get-public-access-block --bucket drep-platform-dev-frontend-409410541898 --profile $AWS_PROFILE
aws s3api get-bucket-policy --bucket drep-platform-dev-frontend-409410541898 --profile $AWS_PROFILE | jq -r '.Policy' | jq
```

**Expected:** all four block flags `true`. Bucket policy allows ONLY the CloudFront distribution (via OAC) `s3:GetObject`.

#### INFRA-7. EventBridge rule

(see F-GOV-SYNC-1)

#### INFRA-8. CloudWatch alarms

```bash
aws cloudwatch describe-alarms --profile $AWS_PROFILE --region $AWS_REGION --query 'MetricAlarms[?starts_with(AlarmName, `drep-platform`)].{Name:AlarmName,State:StateValue,Metric:MetricName}'
```

**Expected:** none today (CDK doesn't define any). **Recommend** adding alarms for: governance-intake errors > 0, Lambda 5xx rate, DynamoDB throttle events, CloudFront 5xx > 1%. File as a finding.

#### INFRA-9. Cost guardrails

Confirm AWS Budgets are configured for the account, e.g., monthly $50 alert. CDK doesn't define budgets — recommend adding.

#### INFRA-10. CloudFront invalidation post-deploy

If the frontend is re-deployed, an invalidation must be issued. Confirm by:
1. Re-build frontend (`cd frontend && npm run build`).
2. `aws s3 sync ./frontend/dist s3://drep-platform-dev-frontend-409410541898/ --delete --profile $AWS_PROFILE` (set `--content-type application/wasm` for `.wasm` files explicitly — see A14).
3. `aws cloudfront create-invalidation --distribution-id E2DICV1F3XXMNR --paths '/*' --profile $AWS_PROFILE`.
4. Hard-refresh the CloudFront URL; confirm new bundle is served (compare hashed asset filename).

If the deployment doesn't include this, file a finding and write a `make deploy-frontend` target.

---

### Section PERF — Performance / load

The dev API has `throttlingRateLimit: 100`, `throttlingBurstLimit: 200` (api-stack.ts:145-146). For a real load test, exempt your test IP via API Gateway usage plans, or run from a small EC2 instance.

#### PERF-1. Cold-start latency

Force a cold start by waiting 15+ minutes idle:
```bash
sleep 900
time curl -s "$API/governance?status=active&limit=10" > /dev/null
```

**Expected:** first call < 3 s (Node 20 ARM64 with 512MB warms quickly). Subsequent calls < 200 ms.

#### PERF-2. p95 latency on GET /governance

```bash
ab -n 200 -c 5 "$API/governance?status=active&limit=20"
```

**Expected:** p95 < 500 ms, p99 < 1 s. Note any slow queries in CloudWatch.

#### PERF-3. p95 latency on /auth/me (warm)

```bash
# Login first, then:
ab -n 100 -c 5 -C "access_token=…" "$API/auth/me"
```

**Expected:** p95 < 300 ms (single DynamoDB GetItem).

#### PERF-4. Sync Lambda execution time

```bash
aws logs filter-log-events --log-group-name /aws/lambda/drep-platform-dev-governance-intake-sync \
  --start-time $(($(date +%s) - 86400))000 --profile $AWS_PROFILE --region $AWS_REGION \
  --query 'events[?message contains `REPORT`].[timestamp, message]' --output text | head -n 20
```

**Expected:** `Duration: < 60000` ms (< 1 minute) per invocation. If > 4 min consistently, the timeout (5 min) is at risk — prioritize A13.

#### PERF-5. WASM bundle load time

Open `$FE/auth/connect` with browser DevTools → Network tab → throttle to "Fast 3G". Expected: TTI < 8 s on Fast 3G. The 5.4 MB WASM is the main bottleneck. Document the load time. If unacceptable, consider lazy-loading via dynamic import only on the wallet-connect page.

#### PERF-6. Concurrency stress

```bash
# 50 concurrent /governance reads:
ab -n 1000 -c 50 "$API/governance?status=active&limit=20"
```

**Expected:** zero 5xx, some 429 once concurrency × duration > 100 RPS. DynamoDB PAY_PER_REQUEST handles spikes; verify no `ProvisionedThroughputExceeded` errors in CloudWatch.

---

### Section UI — Frontend manual smoke (browser)

Open `$FE` in Chrome with DevTools open. Run through every route.

#### UI-1. Anonymous flows
- [ ] `/` (Home) loads, shows guest content.
- [ ] `/guest` renders public landing.
- [ ] `/governance/{actionId}` (with valid action ID) renders proposal details, comments list (empty or populated).
- [ ] `/drep/{drepId}` renders public DRep profile if it exists; 404-style page or fallback if not.
- [ ] `/profile/{walletAddress}` renders public profile.
- [ ] `/auth/connect` renders wallet selector.

#### UI-2. Auth flow
- [ ] Connect Eternl → sign challenge → land on `/dashboard`.
- [ ] Refresh page → still authenticated (cookie persists, `/auth/me` succeeds).
- [ ] Click Logout → cookie cleared, redirect to `/`.

#### UI-3. Authenticated flows
- [ ] `/dashboard/delegator` renders.
- [ ] Submit a comment on a governance action.
- [ ] Edit profile (`/profile/setup`).
- [ ] Register a DRep committee.
- [ ] After registration, role-elevation appears in `/auth/me` (may require manual JWT refresh — see F-DREP-1 caveat).
- [ ] DRep dashboard renders, can post to clubhouse.

#### UI-4. RoleGuard correctness
- [ ] Visit `/dashboard/drep` as a non-DRep → redirects to `/auth/connect`.
- [ ] Visit `/dashboard/drep` while logged out → redirects to `/auth/connect`.

#### UI-5. Console errors
- [ ] No red errors in DevTools console on any route. WASM-related warnings OK.
- [ ] No 4xx/5xx in Network tab unless intentionally triggered.

#### UI-6. Responsive layout
- [ ] Mobile (375×667), tablet (768×1024), desktop (1280×800) all render without overlap or unreadable text.

#### UI-7. Accessibility quick scan
- [ ] All buttons have accessible names.
- [ ] Forms have label/`aria-label`.
- [ ] `Tab` cycles through interactive elements logically.

---

### Helpers

#### Get a known stake address for testing

If you don't have a Cardano wallet handy, register a test wallet at https://eternl.io and switch to Mainnet (or use one of the testnet networks if you change `CARDANO_NETWORK` in CDK). Note the bech32 stake address from "Receive".

#### Promote your wallet to lead_drep without going through registration (test-only)

```bash
aws dynamodb update-item \
  --table-name drep-platform-dev-users \
  --key '{"walletAddress":{"S":"<your-stake-or-payment-addr>"},"SK":{"S":"PROFILE"}}' \
  --update-expression 'SET #r = :r' \
  --expression-attribute-names '{"#r":"roles"}' \
  --expression-attribute-values '{":r":{"L":[{"S":"delegator"},{"S":"lead_drep"}]}}' \
  --profile $AWS_PROFILE --region $AWS_REGION
# Then re-login to refresh JWT.
```

#### Inspect DynamoDB

```bash
aws dynamodb scan --table-name drep-platform-dev-users --profile $AWS_PROFILE --region $AWS_REGION --max-items 10 | jq '.Items[]'
aws dynamodb scan --table-name drep-platform-dev-governance_actions --profile $AWS_PROFILE --region $AWS_REGION --max-items 5 | jq '.Items[].title.S'
```

#### Tail Lambda logs in real-time

```bash
aws logs tail /aws/lambda/drep-platform-dev-AuthVerifyFn --follow --profile $AWS_PROFILE --region $AWS_REGION
```

#### Trigger a CloudFront invalidation

```bash
aws cloudfront create-invalidation --distribution-id E2DICV1F3XXMNR --paths '/*' --profile $AWS_PROFILE
```

---

## Recommended execution order

1. **Part A remediation.** Fix at least A1, A2, A3, A4, A5, A6 (the BLOCKER + HIGH items). Re-deploy.
2. **Section S — Smoke.** Confirms platform is reachable.
3. **Section INFRA.** Fast checks; failures here invalidate everything else.
4. **Section F-GOV (read-only).** No auth needed.
5. **Section F-AUTH.** Establishes session for the rest.
6. **Section F-PROFILE / F-DREP / F-COMMENTS / F-CLUBHOUSE.** In that order — each builds on the previous.
7. **Section F-GOV-SYNC.** Requires lead_drep role from F-DREP-1.
8. **Section CHAIN.** Cross-wallet variations and Blockfrost cross-checks.
9. **Section SEC.** Security probes; some require a malicious-style harness.
10. **Section PERF.** Last, because load may temporarily degrade the service.
11. **Section UI.** Run alongside the API tests; many UI flows are sanity checks of the API tests.

## Findings template

For each red test, file:

```
Finding ID: F-<section>-<test>
Severity: <BLOCKER|HIGH|MEDIUM|LOW>
Test: <test number and one-line title>
Expected: <quoted from plan>
Actual: <observed output>
Repro:
  <commands or steps>
CloudWatch log excerpt: <if applicable>
Suspected cause: <one sentence>
Suggested fix: <pointer to source file/line>
```

## Known gaps in this plan (acknowledge, don't pretend)

- **No automated test suite committed.** Phase 1-D in `RESUME.md` is "Write tests"; this plan is the manual substitute. Strongly recommend adding `vitest` unit tests for `auth.ts` (especially `verifyWalletSignature` against captured CIP-30 fixtures from each wallet) and integration tests via `aws-sdk-client-mock` for handlers.
- **No load-test fixtures for governance.** A real soak test should be on a staging stack with synthetic 10,000-action data.
- **Penetration test is out of scope.** Engage a third party for any prod release.
- **No DR/restore drill.** PITR is enabled; the test of restoring a table from a known timestamp is not documented here. Add to a runbook.
