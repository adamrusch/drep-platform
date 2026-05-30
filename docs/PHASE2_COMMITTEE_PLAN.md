# Phase 2 — DRep Committee Voting + `test.drep.tools`

**Status:** DECISIONS SETTLED · ready to build · 2026-05-30
**Grounded in:** the live codebase (Phase 1 deployed). Citations are `file:line`.
**Process:** deep code read → adversarial Oracle review → decisions resolved with Adam. This revision reflects all final decisions.

---

## 0. Settled rules

**Voting**
- Two-level: any committee member opens **one** proposal per `(committee, governance action)` proposing the DRep position **Yes | No | Abstain**. Members then cast **Agree | Disagree | Abstain**.
- Pass = **configurable supermajority**: lead sets a % applied to the **non-abstaining pool** (`active = agree + disagree`). Default **67%**, never below simple majority.
- **Quorum = ≥3 active (non-abstaining) voters.** **Abstain shrinks the pool** (easier passage).
- **Every cast requires a fresh CIP-30 signature**, recorded (with the signature) in the audit log. Members may re-vote until close.
- **No auto-close.** Any member may close while passing + quorum met. **No "doomed" math (Decision D2=A):** proposer or lead may close-as-failed or withdraw by judgment at any time. Epoch deadline hard-finalizes.

**Rationale (D4)** — lead picks one mode per committee:
1. **Lead authors** it.
2. **Lead assigns** it to one named member.
3. **Collaborative** — co-written, equally editable by all members, under a **pessimistic edit lock**: a member "opens" it → everyone else is blocked → lock releases on **Save**, on **20 min inactivity**, or if they **leave the window** (unsaved progress is discarded; only explicit Save commits).

**On-chain submission (D1, D3, D5)** — built for real end-to-end:
- Assemble the CIP-1694 vote tx, pin the CIP-100/108 rationale JSON to IPFS, embed the anchor (URI + hash) in vote metadata, lead's wallet signs.
- **Broadcast is gated to `stage === 'prod'` at the infra level.** On test, everything assembles and validates, then stops with *"Ready — this vote must be submitted from production."*
- Submitting **without** a rationale is **not** hard-blocked: **warn, allow override.**
- Stage is baked into every committee signed message so a test signature can't verify on prod.

**Anti-Sybil / integrity**
- **One committee per wallet — total** (lead *or* member). Enforced atomically.
- **Safety mode:** if **>5 committees are created in any trailing 12 h**, the platform **latches into safety mode for 72 h** (or until an Admin clears it), during which any wallet whose **first auth was < 7 days ago** cannot create a committee. "First access" = first successful wallet auth (`users.createdAt`).
- **Platform admin** = new first-class `platform_admin` role (see §8 bootstrap).

**Environment** — `test.drep.tools`, **mainnet**, separate data/secrets, promoted to prod through an approval gate.

---

## 1. What already exists (build on, don't rebuild)

| Asset | Status | File |
|---|---|---|
| `drep_committees` (`members[]`, `leadWallet`, `onChainMetadata`) | live | `infra/lib/database-stack.ts:50-74` |
| Roles `lead_drep`, `committee_member`, `trusted_delegator` | live | `backend/src/lib/types.ts:8-13` |
| Committee-**scoped** role check `requireOwnerOrCommitteeLead` | live (P0-4 fix) | `middleware/role-guard.ts:154-180` |
| `governance_actions` (`actionId=txHash#certIndex`, `epochDeadline`) | live | `types.ts:706-765` |
| `audit_log` writer | live | `lib/audit.ts:170-187` |
| CIP-30 mutation re-sign pipeline | live | `lib/auth.ts:229-404, 566-603` |
| `/committee`, `/rationales` routes | `<ComingSoon>` | `frontend/src/App.tsx:247-265` |

**House style to follow:** one table per domain (PK = natural id, small SK alphabet); mutation handlers do `extractAuthContext` → parse → **nonce + CIP-30 verify** → role check → `transactWrite`/`putItemIfAbsent` → `writeAuditEvent` → typed `_response`; FE = lazy route + `<RoleGuard>` + TanStack Query hook + `useMutationSign()`; CDK keys off a single `stage` context value.

---

## 2. Data model

**New table `committee_votes`** — one partition per `(committee, action)`:
```
PK: voteScope = `${drepId}#${actionId}`
SK:  'PROPOSAL'            — single proposal (putItemIfAbsent → 409 = "one at a time"); snapshots thresholdPct+quorum at open
     'CAST#<wallet>'       — latest cast per voter (overwrite on re-vote; carries the CIP-30 signature)
     'RATIONALE#DRAFT'     — working draft (CIP-100/108 fields)
     'RATIONALE#LOCK'      — collaborative edit lock {editorWallet, acquiredAt, lastHeartbeat, expiresAt}
     'RATIONALE#FINAL'     — locked rationale + canonical anchor hash + IPFS URI
     'SUBMISSION'          — on-chain receipt {txHash, broadcastStage, submittedBy}
     'COSIGN#<wallet>'     — reserved for future multisig (additive, non-breaking)
```
Sparse GSI `open-epochDeadline-index` (PK `statusPartition='OPEN'`, SK `epochDeadline`) drives the open-proposals view + deadline sweep.

**New SK on `drep_committees`:** `'VOTING_CONFIG'` → `{ thresholdPct (≥ simple-majority, ≤100, default 67), rationaleMode: 'lead'|'assigned'|'collaborative', assignedEditor?, history[] }`.

**New table `committee_membership`** — enforces *one committee per wallet, total*:
```
PK: walletAddress → { drepId, role: 'lead'|'member', joinedAt }
```
Written via `putItemIfAbsent(walletAddress)` inside the same `transactWrite` as committee-register / add-member, so uniqueness is atomic (lead's own wallet gets a row too). Deleted on remove. Also gives O(1) "is this wallet on a committee?".

**`users` table:** add `platform_admin` to the role set; `createdAt` already serves as first-auth timestamp.

**New table `platform_state`** (singleton-ish): `safetyMode { active, triggeredAt, expiresAt (=+72h), clearedBy }`. Trailing-12h committee-creation count comes from the existing `drep_committees` `SK-createdAt-index` (range query), no new counter needed.

**Per-DRep IPFS key (D5):** stored **encrypted in Secrets Manager** at `drep-platform/{stage}/drep-ipfs/{drepId}` (opt-in; lead can also enter ad-hoc). Pinning happens server-side so the backend canonicalizes the JSON and computes the anchor hash over the exact bytes it pins.

---

## 3. The vote resolver (pure, tested first)

`backend/src/lib/committeeVoteResolver.ts` — no I/O, exhaustively tested before infra.
```
activePool     = agree + disagree                 // abstain excluded → shrinks pool
quorumMet      = activePool >= quorum (3)
isPassing      = quorumMet AND agree*100 >= activePool*thresholdPct   // integer math
canCloseAsPass = isPassing                         // any member may close
// D2=A: no isDoomed. close-as-failed / withdraw is role-gated (proposer or lead), allowed anytime.
```
Pass-math provably never drops below simple majority at ≥51%. Test matrix: 3/0/0@67 pass; 2/1/0@67 fail; 2/1/0@51 pass; 5/2/3@67 pass (abstain shrinks 7→71%); 3/3/0@51 fail; unanimous@100; below-quorum no-decision; threshold `50` rejected at handler schema.

---

## 4. Backend handlers (`handlers/committee/` + `handlers/admin/`)

| Method | Route | Authn | Purpose |
|---|---|---|---|
| GET | `/committee/{drepId}/votes[/{actionId}]` | public | List / detail (proposal + casts + live tally + draft) |
| POST | `/committee/{drepId}/votes` | member · re-sign | Open proposal (409 if exists; reject if action already past epoch or committee < quorum members) |
| POST | `.../{actionId}/cast` | member · re-sign | Cast/change/abstain (overwrite, `changeCount++`) |
| POST | `.../{actionId}/close` | member · re-sign | Close-as-pass (resolver-guarded) |
| POST | `.../{actionId}/fail` | proposer/lead · re-sign | Close-as-failed (terminal) |
| DELETE | `.../{actionId}` | proposer/lead · re-sign | Withdraw (allows re-propose) |
| PUT | `/committee/{drepId}/voting-config` | lead · re-sign | Set thresholdPct + rationaleMode (warns if open proposals) |
| POST | `.../rationale/lock` · `/heartbeat` · `/release` | member (collab mode) | Pessimistic edit lock (20-min expiry) |
| GET/PUT | `.../rationale` | per mode (lead / assigned / any member w/ lock) | Read / edit draft |
| POST | `.../rationale/finalize` | lead/proposer · re-sign | Lock → FINAL + canonical hash |
| POST | `.../submit` | lead · re-sign | Assemble + pin IPFS + sign; **broadcast only if `stage===prod`**, else "ready, submit in prod"; warn+override if no rationale |
| POST/DELETE | `/committee/{drepId}/members[/{wallet}]` | lead · re-sign | Add/remove (membership-uniqueness enforced) |
| POST | `/committee` (register) | wallet · re-sign | Create committee — **dedup fixed**, one-per-wallet, **safety-mode gate** |
| POST/DELETE | `/admin/roles/{wallet}` | platform_admin | Grant/revoke `platform_admin` |
| POST | `/admin/safety-mode/clear` | platform_admin | Clear latched safety mode early |

Committee-scoped checks read `committee.leadWallet`/`members[]` (never trust JWT roles for scoped power). Close/fail/withdraw/sweep use conditional update on `status='open'` (first writer wins). Every mutation writes a dotted audit event (`committee.*`, `admin.*`) — committee votes persist the signature in audit metadata (low volume, high value). Hourly **epoch/GA-status sweep** finalizes past-deadline or chain-expired proposals.

---

## 5. Frontend

- Replace both `<ComingSoon>` placeholders. New pages: `CommitteeLanding`, `CommitteeVoteList`, **`CommitteeVoteRoom`** (proposal + tally donut + cast panel + close/fail/withdraw + rationale pane), `RationalesPage`, `AdminPanel` (platform_admin only: clear safety mode, grant roles).
- Components (`components/committee/`): `CastVotePanel` (re-sign per click), `VoteTallyDonut` (reuses `<SentimentBlock>`), `RationaleEditor` (mode-aware; collaborative shows lock state + "X is editing"; heartbeat while focused; warns on unsaved-leave), `ClosePromptDialog`, `CommitteeMemberList`, `SubmitVotePanel` (IPFS-key prompt or stored, warn-on-no-rationale override, prod-only broadcast).
- Hooks mirror `useClubhouse.ts`. No new store. **Test-stage banner:** "TEST — mainnet read-only; on-chain submission disabled."

---

## 6. `test.drep.tools` environment

- **Manual once:** ACM cert for `test.drep.tools` + `api.test.drep.tools` (DNS-validate in existing zone); secrets `drep-platform/test/{jwt-secret,blockfrost-api-key}` with a **separate** Blockfrost project.
- **Code:** `customDomain` becomes a function of stage; centralize `isPersistent`/`isProd` + a stage allowlist that throws on typos; **`cookieDomain` is explicit per stage** (`.test.drep.tools`) so test cookies don't bleed to prod; deploy via `scripts/deploy.sh --stage test`; FE built with `VITE_API_BASE_URL=https://api.test.drep.tools` (rebuilt per stage — FE artifact is *not* byte-identical across stages, backend Lambda zips are).
- **Broadcast guardrail:** the submit handler's broadcast branch is compiled behind `stage==='prod'`; a cold-start CloudWatch alarm fires on "mainnet on non-prod stage."

## 7. Promotion: test → prod

`main` (CI green) → auto-deploy **test** → mainnet QA → tag release → **prod deploy gated by a GitHub Environment required-reviewer (Adam)** → mandatory drift check. DB stack deploys before API stack for new tables/GSIs; secrets stay per-stage (never promoted); no DDB data copied.

---

## 8. Platform-admin bootstrap (falls out of "new role")

Chicken-and-egg: a runtime-assignable role needs a first holder. Plan:
- A one-time **seed list** of bootstrap admin wallet(s) in `drep-platform/{stage}/admin-bootstrap` (Secrets Manager). On auth, a seeded wallet is granted `platform_admin` automatically.
- Thereafter, existing `platform_admin`s grant/revoke the role to others via `/admin/roles/{wallet}` (every grant/revoke audited). Bootstrap list is the break-glass recovery path.
- **Open default I'm assuming:** the initial seed = your wallet (`adamrusch`/lead). Tell me the exact address(es) when convenient — not blocking the early steps.

---

## 9. Pre-Phase-2 cleanups (small, first)

1. **Fix the committee dedup no-op** (`drep/register.ts:40-48` checks `PK=walletAddress` but writes `drepId=ulid()`), replaced by the atomic `committee_membership` uniqueness. (~1h)
2. **Centralize stage predicates** (`isPersistent`/`isProd` + allowlist). (~1h)

---

## 10. Build sequence (each = one reviewable PR; lands on test, then promotes)

0. Pre-cleanups (§9) + `test` stage infra (§6) + broadcast guardrail + `platform_admin` role/bootstrap + safety-mode state
1. `committee_votes` + `committee_membership` + `VOTING_CONFIG` SK + GSIs
2. Pure resolver + tests
3. Shared versioned signed-message module (FE+BE) + audit eventTypes
4. Register (dedup fix + one-per-wallet + safety-mode gate) + member + voting-config handlers
5. openProposal + castVote + listVotes + getVote
6. closeVote + fail + withdraw
7. Epoch/GA-status sweep Lambda + alarms
8. Rationale: modes + collaborative lock (acquire/heartbeat/release) + draft CRUD + finalize (canonical hash)
9. IPFS pinning + per-DRep key (encrypted, opt-in) + admin handlers (clear safety mode, grant roles)
10. FE hooks + types
11. CommitteeVoteRoom + CastVotePanel + tally
12. CommitteeLanding + VoteList + dashboard panels + AdminPanel
13. RationaleEditor (mode-aware + lock UI) + finalize + RationalesPage
14. Real on-chain submission (assemble + sign + anchor) with prod-only broadcast + warn/override
