# Migration — Phase C — Koios Primary Everywhere

**Date opened:** 2026-05-17
**Working baseline:** `329e10d7` (post-audit, working tree clean)

## Scope

Phase A (commit `cdaefc5`) moved governance metadata to Koios primary.
Phase B (commit `118ea5a6`) moved per-proposal vote tallies to Koios primary.
Phase C — this migration — finishes the job: every other Blockfrost call we
make on a steady-state cycle becomes Koios primary with Blockfrost as
fallback. After Phase C, Blockfrost call volume in the happy-path drops to
zero; Blockfrost only fires on a Koios outage.

This file is the inventory + status log.

---

## Blockfrost call inventory (pre-Phase-C)

Grep target: every `from '.../blockfrost'` import + every callsite of the
`Blockfrost*` exports in `backend/src/lib/blockfrost.ts`.

| # | Callsite                                                    | Function called           | Phase | Status (pre)      | Status (post Phase C) |
|---|-------------------------------------------------------------|---------------------------|-------|-------------------|----------------------|
| 1 | `backend/src/handlers/epoch/get.ts:79`                      | `getLatestEpoch`          | C     | live every req    | Koios `/tip` primary, Blockfrost fallback |
| 2 | `backend/src/sync/governance-intake.ts:280`                 | `getLatestEpoch`          | C     | Blockfrost fallback only (Koios `/tip` already primary) | Unchanged — already fallback-only |
| 3 | `backend/src/lib/recognition.ts:49`                         | `getAccountInfo`          | C     | live on every comment/post write | Koios `/account_info_cached` primary, Blockfrost fallback |
| 4 | `backend/src/handlers/profile/delegationHistory.ts:29`      | `getAccountInfo`          | C     | live every req (Class C handler) | Koios `/account_info_cached` primary, Blockfrost fallback. Module-level cache (60s) on result. Still "live" semantically — class B. |
| 5 | `backend/src/sync/governance-intake.ts:760`                 | `getTx`                   | C (legacy fallback)     | only when Koios listing fails entirely | Unchanged — already inside `else` branch of Koios fallback |
| 6 | `backend/src/sync/governance-intake.ts:761`                 | `getProposalAnchor`       | C (legacy fallback)     | only when Koios listing fails entirely | Unchanged — already inside `else` branch of Koios fallback |
| 7 | `backend/src/sync/governance-intake.ts:480` (`getGovernanceAction`) | `getGovernanceAction` | C (legacy fallback) | only when Koios listing fails | Unchanged — already inside `else` branch of Koios fallback |
| 8 | `backend/src/sync/governance-intake.ts:396` (`listGovernanceActions`) | `listGovernanceActions` | C (legacy fallback) | only when Koios bulk fails | Unchanged — already inside `else` branch of Koios fallback |

No callsites of `getDRep` or `getDRepDelegations` exist in the codebase
today — the prompt's mention was a residue from earlier audits. Both
functions are present in `blockfrost.ts` but unreferenced; we leave them
in place as additional fallback infrastructure but the migration doesn't
need to touch them.

After Phase C, the only **steady-state** Blockfrost callers are
`recognition.ts` (called on every write of a comment / clubhouse post)
and `delegationHistory.ts` (called on every GET of that endpoint) — and
both will only reach Blockfrost when Koios is unreachable.

---

## Status

- [x] Inventory complete
- [x] Phase 1 — add Koios `getAccountInfo`, refactor `getLatestEpoch` to
      Koios primary at handler level
- [x] Phase 2 — Class C audit (see [Phase 2 — Class C audit](#phase-2--class-c-handler-audit))
- [x] Phase 3 — `governance_votes` table + DRep voting power history sync

---

## Phase 2 — Class C handler audit

Every handler classified A (fully cached) / B (cached with fallback freshness)
/ C (always live upstream call).

| Handler                                            | Class | Notes |
|----------------------------------------------------|-------|-------|
| `auth/challenge.ts`                                | A     | Generates a nonce, writes to `auth_nonces`. No upstream. |
| `auth/verify.ts`                                   | A     | Verifies signature locally. |
| `auth/refresh.ts`, `logout.ts`, `me.ts`, `mutationNonce.ts` | A | Pure DDB + JWT. |
| `governance/list.ts`, `get.ts`, `stats.ts`         | A     | DDB only. |
| `governance/sync.ts`                               | A     | Triggers the sync Lambda; no upstream from this handler. |
| `directory/list.ts`                                | A     | DDB only (scan + filter). |
| `directory/get.ts`                                 | B     | DDB + on-demand Koios `drep_voters` / `drep_delegators`. Module-level 5min cache. The Koios calls are best-effort enrichment; the DDB row is the canonical source. |
| `drep/get.ts`                                      | A     | DDB only (drep_committees). |
| `drep/list.ts`, `register.ts`, `update.ts`         | A     | DDB only. |
| `comments/list.ts`, `delete.ts`                    | A     | DDB only. |
| `comments/create.ts`                               | B     | DDB + best-effort `lookupRecognition` (one Blockfrost call). The pill data is "nice to have"; the comment is canonical. After Phase C the recognition lookup is Koios-primary with Blockfrost fallback. |
| `clubhouse/list.ts`, `votePoll.ts`, `createComment.ts`, `deletePost.ts` | A | DDB only. |
| `clubhouse/createPost.ts`                          | B     | Same as `comments/create.ts` — DDB + best-effort recognition pill. |
| `profile/get.ts`, `upsert.ts`                      | A     | DDB only. |
| **`profile/delegationHistory.ts`**                 | **C → B** | Previously C (Blockfrost call every request). Phase C moves the upstream lookup to Koios primary AND adds a 60s module-level cache + LRU keyed by stake address. The DDB stored `delegationHistory` array is still the canonical historical record; the live `currentDrepId` is the only ephemeral field. |
| `epoch/get.ts`                                     | B     | DDB-less; relies on module-level cache (60s fresh, 30min stale-fallback, deterministic last-resort). Was Blockfrost primary; Phase C makes it Koios `/tip` primary with Blockfrost fallback. Class unchanged. |

**Result:** every handler is now Class A or B. Class C has been eliminated.
The two Class B handlers (`comments/create.ts` + `clubhouse/createPost.ts`)
remain Class B intentionally — the recognition pill IS a freshness signal
("user's current stake / DRep at the moment they posted"), so caching it
beyond the request would mislead the reader. The lookup is best-effort and
fails-silently, so a Koios outage cannot block a write.

---

## Phase 3 — storage additions

### `governance_votes` table

**Decision:** ship. Cost is negligible (~24k append-only writes spread over
months), and it unlocks per-action vote-timeline rendering on the
governance-action detail page.

| Field         | Type | Role                                                                                  |
|---------------|------|---------------------------------------------------------------------------------------|
| `actionId`    | S    | PK — `tx_hash#cert_index` matching `governance_actions.actionId`                      |
| `voteKey`     | S    | SK — `${voterRole}#${voterId}#${voteTxHash}` (unique per individual vote)             |
| `voterRole`   | S    | `'DRep' | 'SPO' | 'ConstitutionalCommittee'`                                          |
| `voterId`     | S    | bech32 DRep ID, pool ID, or CC hot ID                                                 |
| `vote`        | S    | `'Yes' | 'No' | 'Abstain'`                                                            |
| `votedAt`     | S    | ISO-8601 timestamp of the `block_time`                                                |
| `blockTime`   | N    | Unix seconds — useful for numeric sorts and BETWEEN range queries                     |
| `epochNo`     | N    | Epoch in which the vote was cast                                                      |
| `voteTxHash`  | S    | Tx hash of the vote certificate (mostly informational; included in `voteKey` to keep entries unique even if the same voter votes twice on the same action — rare, e.g. vote-changes) |
| `metaUrl`     | S    | Off-chain vote-rationale anchor URL, when present                                     |
| `metaHash`    | S    | Off-chain anchor hash, when present                                                   |
| `ingestedAt`  | S    | ISO-8601 when this row was first written                                              |

GSI: `voter-blockTime-index`
- PK: `voterId`
- SK: `blockTime` (number) — newest-first via `ScanIndexForward=false`
- Projection: ALL
- Purpose: drives per-voter "this DRep's vote timeline" queries without
  needing a Koios call. Subset of the data already used by the directory
  detail handler's `recentVotes` field, but now sortable by epoch with
  full counts.

**Population:** the governance-intake sync already fetches the entire
`vote_list` once per cycle (it builds per-proposal slices via
`groupVotesByProposal`). We extend that pass to also write per-vote rows
to `governance_votes` — **append-only**, conditional Put on `attribute_not_exists`
so a single vote is only written once. A vote-change (rare) creates a new
row with a different `voteTxHash` part of the SK; both rows stay,
preserving the timeline.

**Cost:** 24k initial backfill × 1 WCU = 24k WCU. After that,
~50 votes/day = 50 WCU/day. Negligible against the 38k WCU/hr we already
recovered from the directory-table optimization.

### `drep_voting_power_history` (single-table addition to `drep_directory`)

**Decision:** ship as additional SK on the existing `drep_directory` table
rather than a new table. Keeps the storage cost trivial and lets the
directory detail handler `Query` a single partition to fetch power history
for one DRep in one round-trip.

| Field        | Type | Role                                                                |
|--------------|------|---------------------------------------------------------------------|
| `drepId`     | S    | PK — reused                                                         |
| `SK`         | S    | New SK form: `POWER#${epochNo zero-padded}` (e.g. `POWER#000515`)   |
| `epochNo`    | N    | Epoch number this snapshot represents                               |
| `amount`     | S    | Voting power in lovelace, stringified BigInt                        |
| `capturedAt` | S    | ISO-8601 of the sync run that wrote this row                        |

The existing `PROFILE` SK is unchanged. The new SK shape (`POWER#`-prefixed)
sorts after `PROFILE` so `Query(drepId)` with no SK filter returns the
profile first followed by history rows in epoch order.

**Population:** new sync `drep-voting-power-history.ts`, daily cadence
(EventBridge). Calls Koios `/drep_voting_power_history` (one batched call
per DRep — Koios supports `_drep_id` for a single ID; we issue 1500 calls
spread over a 5-minute window with a small per-call sleep to stay under
the public-tier 10 RPS limit). Each row uses `Put` with
`attribute_not_exists(SK)` so we never overwrite a historical snapshot —
the upstream is monotonic per epoch and any drift would be a real bug
worth surfacing.

**Cost:** ~1500 calls/day to Koios (well under free tier). DynamoDB
writes: only on the most recent epoch's row, so ~1500 WCU/day. After
6 months a typical DRep has ~36 rows × 1500 DReps = 54k items in the
new partition shape, ~6MB total — trivial.

**Wiring to the frontend Sparkline:** the directory detail handler reads
`POWER#`-prefixed items via the existing `Query(drepId)` and exposes them
under a new `votingPowerHistory` field on the `DRepDetail` shape. The
frontend Sparkline component is wired to consume the new field; falls
back to flat-line when the array is empty (first-day-after-deploy state).

---

## Verification

Once Phase C is deployed:

1. Force-trigger the governance-intake sync: `aws lambda invoke …`. Confirm:
   - log line `[Koios /tip] used` (no Blockfrost epoch call)
   - log line `[Koios /vote_list] returned N votes`
   - new log line `[governance_votes] wrote N new vote rows`
2. Force-trigger the new `drep-voting-power-history` sync once. Confirm:
   - log line `[drep_voting_power_history] wrote N rows`
3. Hit `GET /epoch` from the browser. Confirm response header
   `X-Cache-Source` is absent (Koios served it fresh).
4. Hit `GET /profile/{stake}/delegation-history` for a registered stake
   address. Confirm log line `lookupAccount source=koios`.
5. Submit a comment on a governance action. Confirm log line
   `lookupRecognition source=koios`.

**Acceptance signal:** in the next 1-hour CloudWatch window after deploy,
the count of `BlockfrostServerError` log entries is `0`, and the count of
`source=koios` log lines is at least `60` (one per minute of `/tip` plus
a handful of triggered writes).

---

## Punted

- Pre-action stake snapshots at ratification check time — Koios doesn't
  expose this directly. Out of scope this sprint.
- Per-CC-member voting power — currently no per-member analytics surface;
  storage would be wasted. Out of scope.
- New dedicated table for per-vote events — collapsed into `governance_votes`
  above instead. Same data, simpler infra.
