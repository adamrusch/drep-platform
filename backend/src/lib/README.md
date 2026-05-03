# `backend/src/lib/`

Shared modules used by the sync Lambdas and the HTTP handlers. Each
module owns a single concern; nothing here mounts or processes HTTP
requests directly.

## Modules

| File | Purpose |
|------|---------|
| `auth.ts` | CIP-30 wallet signature verification (COSE_Sign1 + Ed25519), JWT issuance/validation, challenge & mutation-nonce lifecycle |
| `blockfrost.ts` | Blockfrost API client wrapper. Fallback metadata path; recognition pills; `/epoch`; deterministic chain-math fallback for /epoch |
| `circuitBreaker.ts` | Persistent circuit breaker for Blockfrost 402/429 quota outages. Marker stored in `auth_nonces` with TTL; sync skips runs when open |
| `dynamodb.ts` | DocumentClient setup, table-name helpers, generic `getItem` / `putItem` / `queryItems` / `batchGetItems` / `transactWrite` wrappers |
| `governanceSummary.ts` | Per-action-type formatters that turn the on-chain `governance_description` tagged-union into a one-line `summary` + structured `details` for the frontend |
| `koios.ts` | Koios API client. Primary metadata source. Bulk endpoints (`proposal_list`, `drep_list`, `drep_info`, `drep_metadata`, `vote_list`, `pool_list`, `committee_info`, `tip`). Module-level caches with conservative TTLs |
| `proposalPillar.ts` | gov.tools forum-draft fallback. Used only when an action has no usable on-chain CIP-108 anchor body. Best-effort — errors degrade silently |
| `recognition.ts` | Recognition-pill enrichment for comments/clubhouse posts. Fetches author's stake amount + DRep delegation from Blockfrost; soft-fails if Blockfrost is down |
| `types.ts` | Shared TypeScript types: `GovernanceAction`, `VoteTally`, `DRepDirectoryItem`, `JWTPayload`, etc. Includes detailed JSDoc on every field |
| `voteTally.ts` | Pure-function vote-tally math with CIP-1694 ratification slices (yes/no/notVoted summing to totalActive). Auto-abstain handled per spec; auto-no-confidence direction-flips on NoConfidence actions |

## Conventions

- **No HTTP here.** Handlers compose these modules; lib code never reads
  `event` or returns API Gateway responses.
- **Module-level caches** are wiped on cold start and exist only to dedupe
  work within a warm container. They're optimization, not correctness.
- **Errors propagate as typed exceptions** (`KoiosError`,
  `BlockfrostQuotaError` markers via `isBlockfrostQuotaError()`); the
  handlers/syncs decide how to react.
- **Pure where possible.** `voteTally.ts` and `governanceSummary.ts`
  have no I/O. `auth.ts` is partially I/O (Secrets Manager, DynamoDB)
  but with explicit caching at the boundary.

## Adding a new module

1. Create `lib/<name>.ts` with a top-of-file JSDoc explaining the
   module's purpose in 5-10 lines.
2. Export the public surface; keep helpers `function` (not `export`).
3. Document any non-obvious decisions inline. The reader should
   understand the *why* without needing to read commit history.
4. If the module talks to an upstream service, define a typed error
   class so callers can pattern-match on it.
