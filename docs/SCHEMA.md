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
- [governance_votes](#governance_votes)
- [comments](#comments)
- [clubhouse_posts](#clubhouse_posts)
- [audit_log](#audit_log)
- [auth_nonces](#auth_nonces)
- [identity_sessions](#identity_sessions)
- [onchain_users](#onchain_users)
- [identity_links](#identity_links)
- [comment_flags](#comment_flags)
- [clubhouse_post_flags](#clubhouse_post_flags)
- [clubhouse_comment_flags](#clubhouse_comment_flags)
- [platform_state (DREP_DVT_THRESHOLDS row)](#platform_state-drep_dvt_thresholds-row)
- [JWT claims (token, not table)](#jwt-claims-token-not-table)
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
| `image` | S | Avatar URL (CIP-119 upstream — may be remote) |
| `imageContentHash` | S | Sprint 5 — SHA-256 hex of the avatar bytes self-hosted under that hash key in S3. Set together with `imageStoredUrl` when the avatar-store sync successfully fetched + uploaded the upstream image. Cleared when the upstream `image` changes. |
| `imageStoredUrl` | S | Sprint 5 — the URL the platform serves (the content-addressed S3-backed `/dreps/avatar/...` redirect). What the frontend prefers over `image` when present, so the wallet pill / directory tile renders from the local cache, not the remote source. |
| `imageFetchFailedAt` | N | Sprint 5 — Unix seconds of the most recent failed avatar fetch. Used by the avatar sync's rotation order (failed rows fall to the back of the next pass) so a broken upstream doesn't starve healthy DReps. Cleared on next success. |
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

### `POWER#` sub-rows (Phase C, added 2026-05-17)

The directory table now hosts a second SK shape: `POWER#${zero-padded epoch_no}`.
One row per (drepId, epoch) snapshot of voting power, populated daily by
the new `drep-voting-power-history` sync from Koios
`/drep_voting_power_history`. Surfaced by `directory/get.ts` as
`votingPowerHistory[]` on the response, which the frontend Sparkline reads.

| Field         | Type | Role                                                                  |
|---------------|------|-----------------------------------------------------------------------|
| `drepId`      | S    | PK — same as the PROFILE row                                          |
| `SK`          | S    | `POWER#${epoch_no zero-padded to 6 digits}` (e.g. `POWER#000515`)     |
| `epochNo`     | N    | Epoch this snapshot represents                                        |
| `amount`      | S    | Voting power in lovelace, stringified BigInt                          |
| `capturedAt`  | S    | ISO-8601 of the sync run that wrote this row                          |

Access pattern: `Query(drepId)` with `begins_with(SK, "POWER#")` returns
the full history for one DRep in chronological order (lexical = numeric
order on the zero-padded epoch). The detail handler does this on every
cold-cache miss; results are folded into the 5-min handler cache.

Idempotency: conditional Put on `attribute_not_exists(SK)`. Historical
snapshots are immutable, so re-attempted writes silently skip.

Cost: ~1500 active DReps × ~73 rows/year = ~110k items/year. Each row
~200B → ~22MB/year of storage. Daily sync issues ~1500 Koios calls and
~110k conditional Puts (mostly skips); steady-state WCU ~$0.14/day.

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

Sample `POWER#` sub-row:

```json
{
  "drepId": "drep1...",
  "SK": "POWER#000515",
  "epochNo": 515,
  "amount": "1234567890123",
  "capturedAt": "2026-05-17T02:00:00Z"
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

## governance_votes

Per-vote event log — one row per individual on-chain governance vote
across DReps, SPOs, and the Constitutional Committee. Phase C addition
(2026-05-17). Populated by `sync/governance-intake.ts` from Koios
`/vote_list` (the same call already used for per-proposal tallies and
DRep last-voted timestamps; we just persist the rows now). Append-only.

Use cases:
- Vote-timeline rendering on the governance-action detail page
  (`Query(actionId)`).
- "DRep voting history" UX powered by the `voter-blockTime-index` GSI
  (`Query(voterId)` with `ScanIndexForward: false`).
- Independent audit / data-export — exporting the table is a complete
  snapshot of mainnet governance voting since Phase C deploy.

| Field          | Type | Role                                                                                |
|----------------|------|-------------------------------------------------------------------------------------|
| `actionId`     | S    | PK — `tx_hash#cert_index` matching `governance_actions.actionId`                    |
| `voteKey`      | S    | SK — `${voterRole}#${voterId}#${voteTxHash}`, unique per vote certificate           |
| `voterRole`    | S    | `'DRep' \| 'SPO' \| 'ConstitutionalCommittee'`                                      |
| `voterId`      | S    | Bech32 DRep ID, pool ID, or CC hot ID                                               |
| `vote`         | S    | `'Yes' \| 'No' \| 'Abstain'`                                                        |
| `votedAt`      | S    | ISO-8601 timestamp of the `block_time`                                              |
| `blockTime`    | N    | Unix seconds — used as the GSI sort key                                             |
| `epochNo`      | N    | Epoch in which the vote was cast                                                    |
| `voteTxHash`   | S    | Tx hash of the vote certificate (part of `voteKey` so vote-changes coexist as rows) |
| `metaUrl`      | S    | Off-chain rationale anchor URL (optional)                                           |
| `metaHash`     | S    | Off-chain anchor hash (optional)                                                    |
| `ingestedAt`   | S    | ISO-8601 when this row was first written                                            |

GSI: `voter-blockTime-index`
- PK: `voterId`
- SK: `blockTime` (NUMBER)
- Projection: ALL
- Access pattern: per-voter timeline, newest-first via `ScanIndexForward: false`

Write semantics: conditional Put with
`attribute_not_exists(actionId) AND attribute_not_exists(voteKey)`. A
high-water-mark stored in `auth_nonces` (`nonce='_watermark:governance_votes_block_time'`)
bounds how far back each cycle walks, capping per-cycle DynamoDB cost at
~50 WCU steady-state instead of ~24k WCU. See `persistVoteEvents` in
`backend/src/sync/governance-intake.ts` for the watermark contract.

Expected size: 24k rows × ~250B = ~6MB today. Growth: ~50/day.

Sample item:

```json
{
  "actionId": "abc123...#0",
  "voteKey": "DRep#drep1xyz...#fff...",
  "voterRole": "DRep",
  "voterId": "drep1xyz...",
  "vote": "Yes",
  "votedAt": "2026-05-15T08:32:15Z",
  "blockTime": 1747212735,
  "epochNo": 515,
  "voteTxHash": "fff...",
  "ingestedAt": "2026-05-17T00:00:00Z"
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
| `flagCount` | N | Sprint 4 — community-flagging counter. Atomically `ADD`ed when a fresh per-flagger row is inserted in `comment_flags`. Optional for backwards compat — absence = 0. |
| `hidden` | BOOL | Sprint 4 — true when `flagCount` reached the hide threshold (set via a conditional `SET hidden = :true` in the same atomic update that bumps the counter). Hidden rows are excluded from normal-user list responses; `platform_admin`s still see them with the marker so they can moderate. |

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
| `flagCount` | N | Sprint 4 — community-flagging counter. Atomically `ADD`ed when a fresh per-flagger row is inserted in `clubhouse_post_flags`. Optional — absence = 0. |
| `hidden` | BOOL | Sprint 4 — true when `flagCount` reached the hide threshold. Hidden posts are excluded from normal-user list responses; `platform_admin`s see them with the marker for moderation. |

GSI: `authorWallet-index` — PK `authorWallet`, projection ALL. Used to
list a user's clubhouse activity across DReps.

The threaded comments under each post live in a sibling
`clubhouse_comments` table (PK=`postKey`=`${drepId}#${postId}`,
SK=`commentId`) — not documented as its own section here yet. Sprint 4
adds two flag-related attributes on every comment row in that table:
`flagCount` (atomic `ADD` from `clubhouse_comment_flags` inserts) and
`hidden` (same threshold semantics as the post-level flagging above).

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

## identity_sessions

Per-session revocation store for the four-role on-chain login JWTs
(DRep / SPO / CC / Proposer). One row per active session — flipped to
`revoked: true` on logout / "log out everywhere" / the daily role-
revalidation cron, and consulted by the JWT authorizer on every
authenticated request. Distinct from the legacy `users.tokenVersion`
revocation (which is a single counter per wallet, bulk-only); this
table makes per-session granular revoke a first-class operation.
Introduced 2026-06-10 (Decision #1).

| Field | Type | Role |
|-------|------|------|
| `sessionKey` | S | PK — SHA-256(jti) in hex (64 chars). Opaque, deterministic from the JWT. |
| `identityId` | S | The JWT subject — the on-chain credential the session was issued under (`drep1...` / `pool1...` / `cc_cold1...` / `stake1...`). GSI partition key. |
| `onChainRoles` | L | The on-chain role(s) this session was granted under. Always an array (forward-compatible with future multi-role sessions); today exactly one of `'drep' | 'spo' | 'cc' | 'proposer'`. |
| `issuedAt` | N | Epoch seconds the session was minted. GSI sort key. |
| `expiresAt` | N | Epoch seconds — DynamoDB TTL attribute. Matches the underlying JWT's `exp`. |
| `revoked` | BOOL | Missing / `false` = active. `true` after a revoke. |
| `spoCalidusPubKeyHex` | S | M5 (2026-06-10) — the Ed25519 Calidus pubkey (hex, lowercase) the SPO presented at login. SPARSE: only set on `onChainRole === 'spo'` rows. The daily revalidation cron reads it to detect Calidus-key rotation; pre-M5 SPO rows lack the field and fall through to still-valid until TTL. |

GSI: `identityId-issuedAt-index`
- PK: `identityId`
- SK: `issuedAt` (NUMBER)
- Projection: ALL
- Access pattern: enumerate every active session for one identity in
  a single-partition Query — used by `revokeAllSessionsForUser`
  (logout `{"all":true}`) and the daily role-revalidation cron's
  identity enumeration. Sortable by `issuedAt` so a future "your
  recent sessions" surface gets it for free without a second GSI.

Write semantics: `recordSessionForUser` writes the row at login (best-
effort — never blocks login on a write blip). Revoke flips `revoked`
via `updateItem`; the granular read uses `ConsistentRead: true` so a
just-landed revoke is visible on the next request (M3 fix). The
authorizer's `isSessionRevoked` fails OPEN on a store-read error — see
ADR-013 and `docs/SECURITY_REVIEW_IDENTITY.md` for the rationale.

Sample item:

```json
{
  "sessionKey": "a3b9...64chars",
  "identityId": "drep1xyz...",
  "onChainRoles": ["drep"],
  "issuedAt": 1749600000,
  "expiresAt": 1752192000,
  "revoked": false
}
```

Sample SPO item (with M5 Calidus pubkey):

```json
{
  "sessionKey": "...",
  "identityId": "pool1...",
  "onChainRoles": ["spo"],
  "issuedAt": 1749600000,
  "expiresAt": 1752192000,
  "revoked": false,
  "spoCalidusPubKeyHex": "abcd1234...hex"
}
```

---

## onchain_users

The canonical "person" table for the on-chain identity subsystem
(Decision #3, 2026-06-10). One row per recognised individual, keyed by
an opaque `personId` ULID. Holds the editable profile + bookkeeping.
The credentials that map to this person live in the sibling
`identity_links` table — read the two together via the
`personId-verifiedAt-index` GSI to enumerate every credential one
person controls.

Distinct from the legacy `users` table: `users` is keyed by stake
address (bech32) and bound to the CIP-30 wallet session. An SPO that
signs with a raw Calidus key and has never connected a CIP-30 wallet
has NO row in `users` but does have one here. ADR-014 + ADR-016
reconcile a wallet login + the same human's on-chain logins to one
`personId`.

| Field | Type | Role |
|-------|------|------|
| `personId` | S | PK — ULID. Opaque; never reused. |
| `displayName` | S | optional |
| `bio` | S | optional |
| `socialLinks` | M | optional — `{twitter?, github?, website?, discord?}` (S4d hardening: shape-validated on the update handler). |
| `createdAt` | S | ISO-8601 |
| `updatedAt` | S | ISO-8601 |

No SK; no GSIs. Every access pattern is `GetItem(personId)` or
`PutItem(personId)`. Profile reads/writes go through
`GET /auth/onchain/profile` / `PUT /auth/onchain/profile`.

Sample item:

```json
{
  "personId": "01HV...",
  "displayName": "alice",
  "bio": "longer bio text",
  "socialLinks": {
    "twitter": "alice_x",
    "github": "alice_g"
  },
  "createdAt": "2026-06-10T12:00:00Z",
  "updatedAt": "2026-06-10T12:00:00Z"
}
```

---

## identity_links

Maps each on-chain credential to a canonical `personId` in
`onchain_users` (Decision #3, 2026-06-10). The "one person, many
credentials" join: a single human can reach one `personId` from a
wallet stake credential AND a DRep id AND a pool's Calidus key AND a
CC hot key, with separate cryptographic proof of control on each.

The link/verify flow does **NOT** silently merge two persons. If a
credential is presented for linking but is already mapped to a
different personId than the caller's session person, the link is
rejected with a 409 — never silently re-pointed. See ADR-014 for the
safety contract and the M1 fix (the signed payload binds the caller's
personId into the bytes the wallet signs).

| Field | Type | Role |
|-------|------|------|
| `identityKey` | S | PK — namespaced credential string: `drep:<drepId>` \| `pool:<poolId>` \| `cc:<ccCred>` \| `stake:<stakeAddr>`. The namespace prefix is load-bearing: makes the credential type self-describing on read and prevents cross-type collisions. |
| `personId` | S | FK into `onchain_users.personId`. |
| `credentialType` | S | `'drep' \| 'pool' \| 'cc' \| 'stake'`. Denormalised from the PK prefix. |
| `verifiedAt` | S | ISO-8601 — when the link was minted. GSI sort key. |
| `verifiedVia` | S | `'login'` (auto-provisioned on first on-chain login for an unmapped credential) \| `'link'` (explicit `/auth/onchain/link/verify`). |
| `linkedFromRole` | S | optional — for `'link'` rows, the on-chain role the caller's CURRENT session was authenticated under at the time the link was created. Informational; the load-bearing security check is the signature on the link/verify call. |

GSI: `personId-verifiedAt-index`
- PK: `personId`
- SK: `verifiedAt` (STRING — ISO-8601 sorts lexicographically as
  chronological)
- Projection: ALL
- Access pattern: enumerate every credential a person controls in a
  single-partition Query — used by `GET /auth/onchain/me` for the
  aggregated response.

Auto-provisioning order (S3 fix, 2026-06-10): the `identity_links`
conditional Put runs FIRST (`attribute_not_exists(identityKey)`), and
the `onchain_users` row is written ONLY on successful claim. A losing
racer re-reads the winning link and returns its personId, so no orphan
person row is left behind.

Sample item:

```json
{
  "identityKey": "drep:drep1xyz...",
  "personId": "01HV...",
  "credentialType": "drep",
  "verifiedAt": "2026-06-10T12:00:00Z",
  "verifiedVia": "login"
}
```

---

## comment_flags

Community-flagging primitive for governance-action comments
(Sprint 4). One row per (comment, flagger) — the flag handler uses
`putItemIfAbsent` so duplicate-flag attempts from the same wallet are
idempotent at the schema layer. Three distinct flags hide the comment
from normal users (`HIDE_THRESHOLD` in
`backend/src/handlers/comments/flag.ts`); `platform_admin`s still see
the row with a `hidden: true` marker for moderation.

| Field | Type | Role |
|-------|------|------|
| `commentId` | S | PK — the ULID of the comment being flagged (same value used as the SK on the `comments` table). |
| `flaggerId` | S | SK — the flagger's bech32 stake address. Combined with `commentId` this is the per-(comment, flagger) uniqueness key. |
| `role` | S | The on-chain role the flagger had proved at the time of the flag (`'drep' \| 'spo' \| 'cc' \| 'proposer'`). Stored for the audit trail; NOT consumed by the count math — any one of the four roles counts equally toward the hide threshold. |
| `createdAt` | S | ISO-8601 — when the flag was raised. |

No GSIs. Every access pattern is `GetItem(commentId, flaggerId)`
(idempotent insert) or `Query(commentId)` (audit / moderation
enumeration).

Counter integrity: the matching `flagCount` counter on the parent
`comments` row is atomically `ADD`-bumped only when the per-flagger
row is freshly inserted (`putItemIfAbsent` outcome `'written'`).
Duplicate flags (outcome `'skipped'`) leave the counter alone, so it
tracks distinct-flagger headcount even under retries.

Sample item:

```json
{
  "commentId": "01HV...",
  "flaggerId": "stake1u9...",
  "role": "drep",
  "createdAt": "2026-06-10T12:00:00Z"
}
```

---

## clubhouse_post_flags

Same primitive as `comment_flags`, scoped to clubhouse posts
(Sprint 4).

| Field | Type | Role |
|-------|------|------|
| `postKey` | S | PK — `${drepId}#${postId}`, composed via the shared `clubhouseCommentPostKey(drepId, postId)` helper. Intentionally MATCHES the partition-key format used by `clubhouse_comments`, so a future moderation surface can correlate flags on a post with flags on its threaded comments without learning a second key shape. |
| `flaggerId` | S | SK — the flagger's bech32 stake address. |
| `role` | S | The on-chain role the flagger had proved at the time of the flag. |
| `createdAt` | S | ISO-8601. |

No GSIs. `clubhouse_posts.flagCount` is atomic-`ADD`-ed only on a
fresh insert; the conditional `SET hidden = :true` rides the same
atomic update once the threshold is crossed.

---

## clubhouse_comment_flags

Same primitive as `comment_flags` / `clubhouse_post_flags`, scoped to
clubhouse comments — closes the previously-missing leg of the
flagging trio (Sprint 4 follow-up).

| Field | Type | Role |
|-------|------|------|
| `postKey` | S | PK — `${drepId}#${postId}` (same shape as `clubhouse_comments` + `clubhouse_post_flags`). A single `Query(postKey)` therefore returns every flag for every comment under one post — useful for a future moderation surface. |
| `commentFlagKey` | S | SK — `${commentId}#${flaggerId}`, composed via `clubhouseCommentFlagKey(commentId, flaggerId)`. Keeps the (comment, flagger) tuple unique within the partition. |
| `commentId` | S | Denormalised — the comment id this flag targets (also embedded in `commentFlagKey` for trivial server-side filtering after a partition Query). |
| `drepId` | S | Denormalised — the post's owning clubhouse. |
| `postId` | S | Denormalised — the post the flagged comment belongs to. |
| `flaggerId` | S | The flagger's bech32 stake address. |
| `role` | S | The on-chain role the flagger had proved at the time of the flag. |
| `createdAt` | S | ISO-8601. |

No GSIs. The matching `flagCount` counter on the parent comment row
in the `clubhouse_comments` table is atomic-`ADD`-ed only on a fresh
insert; same threshold + `hidden` semantics as the two sibling flag
tables.

---

## platform_state (DREP_DVT_THRESHOLDS row)

Sprint 5 — the `platform_state` table previously held only the
Sybil safety-mode latch (`stateKey='SAFETY_MODE'`). It now also holds
a singleton snapshot of the live DRep voting thresholds from Koios's
`/epoch_params` under `stateKey='DREP_DVT_THRESHOLDS'`. The directory
sync writes the row best-effort each cycle; the concentration
handler reads it to render the donut's threshold markers
(60/67/75 etc.) without doing a per-request Koios round-trip.

| Field | Type | Role |
|-------|------|------|
| `stateKey` | S | PK — `'DREP_DVT_THRESHOLDS'` (string literal). |
| `epochNo` | N | The Koios epoch the snapshot was taken from. |
| `capturedAt` | S | ISO-8601 of the sync cycle that wrote this row. |
| `dvt_motion_no_confidence` | N | Optional. Fractional double in [0, 1]; the concentration handler converts to an integer percent (0..100) for the donut. |
| `dvt_committee_normal` | N | Optional. |
| `dvt_committee_no_confidence` | N | Optional. |
| `dvt_update_to_constitution` | N | Optional. |
| `dvt_hard_fork_initiation` | N | Optional. |
| `dvt_p_p_network_group` | N | Optional. |
| `dvt_p_p_economic_group` | N | Optional. |
| `dvt_p_p_technical_group` | N | Optional. |
| `dvt_p_p_gov_group` | N | Optional. |
| `dvt_treasury_withdrawal` | N | Optional. |

All `dvt_*` fields are optional because not every Koios revision
exposes every threshold; absent fields are simply skipped on render.
The concentration handler coalesces duplicate-percent thresholds into
one marker that lists every gated action.

---

## JWT claims (token, not table)

Not a DynamoDB table — recorded here because the on-chain identity
subsystem introduces three new claims that downstream tables and
handlers depend on. The legacy CIP-30 verifier (and the post-ADR-016
cutover path) also reads these defensively so pre-Sprint-1 tokens
keep verifying with `onChainRoles: []`, no `jti`, no `personId`.

| Claim | Type | Role |
|-------|------|------|
| `onChainRoles` | string[] | One of `'drep' \| 'spo' \| 'cc' \| 'proposer'`. A parallel claim alongside the legacy `roles` array; NOT folded into the `UserRole` union (ADR-012). Resolved + cryptographically proved at `POST /auth/onchain/verify`. |
| `jti` | string | ULID, set on every on-chain login. Drives per-session revocation via the `identity_sessions` table (ADR-013). A pre-Sprint-1 token has no `jti` and the authorizer treats it as "not granularly revocable" (falls back to `tokenVersion`). |
| `personId` | string | ULID. The canonical-person id (ADR-014). Pre-Decision-3 tokens omit it; downstream handlers fall back to resolving via the on-chain credential (`identityKey` → `identity_links`). The post-ADR-016 legacy verifier also threads `personId` through, so a wallet login and the same human's on-chain login resolve to one person. |

See `backend/src/lib/auth.ts` (`issueJWT` / `verifyJWT`) for the
shape and the defensive backward-compatibility reads.

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
| 11 -> 12 | Multi-gateway IPFS fallback for actions whose anchor exists on-chain but whose `meta_json` came back null from Koios. New fields: `metadataGateway`, `metadataRecoveredAt`. |
| 12 -> 13 | Two more anchor-recovery techniques: IPFS hash-mismatch surfacing (new `anchorHashMismatch` flag) and `raw.githubusercontent.com` historical-commit walk (new `anchorRecoveredFromCommit` / `anchorRecoveredFromCommitDate` fields). Phase C does NOT bump this further — the per-vote event log lives in a separate table (`governance_votes`). |

Current: **v13**.

### drep_directory — `ENRICHMENT_VERSION`

| Bump | What changed |
|------|--------------|
| 1 | Initial CIP-119 directory rows. |
| 1 -> 2 | Adds `lastVotedAt` / `voteCount` + `lastVotedPartition` / `lastVotedSort` GSI keys. Sync now includes inactive DReps. |
| 2 -> 3 | Sync includes retired DReps with `isRetired=true`, `votingPower="0"`, historical metadata preserved. Also forces re-sync after the `vote_list` pagination fix. |

Current: **v3**.

### Identity-subsystem tables — versioning

The four tables added in 2026-06-10 (`identity_sessions`,
`onchain_users`, `identity_links`) and the three flag tables added in
Sprint 4 (`comment_flags`, `clubhouse_post_flags`,
`clubhouse_comment_flags`) do NOT carry an `enrichmentVersion` —
they're not synced from chain state. Their schemas are stable; future
additive fields land as optional attributes (the M5 fix adding
`spoCalidusPubKeyHex` on `identity_sessions` is the pattern). The
`DREP_DVT_THRESHOLDS` row on `platform_state` is overwritten each
cycle by the directory sync — see ADR-013 / ADR-014 and the
`backend/src/lib/sessionRevocation.ts` / `backend/src/lib/
identityPerson.ts` headers for the cross-version compatibility
contracts (`onChainRoles` / `jti` / `personId` JWT claims all read
defensively for pre-Sprint-1 tokens).

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
