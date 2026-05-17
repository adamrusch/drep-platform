# DRep Platform — Build Status

## Complete ✅
- Monorepo structure (infra/, backend/, frontend/, shared/)
- AWS CDK stacks: DatabaseStack, ApiStack, FrontendStack, SchedulerStack
- All Phase 1 DynamoDB tables defined
- All Phase 1 Lambda handlers scaffolded (auth, governance, comments, clubhouse, drep, profile)
- Backend lib: dynamodb client, blockfrost wrapper, JWT auth (runtime Secrets Manager fetch), shared types
- JWT authorizer Lambda + role-guard middleware
- Blockfrost governance-intake sync (EventBridge every 2 minutes)
- React frontend: all pages, components, hooks, stores, auth
- Design system integrated (custom CSS + Cardano brand tokens)
- App shell: topbar, sidebar, routing
- TypeScript compiles clean in all workspaces
- npm deps installed in all workspaces (including vite-plugin-wasm, vite-plugin-top-level-await)
- **CDK deployed to AWS** — dev stack live
  - API Gateway: https://i9la4x29c6.execute-api.us-east-1.amazonaws.com/dev
  - CloudFront: https://d31k3mmkrkmdvl.cloudfront.net
  - S3 bucket: drep-platform-dev-frontend-409410541898
  - CloudFront distribution: E2DICV1F3XXMNR
- **Frontend built and deployed** to S3 + CloudFront (vite build ✅)
  - Fixed: libsodium-sumo.mjs resolution via custom Rollup plugin in vite.config.ts
  - Fixed: import order (design-system.css before Tailwind)
- **CIP-30 Ed25519 signature verification** implemented in backend/src/lib/auth.ts
  - CBOR decodes COSE_Sign1 structure (cbor-x)
  - Reconstructs Sig_Structure and verifies with Node.js crypto (Ed25519)
  - Extracts public key from COSE_Key (-2 field)
- **GitHub repo created**: https://github.com/adamrusch/drep-platform (private)
- Cardano network: **Mainnet** for all environments

## Key AWS Resources
- Account: 409410541898
- Region: us-east-1
- CDK bootstrapped: ✅
- Profile: drep-platform
- Blockfrost key: stored in Secrets Manager at `drep-platform/dev/blockfrost-api-key`
- JWT secret: stored in Secrets Manager at `drep-platform/dev/jwt-secret`
- EventBridge sync: every 10 minutes (lowered from 2min after the dev Blockfrost project hit its daily quota — see QA_FINAL.md)

## Day 4 — adastat-style governance card layout
- Backend mapper (`mapBlockfrostProposalToGovernanceAction`) no longer
  synthesizes `title` from the on-chain summary. `title` is now optional
  and populated only from CIP-108 anchor body. `summary` stays as the
  human-readable subtitle. `ENRICHMENT_VERSION` bumped 3 → 4.
- Frontend cards + detail page re-laid out around Title / Type / Hash /
  Metadata. Hash is click-to-copy with a toast. Metadata link opens the
  CIP-108 anchor URL. Footer links to adastat + cardanoscan (`#`
  percent-encoded). Bundle delta: +0.06 kB gzipped.
- Re-enrichment to v4 is gated on the Blockfrost daily quota recovering;
  the frontend has a defensive fallback that detects legacy synthetic
  titles (title === summary || title === actionId, no anchorUrl) so the
  new UX renders today regardless of the backend record version.

## Remaining / Phase 1-D+
- [ ] Phase 1-D: Write tests (unit tests for auth.ts, integration tests for key flows)
- [ ] SES email identity verification (if email features needed)
- [ ] Phase 2: Committee voting, sentiment tracking, rationale documents, on-chain submission
- [ ] Phase 2: DRep registration on-chain via wallet signing
- [ ] Performance: chunking optimization for mesh-sdk (~6.8MB bundle — consider dynamic import)

## Phase C — Koios primary everywhere (2026-05-17)

- All steady-state Blockfrost calls migrated to Koios with Blockfrost fallback.
  See `MIGRATION_PHASE_C.md` for the full inventory + status.
- New Koios wrappers in `backend/src/lib/koios.ts`: `fetchAccountInfo`,
  `getCurrentEpochInfo`, `fetchDRepPowerHistory`.
- Migrated callsites (all keep Blockfrost as fallback):
  - `epoch/get.ts` — Koios `/tip` + `/epoch_info` primary
  - `lib/recognition.ts` — Koios `/account_info_cached` primary
  - `profile/delegationHistory.ts` — Koios `/account_info_cached` primary + 60s LRU
    (Class C → Class B per Phase 2 audit)
- New table `governance_votes` — append-only per-vote event log populated
  by the existing governance-intake sync from Koios `/vote_list`.
  High-water-mark watermark keeps steady-state cost ~50 WCU/cycle.
- New table sub-rows on `drep_directory` — `POWER#`-prefixed voting-power
  history rows. Populated daily by new `drep-voting-power-history` sync
  Lambda. Surfaced as `votingPowerHistory[]` on the directory detail handler.
- After Phase C, Blockfrost Discovery tier can be safely downgraded to free —
  steady-state call volume drops to ~zero (only fires on Koios outage).
