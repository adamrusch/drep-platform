# `backend/src/sync/`

Two scheduled Lambdas that populate the canonical state in DynamoDB from
Cardano chain data. Triggered by EventBridge rules defined in
`infra/lib/scheduler-stack.ts`.

## Syncs

| File | Cadence | Purpose |
|------|---------|---------|
| `governance-intake.ts` | every 1 minute | Pulls governance actions, lifecycle epochs, vote tallies, and active-voter denominators. Writes to `governance_actions`. |
| `drep-directory.ts` | every 30 minutes | Pulls every registered DRep (active + inactive + retired) with CIP-119 anchor metadata and per-DRep `lastVotedAt` aggregation. Writes to `drep_directory`. |

## Shape

Both syncs follow the same skeleton:

1. **Circuit / fallback check** — bail out cleanly if upstream is known-bad.
2. **Bulk fetch** — Koios primary, Blockfrost fallback.
3. **Build candidate rows** — apply the enrichment math (`voteTally.ts`,
   `governanceSummary.ts`, etc.).
4. **Compare existing rows** (BatchGet or per-row GetItem) ignoring the
   volatile `lastSyncedAt` field.
5. **PutItem only when something changed** — idempotent. Schema migrations
   force a write via the `enrichmentVersion` constant.
6. **Log a structured summary** — `total / written / skipped / errors`
   counts.

This idempotency is not optional. Both syncs were previously Putting
every row every cycle, costing ~$2-4/day in DynamoDB writes. See ADR-007
in `docs/DECISIONS.md`.

## Schema versioning

Every row carries `enrichmentVersion: N`. Bumping the constant in code
forces a re-write of every row on the next cycle. The full version
history with per-bump rationale lives in the source comments at the top
of each file:

- `governance-intake.ts:67-156` — currently `ENRICHMENT_VERSION = 11`
- `drep-directory.ts:96-108` — currently `ENRICHMENT_VERSION = 3`

When changing row shape, ALWAYS bump the version and update the JSDoc.
The next sync cycle re-stamps every row; no manual backfill required.

## Adding a new sync

1. Create `backend/src/sync/<name>.ts` with the standard skeleton.
2. Add a Lambda + EventBridge rule in `infra/lib/scheduler-stack.ts`.
3. Grant the role read/write access to whichever DynamoDB tables it
   touches. Don't blanket-grant — least-privilege per role.
4. Document the cadence, upstream dependencies, idempotency strategy,
   and schema versioning at the top of the file.
5. If the sync hits an upstream that can rate-limit, hook into
   `lib/circuitBreaker.ts` so a quota outage doesn't burn the whole
   day's budget on rejected calls.
