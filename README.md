# drep.tools — DRep Coordination Platform

A coordination platform for Cardano Delegated Representatives (DReps) and the
delegators who back them. Live at **[drep.tools](https://drep.tools)** on
mainnet, the platform is three surfaces in one app:

- **Governance dashboard** — every active and historical CIP-1694 governance
  action with three-slice ratification math (yes / no / not voted), CIP-108
  anchor metadata, vote tallies for DReps / SPOs / Constitutional Committee,
  and a forum-draft fallback for actions without on-chain anchors.
- **DRep directory** — every registered DRep on mainnet with CIP-119 anchor
  metadata (name, image, objectives, motivations, qualifications), live voting
  power, recent activity, and a public profile page.
- **Delegator clubhouse** — DRep-authored posts, polls and discussion threads
  scoped to each DRep's delegator base, with on-chain stake recognition
  pills.

## Live URLs

| Surface | URL |
|---------|-----|
| Frontend (SPA) | https://drep.tools |
| `www` redirect | https://www.drep.tools |
| API           | https://api.drep.tools |

## Tech stack

**Frontend**
- React 18 + Vite 5 + TypeScript
- Tailwind CSS with custom Cardano design tokens
- React Router 6, TanStack Query 5, Zustand for state
- MeshSDK (`@meshsdk/core` + `@meshsdk/react`) for CIP-30 wallet integration
- React Markdown + Rehype Sanitize for safe anchor-body rendering
- Radix UI primitives wrapped in custom `<Button>` / `<Card>` / `<Donut>` …

**Backend**
- AWS Lambda (Node.js 20.x, ARM64)
- HTTP API v2 (cookie auth, cheaper than REST)
- DynamoDB (PAY_PER_REQUEST) — 8 tables, 9 GSIs total
- EventBridge schedules: governance intake (1 min), DRep directory (30 min)
- `jose` JWT, `cbor-x` for COSE_Sign1, Node `crypto` for Ed25519 verify

**Data sources**
- **Koios** (`api.koios.rest`) — primary metadata source. Free, decentralized,
  one bulk call per cycle for proposals, DReps and votes.
- **Blockfrost** (`cardano-mainnet.blockfrost.io`) — fallback only. Used for
  the legacy enrichment path when Koios is unreachable, plus a few read
  endpoints (`/epoch`, `/profile/.../delegation-history`, recognition pills).

**Infrastructure**
- AWS CDK (TypeScript) — DatabaseStack / ApiStack / FrontendStack /
  SchedulerStack
- CloudFront + WAFv2 in front of both API and SPA (cost protection +
  rate-limit + CSP)
- Route 53 alias records, ACM certificate, S3 (private, OAC-only) for the
  frontend bucket
- AWS Budgets (alert-only): $5 soft, $20 hard, monthly

## Architecture

### Data flow

```
                        Cardano mainnet (cardano-node, db-sync)
                                       |
                +----------------------+---------------------+
                |                                            |
        Koios api.koios.rest                       Blockfrost cardano-mainnet
        (free, primary)                            (paid, fallback)
                |                                            |
                +----------------------+---------------------+
                                       |
                                       v
                          backend/src/sync/*  (Lambdas)
                  +----------------------------------------+
                  | governance-intake  (every 1 min)        |
                  |   - one Koios /proposal_list call       |
                  |   - one Koios /vote_list call (Phase B) |
                  |   - active-voter lookups (drep/pool/cc) |
                  |   - per-action upserts to DynamoDB      |
                  |     (idempotent compare-then-write)     |
                  +----------------------------------------+
                  | drep-directory     (every 30 min)       |
                  |   - drep_list / drep_info / drep_meta   |
                  |   - vote_list aggregation               |
                  |   - BatchGet existing rows, diff, Put   |
                  +----------------------------------------+
                                       |
                                       v
                       DynamoDB (8 tables, PAY_PER_REQUEST)
                  governance_actions, drep_directory, comments,
                  clubhouse_posts, users, drep_committees,
                  audit_log, auth_nonces
                                       |
                                       v
                       backend/src/handlers/*  (22 Lambdas)
                  auth/, governance/, directory/, drep/,
                  clubhouse/, comments/, profile/, epoch/
                                       |
                                       v
                          API Gateway HTTP API v2
                                       |
                                       v
                       CloudFront (api.drep.tools)
                       + WAF rate-limit (2k req / 5 min / IP)
                       + Cache-Control honoring (s-maxage=30)
                                       |
                                       v
                                  React SPA
                       (drep.tools, served from S3 + CloudFront,
                        CSP + HSTS via response-headers policy)
                                       |
                                       v
                              User in browser
                                       |
                                       v
                       CIP-30 wallet (Eternl / Lace / etc.)
                       MeshSDK -> COSE_Sign1 challenge response
```

### Wallet auth flow

```
   Browser                       /auth/challenge                 DynamoDB
   -------                       --------------                  --------
   POST {walletAddress}  -->  Lambda generates 32-byte
                              nonce, builds sign message,
                              writes auth_nonces row    -->  PutItem (TTL 5m)
   <--  {nonce, message, expiresAt}

   wallet.signData(addr, msg)  -->  COSE_Sign1 + COSE_Key

   POST /auth/verify {nonce, signature, key}
                              Lambda:
                                1. PeekChallenge(nonce)         <-- GetItem
                                2. CBOR-decode COSE_Sign1
                                3. Reconstruct Sig_Structure
                                4. Verify Ed25519 signature
                                5. ConsumeChallenge(nonce)      <-- DeleteItem
                                6. SignJWT (15-min access cookie)
   <--  Set-Cookie: access_token (HttpOnly; Secure;
                                  SameSite=Strict;
                                  Domain=.drep.tools)
```

## Quick start (new contributor)

Prerequisites: Node 20.x, npm 10+, AWS CLI v2, AWS account with the
`drep-platform` profile configured.

```bash
git clone https://github.com/adamrusch/drep-platform.git
cd drep-platform

# Install per-workspace deps
(cd backend  && npm install)
(cd frontend && npm install)
(cd infra    && npm install)

# Type-check everything
(cd backend  && npm run typecheck)
(cd frontend && npm run typecheck)
(cd infra    && npm run typecheck 2>/dev/null || tsc --noEmit)

# Deploy a personal dev stack (uses your AWS credentials)
cd infra
AWS_PROFILE=drep-platform npx cdk deploy --all --context stage=dev
```

The first deploy needs two secrets in Secrets Manager:

```bash
aws secretsmanager create-secret \
  --profile drep-platform \
  --name drep-platform/dev/jwt-secret \
  --secret-string "$(openssl rand -base64 64)"

aws secretsmanager create-secret \
  --profile drep-platform \
  --name drep-platform/dev/blockfrost-api-key \
  --secret-string "<your_blockfrost_project_id>"
```

Frontend dev loop:

```bash
cd frontend
VITE_API_BASE_URL=https://api.drep.tools npm run dev
# or point at your dev stack's API:
# VITE_API_BASE_URL=https://abc123.execute-api.us-east-1.amazonaws.com npm run dev
```

## Repo layout

```
drep-platform/
├── backend/             # Lambda handlers, sync code, lib helpers
│   └── src/
│       ├── handlers/    # 22 HTTP API handlers (auth, governance, …)
│       ├── lib/         # Shared modules (auth, blockfrost, koios, …)
│       ├── middleware/  # JWT authorizer + role guard
│       ├── sync/        # Two scheduled Lambdas (governance, directory)
│       └── types/       # Ambient .d.ts shims
├── frontend/            # React + Vite SPA
│   └── src/
│       ├── auth/        # CIP-30 wallet auth provider
│       ├── components/  # Reusable UI (cards, rails, primitives)
│       ├── hooks/       # TanStack Query hooks per surface
│       ├── lib/         # Axios client + utils
│       ├── pages/       # Route-level views
│       ├── stores/      # Zustand stores (auth, theme, ui)
│       └── styles/      # Cardano design tokens
├── infra/               # AWS CDK (4 stacks)
│   └── lib/
│       ├── database-stack.ts     # 8 DynamoDB tables + 9 GSIs
│       ├── api-stack.ts          # 22 Lambdas + HTTP API v2 + CloudFront/WAF + Budgets
│       ├── frontend-stack.ts     # S3 + CloudFront + CSP response headers
│       └── scheduler-stack.ts    # 2 scheduled sync Lambdas
├── shared/              # Shared types between frontend / backend (kept thin)
└── docs/                # ARCHITECTURE / RUNBOOK / SCHEMA / COST-MODEL / DECISIONS
```

## Deployment

### CDK (backend + infra)

```bash
cd infra
AWS_PROFILE=drep-platform npx cdk deploy --all --context stage=prod
# specific stacks
AWS_PROFILE=drep-platform npx cdk deploy DRepPlatform-Api-prod --context stage=prod
```

CloudFormation outputs (frontend bucket name, distribution IDs, API URL) are
exported per-stage with the prefix `<stage>-…` so other stacks can import them.

### Frontend (S3 + CloudFront)

```bash
cd frontend
VITE_API_BASE_URL=https://api.drep.tools npm run build

aws s3 sync dist/ s3://drep-platform-prod-frontend-409410541898/ \
  --profile drep-platform --delete

aws cloudfront create-invalidation \
  --profile drep-platform \
  --distribution-id <DistributionId from CFN output> \
  --paths "/*"
```

Invalidations are free up to 1000/month — well above what we need.

## Operational state

- **Sync logs**: `aws logs tail /aws/lambda/drep-platform-prod-governance-intake-sync --follow --profile drep-platform`
- **Directory logs**: `/aws/lambda/drep-platform-prod-drep-directory-sync`
- **Circuit breaker state**: GetItem on `drep-platform-prod-auth_nonces`
  with key `nonce='_circuit:blockfrost'`. If present and `expiresAt > now()`
  the governance sync skips its run; auto-clears via DynamoDB TTL after
  ~6 hours. See `backend/src/lib/circuitBreaker.ts`.
- **Koios health**: `curl -s https://api.koios.rest/api/v1/tip | jq` —
  if degraded, the governance sync falls back to Blockfrost, and the
  directory sync skips its cycle (no Blockfrost path for the directory).
- **Blockfrost quota**: log in to blockfrost.io, check the daily quota on
  the project tied to `drep-platform/prod/blockfrost-api-key`. The
  Discovery tier is 1M requests/day; current burn is ~316k/day (governance
  sync + epoch + delegation-history).

## Cost model

Steady-state runs at **$1–3/month** for the AWS-side stack. Drivers:

| Service | Monthly | Notes |
|---------|---------|-------|
| Lambda  | < $0.10 | All workloads sit in free tier today |
| DynamoDB | < $0.50 | PAY_PER_REQUEST; idempotent syncs keep WCU low |
| API Gateway | < $0.10 | $1/M req, current volume well under 1M |
| CloudFront | < $0.20 | Egress + per-request, cache absorbs most |
| WAF | $1.00 | $1/rule baseline + $0.60/M inspected |
| Route 53 | $0.50 | One hosted zone |
| Secrets Manager | $0.80 | $0.40/secret × 2 |
| Budgets | $0 | Free service |

External (not on AWS):
- **Koios**: free
- **Blockfrost**: Discovery tier is free up to 1M req/day. Paid Build tier
  ($39/mo) only needed if Koios outages become routine and we exceed quota.

Failure modes that could spike cost (and the protections in place):

- **Botnet on `/dreps` or `/governance`** → CloudFront cache (30s s-maxage)
  serves them; WAF rate-limits at 2000 req / 5 min / IP.
- **DynamoDB write hotpath leak** → idempotent compare-then-write on both
  syncs; module-level cache on hot read paths; AWS Budgets ($5 soft / $20
  hard) alert before damage compounds.
- **Blockfrost over-quota cascade** → persistent circuit breaker
  (`circuitBreaker.ts`) trips on 402/429 and skips Blockfrost calls for 6h,
  letting the rolling window clear.

See [`docs/COST-MODEL.md`](docs/COST-MODEL.md) for line-by-line projections.

## Where to read more

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system diagrams,
  per-surface data flow, caching layers, security model
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — operational triage for sync
  outages, cost spikes, deploy rollbacks, wallet auth failures
- [`docs/SCHEMA.md`](docs/SCHEMA.md) — DynamoDB table layout, GSI
  rationale, schema versioning history
- [`docs/COST-MODEL.md`](docs/COST-MODEL.md) — per-service cost
  projections and breakage-mode analysis
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — Architecture Decision
  Records for major engineering choices

Per-area orientation:

- [`backend/src/lib/README.md`](backend/src/lib/README.md)
- [`backend/src/sync/README.md`](backend/src/sync/README.md)
- [`backend/src/handlers/README.md`](backend/src/handlers/README.md)
- [`infra/lib/README.md`](infra/lib/README.md)
- [`frontend/src/components/README.md`](frontend/src/components/README.md)
- [`frontend/src/pages/README.md`](frontend/src/pages/README.md)

Background briefs (kept as historical context, not maintained):

- `RESUME.md` — build status snapshot
- `QA_PLAN.md` / `QA_RESULTS.md` / `QA_FINAL.md` — QA pass artifacts
- `DESIGN_PARITY_STRUCTURAL.md` / `DESIGN_PARITY_VISUAL.md` — design handoff
  parity audit

## License

This repository does not currently include a LICENSE file. All rights
reserved by the repository owner until a license is selected. Contact the
maintainer before redistributing or building derivative works.
