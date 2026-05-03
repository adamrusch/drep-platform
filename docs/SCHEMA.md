# DynamoDB Schema

Source of truth: `infra/lib/database-stack.ts`. This document narrates the
"why" behind each table, GSI, and access pattern.

All tables:
- Billing: PAY_PER_REQUEST
- Point-in-time recovery: enabled
- Removal policy: RETAIN on prod, DESTROY on non-prod (unblocks dev cleanup)
- Region: us-east-1

Table-name prefix on every table: `drep-platform-{stage}-` (`prod`, `dev`,
`staging`). Examples below use the `prod` stage.

## Contents

- [users](#users)
- [drep_committees](#drep_committees)
- [drep_directory](#drep_directory)
- [governance_actions](#governance_actions)
- [comments](#comments)
- [clubhouse_posts](#clubhouse_posts)
- [audit_log](#audit_log)
- [auth_nonces](#auth_nonces)
- [Schema versioning history](#schema-versioning-history)
- [Item size considerations](#item-size-considerations)

---

## users

User profile records — display name, bio, role assignments. Created on
first wallet auth.

| Field | Type | Role |
|-------|------|------|
| `walletAddress` | S | PK — Cardano stake address (bech32) |
| `SK` | S | Sort key — `'PROFILE'` for the user record |
| `displayName` | S | optional, indexed |
| `bio` | S | optional |
| `roles` | SS | `['delegator', 'lead_drep', ...]` |
| `email` | S | optional, future SES use |
| `createdAt` | S | ISO-8601 |
| `lastSeenAt` | S | ISO-8601 |

GSI: `displayName-index`
- PK: `displayName`
- Projection: INCLUDE `walletAddress, bio, roles, createdAt`
- Access pattern: search profiles by display name

Sample item:

```json
{
  "walletAddress": "stake1u9...",
  "SK": "PROFILE",
  "displayName": "alice",
  "roles": ["delegator", "lead_drep"],
  "createdAt": "2026-04-15T08:30:00Z"
}
```

---

## drep_committees

Platform-internal coordination committees — distinct from on-chain DReps.
Lead DReps register a committee here for delegator coordination.

| Field | Type | Role |
|-------|------|------|
| `drepId` | S | PK — committee identifier |
| `SK` | S | Sort key — `'COMMITTEE'` |
| `leadWallet` | S | Bech32 stake address of the committee lead |
| `name` | S | Display name |
| `createdAt` | S | ISO-8601 |
| `members` | L | List of member wallet addresses |
| ... | | (further fields TBD) |

GSIs:
- `leadWallet-index` — PK `leadWallet`, projection ALL. Lookup committees
  led by a given wallet.
- `SK-createdAt-index` — PK `SK`, sort `createdAt`. Browse-all index. Every
  row carries `SK='COMMITTEE'` so the partition is single-keyed; with
  PAY_PER_REQUEST + adaptive capacity this is acceptable up to ~1000
  committees. Documented in `database-stack.ts:59-68` — revisit at scale.

Sample item:

```json
{
  "drepId": "drep_committee_01ARZ3...",
  "SK": "COMMITTEE",
  "leadWallet": "stake1u9...",
  "name": "Alice's Coordination",
  "createdAt": "2026-04-15T10:00:00Z",
  "members": []
}
```

---

## drep_directory

Mainnet DRep registry — chain-state directory of every registered DRep
(both active and retired). Populated by `sync/drep-directory.ts` from
Koios. **Distinct from `drep_committees`** — committees are platform-side
coordination records, this is a read-only chain mirror.

| Field | Type | Role |
|-------|------|------|
| `drepId` | S | PK |
| `SK` | S | Sort key — `'PROFILE'` |
| `hex` | S | Hex-encoded DRep credential |
| `isActive` | BOOL | Lifecycle: live registration AND voted recently |
| `isRetired` | BOOL | Filed a retirement certificate |
| `status` | S | `'active' \| 'inactive' \| 'retired' \| 'unknown'` |
| `votingPower` | S | Stringified BigInt (lovelace) |
| `votingPowerSort` | S | Zero-padded 24-char string for GSI sort |
| `votingPowerPartition` | S | Always `'ALL'` — single-partition GSI |
| `delegatorCountSort` | S | Zero-padded for `delegatorCount-index` |
| `delegatorCountPartition` | S | Always `'ALL'` |
| `lastVotedAt` | S | ISO-8601 of most recent vote (if any) |
| `lastVotedSort` | S | Same as `lastVotedAt` (ISO sorts lexicographically) |
| `lastVotedPartition` | S | Always `'ALL'`, only set if voted |
| `voteCount` | N | Total votes ever cast |
| `expiresEpoch` | N | Epoch at which registration expires |
| `anchorUrl` | S | CIP-119 anchor URL |
| `anchorHash` | S | Anchor hash |
| `anchorVerified` | BOOL | Indexer's anchor-validity verdict |
| `givenName` | S | CIP-119 body — DRep name |
| `givenNameLower` | S | Lowercased for case-insensitive search |
| `image` | S | Avatar URL |
| `objectives` | S | CIP-119 body |
| `motivations` | S | CIP-119 body |
| `qualifications` | S | CIP-119 body |
| `paymentAddress` | S | Optional |
| `references` | L | List of `{kind, label, uri}` |
| `enrichmentVersion` | N | Schema migration trigger |
| `lastSyncedAt` | S | ISO-8601 of last successful sync |

GSIs (all single-partition for global ordering):
- `votingPower-index` — sort by voting power desc
- `delegatorCount-index` — sort by delegator count desc
- `lastVoted-index` — sort by recent activity; never-voted DReps absent

Single-partition pattern is documented inline in `database-stack.ts:86-124`.
Acceptable at ~2000 rows with PAY_PER_REQUEST adaptive capacity. Revisit at
~10k rows.

Sample item:

```json
{
  "drepId": "drep1...",
  "SK": "PROFILE",
  "hex": "abcd1234...",
  "isActive": true,
  "isRetired": false,
  "status": "active",
  "votingPower": "1234567890123",
  "votingPowerSort": "000000000001234567890123",
  "votingPowerPartition": "ALL",
  "lastVotedAt": "2026-04-30T18:22:00Z",
  "lastVotedSort": "2026-04-30T18:22:00Z",
  "lastVotedPartition": "ALL",
  "voteCount": 47,
  "anchorUrl": "https://example.com/drep.json",
  "anchorVerified": true,
  "givenName": "alice",
  "givenNameLower": "alice",
  "image": "https://example.com/avatar.png",
  "enrichmentVersion": 3,
  "lastSyncedAt": "2026-05-01T12:00:00Z"
}
```

---

## governance_actions

CIP-1694 governance actions on mainnet. Populated by
`sync/governance-intake.ts` every minute.

| Field | Type | Role |
|-------|------|------|
| `actionId` | S | PK — `tx_hash#cert_index` |
| `SK` | S | Sort key — `'ACTION'` |
| `actionType` | S | One of seven CIP-1694 types |
| `title` | S | From CIP-108 anchor body or pillar fallback |
| `summary` | S | One-line synthesis from on-chain description |
| `description` | S | Long human-readable description |
| `submittedAt` | S | ISO-8601 of submission tx block_time |
| `epochDeadline` | N | Expiry epoch |
| `status` | S | `'active' \| 'expired' \| 'enacted' \| 'dropped'` |
| `anchorUrl` | S | CIP-108 anchor URL |
| `anchorHash` | S | Anchor hash |
| `anchorVerified` | BOOL | Indexer's verdict |
| `abstract`, `motivation`, `rationale` | S | Anchor body fields |
| `references` | L | List of `{kind, label, uri}` |
| `proposalPillarUrl` | S | gov.tools forum draft (fallback only) |
| `proposalPillarId` | N | Numeric forum ID |
| `metadataSource` | S | `'on-chain-anchor' \| 'proposal-pillar' \| 'none'` |
| `proposerAddress` | S | Stringified BigInt for treasury actions |
| `treasuryWithdrawalLovelace` | S | (TreasuryWithdrawals only) sum |
| `votes` | M | Per-role tally with CIP-1694 ratification slices |
| `votingRoles` | M | Per-role applicability map |
| `enrichmentVersion` | N | Schema migration trigger |
| `lastSyncedAt` | S | |

GSIs:
- `status-submittedAt-index` — PK `status`, sort `submittedAt`. Powers the
  governance list page filtering by status.
- `epochDeadline-index` — PK `epochDeadline`, projection INCLUDE
  `actionId, title, status, actionType`. Powers "actions expiring next
  epoch" widgets.

Sample item:

```json
{
  "actionId": "abc123...#0",
  "SK": "ACTION",
  "actionType": "TreasuryWithdrawals",
  "title": "Catalyst Fund 12 Disbursement",
  "summary": "Withdraw 50,000,000 ₳ to address stake_test1...",
  "submittedAt": "2026-04-20T15:00:00Z",
  "epochDeadline": 552,
  "status": "active",
  "anchorUrl": "https://example.com/cip108.json",
  "anchorVerified": true,
  "metadataSource": "on-chain-anchor",
  "treasuryWithdrawalLovelace": "50000000000000",
  "votes": {
    "drep": {
      "yes": {"count": 12, "power": "5000000000000"},
      "no":  {"count": 3,  "power": "1000000000000"},
      "abstain": {"count": 0, "power": "0"},
      "notVoted": {"count": 1219, "power": "30000000000000"},
      "totalActive": {"count": 1234, "power": "36000000000000"}
    },
    "spo": { ... },
    "committee": { ... },
    "autoAbstainPower": "...",
    "autoNoConfidencePower": "..."
  },
  "votingRoles": {"drep": true, "spo": false, "committee": true},
  "enrichmentVersion": 11,
  "lastSyncedAt": "2026-05-01T12:00:00Z"
}
```

---

## comments

Threaded comments scoped to a governance action.

| Field | Type | Role |
|-------|------|------|
| `actionId` | S | PK — the governance action being discussed |
| `commentId` | S | Sort key — ULID for chronological ordering |
| `walletAddress` | S | Author |
| `displayName` | S | Author's profile display name (denormalized) |
| `body` | S | Comment text (Markdown) |
| `createdAt` | S | ISO-8601 |
| `parentCommentId` | S | optional — reply threading |
| `recognition` | M | `{stakeAda, drep}` enrichment from Blockfrost |

GSI: `walletAddress-index` — PK `walletAddress`, projection ALL. Powers
"all comments by this user" on profile pages.

---

## clubhouse_posts

DRep-authored posts and polls visible to that DRep's delegator base.

| Field | Type | Role |
|-------|------|------|
| `drepId` | S | PK — the clubhouse owner |
| `postId` | S | Sort key — ULID |
| `authorWallet` | S | Whoever wrote the post |
| `body` | S | Markdown |
| `createdAt` | S | ISO-8601 |
| `pollOptions` | L | Optional poll definition |
| `pollVotes` | M | Per-option vote counts (server-trusted) |
| `recognition` | M | `{stakeAda, drep}` |

GSI: `authorWallet-index` — PK `authorWallet`, projection ALL. Used to
list a user's clubhouse activity across DReps.

---

## audit_log

Immutable event log. TTL'd to keep cost bounded.

| Field | Type | Role |
|-------|------|------|
| `pk` | S | PK — `entityType#entityId` (e.g. `governance#abc#0`) |
| `sk` | S | Sort key — `timestamp#eventType` |
| `actor` | S | Who triggered |
| `details` | M | Event-specific payload |
| `ttl` | N | Epoch seconds — DynamoDB auto-deletes |

No GSIs — queries are always partition-scoped (one entity at a time).

---

## auth_nonces

Single-use nonces with TTL. Stores three kinds:

| Field | Type | Role |
|-------|------|------|
| `nonce` | S | PK — 32-byte hex random |
| `kind` | S | `'challenge' \| 'mutation' \| 'circuit'` |
| `walletAddress` | S | Whose nonce this is (or `'_system'` for circuit) |
| `expiresAt` | N | Epoch seconds — DynamoDB TTL |
| `message` | S | (challenge only) the message the wallet must sign |
| `openedAt` | S | (circuit only) ISO-8601 when circuit was tripped |

TTL on `expiresAt` (epoch seconds, NOT ISO-8601 — important).

The `_circuit:blockfrost` row uses this same table as a convenient TTL
mechanism — see `lib/circuitBreaker.ts` for the rationale.

---

## Schema versioning history

Both syncs use an `enrichmentVersion` integer on each row. Bumping the
constant in code forces every row to re-enrich on the next cycle, even if
the data fields look identical. See full inline history in
`backend/src/sync/governance-intake.ts:66-156` and
`backend/src/sync/drep-directory.ts:96-108`.

### governance_actions — `ENRICHMENT_VERSION`

| Bump | What changed |
|------|--------------|
| 1 -> 2 | Hot path no longer re-runs the mapper against the listing stub (which was clobbering correct enrichment with empty values). |
| 2 -> 3 | Cold path now stores `votes` (DRep / SPO / CC tally). Hot path also refreshes votes — they mutate as voting progresses. |
| 3 -> 4 | `title` no longer synthesized from on-chain summary; reflects ONLY CIP-108 anchor title (or undefined). Frontend uses `summary` as subtitle. |
| 4 -> 5 | Proposal-pillar fallback for actions without a usable on-chain anchor body. New fields: `proposalPillarUrl`, `proposalPillarId`, `metadataSource`. |
| 5 -> 6 | Phase A — Koios `/proposal_list` is the primary metadata source. One bulk call replaces 4 Blockfrost calls per action. |
| 6 -> 7 | `votes` shape adds per-role `notVoted` and `totalActive` slices computed from active-voter lookups. Each slice carries `count` + `power`. |
| 7 -> 8 | CIP-1694 ratification math correction: auto-abstain stake EXCLUDED from `totalActive` (the ratification denominator). New informational field `totalRegistered` includes auto-abstain. Auto-no-confidence direction-flips on NoConfidence actions. |
| 8 -> 9 | `votingRoles` (CIP-1694 applicability map per action type) stamped on every action. DRep `abstain.power` no longer includes auto-abstain stake. |
| 9 -> 10 | `treasuryWithdrawalLovelace` persisted on TreasuryWithdrawals. Surfaced for `/governance/stats`. |
| 10 -> 11 | Phase B — per-proposal vote tallies now come from Koios `/vote_list`. ~99% Blockfrost call reduction on the vote-tally path. |

Current: **v11**.

### drep_directory — `ENRICHMENT_VERSION`

| Bump | What changed |
|------|--------------|
| 1 | Initial CIP-119 directory rows. |
| 1 -> 2 | Adds `lastVotedAt` / `voteCount` + `lastVotedPartition` / `lastVotedSort` GSI keys. Sync now includes inactive DReps. |
| 2 -> 3 | Sync includes retired DReps with `isRetired=true`, `votingPower="0"`, historical metadata preserved. Also forces re-sync after the `vote_list` pagination fix. |

Current: **v3**.

---

## Item size considerations

DynamoDB hard cap: **400 KB per item**.

CIP-108 anchor bodies (`abstract`, `motivation`, `rationale`) can be very
large — some Treasury Withdrawals proposals ship `rationale` fields well
over 100 KB. The sync truncates each body field at **60 KB** before write
to leave headroom for the rest of the row (votes object alone can be a
few KB; references list can grow).

Frontend renders the truncated text and links to the canonical anchor URL
for the full content. The Markdown component (`Markdown.tsx`) safely
renders untrusted HTML via Rehype Sanitize.

If a future schema change pushes total item size past ~300 KB, options:
1. Move large bodies to S3 (item stores only the URL).
2. Split into PK + multiple SKs (`actionId / 'BODY'`, `actionId / 'VOTES'`).
3. Compress with brotli before write.

Today's items are well under 100 KB. No immediate concern.
