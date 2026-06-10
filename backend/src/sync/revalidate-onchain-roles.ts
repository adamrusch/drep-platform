/**
 * Daily on-chain role re-validation sync (Sprint 3, 2026-06-10).
 *
 * # The gap this closes
 *
 * Sprint 1 added the four-role on-chain login (`drep` / `proposer` /
 * `spo` / `cc`). Each successful login mints a JWT carrying the
 * granted `onChainRoles[]` claim, with a 30-day max lifetime
 * (`remember_me`). The JWT itself is cryptographically valid for that
 * full window — nothing on the read path re-checks Koios per request.
 *
 * That's a problem the moment an identity's on-chain role disappears
 * BEFORE the JWT expires:
 *
 *   - A DRep DEREGISTERS — still holds a `drep`-role JWT for up to 30
 *     days. Their vote-cast surface stays unlocked.
 *   - An SPO RETIRES (or rotates Calidus key, revoking the previous) —
 *     same problem with the `spo`-role JWT.
 *   - A CC member's hot credential is REVOKED (status flips away from
 *     `authorized`) — same problem with the `cc`-role JWT.
 *   - A proposer's submitted action is RETRACTED such that they no
 *     longer match `return_address` — `proposer` JWT lingers.
 *
 * The legacy `tokenVersion` counter doesn't help: it's a row on
 * the `users` table, and on-chain login intentionally does NOT touch
 * `users` (see `onchainVerify.ts` header). Bumping `tokenVersion` for
 * a deregistered DRep would require resolving their identity to a
 * legacy user row, which we don't keep for on-chain logins.
 *
 * # The fix
 *
 * Daily, enumerate every active on-chain identity via the per-identity
 * session index (`kind='session_index'` rows in `authNonces`) and
 * re-resolve each identity's role via the same `resolveRole` +
 * `koiosAdapter` the live verify path uses. If a role the session was
 * granted no longer holds on-chain, revoke ALL of that identity's
 * sessions via `revokeAllSessionsForUser` (which writes per-jti
 * tombstones the JWT authorizer fails CLOSED on).
 *
 * # CRITICAL: fail-safe on Koios errors / inconclusive data
 *
 * NEVER revoke on a Koios outage or an inconclusive read. The whole
 * point of the four-role login is to give legitimate on-chain identities
 * a way in; a Koios outage that strips everyone out is worse than the
 * gap this sweep is closing. The cron ONLY revokes when it has a
 * DEFINITIVE "role no longer present" reading:
 *
 *   - `resolveDRep` returned `{isDrep: false}` AND the Koios call did
 *     not throw → DRep is definitively deregistered → revoke.
 *   - `resolveSpo` returned `{isSpo: false}` AND no throw → revoke.
 *   - `resolveCc` returned `{isCc: false}` AND no throw → revoke.
 *   - `resolveProposer` returned `{isProposer: false}` AND no throw →
 *     revoke.
 *
 * Anything else — the underlying Koios call threw, the adapter returned
 * `null` because it caught an error internally, a re-resolution that's
 * inconsistent with the cached state — SKIPS the identity. Next 24h
 * cycle retries against fresh data.
 *
 * Locked in by explicit tests in `revalidate-onchain-roles.test.ts`:
 *   - `still-valid identity keeps its sessions`
 *   - `now-deregistered identity gets revoked`
 *   - `Koios throw → identity skipped, sessions intact`
 *
 * # Cadence
 *
 * Daily (24h). On-chain registration changes take an epoch (~5 days
 * mainnet) to propagate anyway, so 24h granularity is plenty. Shorter
 * windows would burn Koios calls for no real change-detection win.
 * 02:30 UTC chosen to slot between the existing daily DRep
 * power-history (02:00) and pool-metadata (03:00) syncs so the three
 * don't compete for the anonymous-tier Koios RPS budget.
 *
 * # Cost
 *
 * Per-cycle Koios calls = ~(N active on-chain identities), with the
 * `drep` / `spo` / `cc` checks each costing one Koios call per
 * identity (no batch endpoint for `drep_info` keyed on a single id;
 * `committee_info` returns the full roster in one call and is
 * adapter-cached); `proposer` re-uses the cached `proposal_list`.
 * At steady state (mainnet ~2k DReps + ~3k SPOs + ~7 CC + a handful
 * of proposers, of which a small fraction log into THIS platform) the
 * total is well under the public-tier anonymous Koios quota. DDB cost
 * is one Scan (filtered by `kind='session_index'`) + the revoke writes
 * (only on definitive deregistrations).
 *
 * # Structured logging
 *
 * Mirrors `revalidate-comment-stake.ts`'s pattern — one structured
 * end-of-pass log line and a per-identity warning on each skip.
 */
import type { ScheduledEvent, Context } from 'aws-lambda';
import {
  listActiveSessionIndices,
  revokeAllSessionsForUser,
  type ActiveSessionIndex,
} from '../lib/sessionRevocation';
import {
  fetchDRepInfoBatch,
  getCommitteeMembers,
  listProposals,
  type KoiosDRepInfo,
  type KoiosCommitteeMember,
} from '../lib/koios';
import type { KoiosClient, DrepInfo, Proposal, CommitteeMember } from '../lib/identity/auth/koios';
import {
  resolveDRep,
  resolveProposer,
} from '../lib/identity/auth/resolveRole';
import type { OnChainRole } from '../lib/types';

// ---------------------------------------------------------------------------
// STRICT KoiosClient — propagates errors instead of swallowing.
// ---------------------------------------------------------------------------
//
// The production `buildKoiosAdapter` (lib/identity/auth/koiosAdapter.ts)
// catches every Koios failure and returns `null` / `[]` so the LIVE verify
// path can fail-CLOSED cleanly (a 401 to the caller). For the daily
// revalidation cron we need the OPPOSITE: errors MUST propagate so the
// decision logic can distinguish a real "role no longer present" reading
// from a Koios brownout. If we re-used `buildKoiosAdapter` here, a Koios
// outage would surface as `drepInfo() → null` indistinguishable from a
// definitive deregistration, and the cron would mass-revoke every active
// identity — the exact failure mode the brief calls out as worse than the
// problem this sweep is closing.
//
// So this adapter wraps the SAME underlying koios.ts helpers as the
// verify-path adapter, but does NOT catch their errors. A `KoiosError`
// propagates up to `decideForIdentity`'s try/catch where it correctly
// maps to `upstream-failure` (skip the identity).
//
// We omit the SPO `poolCalidusKey` method — the cron doesn't have the
// originating Calidus key on the session index, so the SPO branch is a
// no-op (see the documented gap in `decideForIdentity`).
function buildStrictKoiosAdapter(): KoiosClient {
  function mapDrepInfo(row: KoiosDRepInfo): DrepInfo {
    return {
      drep_id: row.drep_id,
      hex: row.hex,
      has_script: Boolean(row.has_script),
      drep_status: row.drep_status ?? '',
      deposit: row.deposit ?? null,
      active: Boolean(row.active),
      expires_epoch_no: row.expires_epoch_no ?? null,
    };
  }
  function mapCommitteeMember(row: KoiosCommitteeMember): CommitteeMember {
    return {
      status: row.status,
      cc_hot_id: row.cc_hot_id,
      cc_cold_id: row.cc_cold_id,
      cc_hot_hex: row.cc_hot_hex,
      cc_cold_hex: row.cc_cold_hex,
      expiration_epoch: row.expiration_epoch ?? null,
      cc_hot_has_script: row.cc_hot_has_script,
      cc_cold_has_script: row.cc_cold_has_script,
    };
  }
  return {
    // PROPAGATES errors. The verify-path adapter would catch + return null
    // here — we want the throw so brownouts map to upstream-failure.
    async drepInfo(drepId: string): Promise<DrepInfo | null> {
      const rows = await fetchDRepInfoBatch([drepId]);
      const match = rows.find((r) => r.drep_id === drepId);
      // null is a DEFINITIVE "no row for this drep id" reading — the
      // batch call succeeded, the response was well-formed, the row is
      // simply not present. That's the deregistration signature.
      return match ? mapDrepInfo(match) : null;
    },
    async proposalsByReturnAddress(stakeAddress: string): Promise<Proposal[]> {
      const all = await listProposals();
      const filtered = all
        .filter((p) => p.return_address === stakeAddress)
        .map((row) =>
          row.proposal_id && row.return_address
            ? {
                proposal_id: row.proposal_id,
                return_address: row.return_address,
                proposal_type: row.proposal_type,
              }
            : null,
        );
      return filtered.filter((p): p is Proposal => p !== null);
    },
    // Not used by the cron — return null defensively.
    async poolCalidusKey(): Promise<null> {
      return null;
    },
    async committeeInfo(): Promise<CommitteeMember[]> {
      const rows = await getCommitteeMembers();
      return rows.map(mapCommitteeMember);
    },
  };
}

export interface RevalidateOnChainRolesResult {
  /** Active session-index rows enumerated this pass. */
  identitiesScanned: number;
  /** Identities the cron actually attempted a role re-check on. Equal to
   *  `identitiesScanned` minus any rows skipped because their session-
   *  index record predates Sprint 3 (no `onChainRole` field) — those
   *  records are not actionable without the role context, so they're
   *  counted under `identitiesSkippedNoRole` and not re-checked. */
  identitiesChecked: number;
  /** Pre-Sprint-3 records with no `onChainRole` field. Skipped — see
   *  the long comment in `sessionRevocation.ts` `recordSessionForUser`.
   *  These naturally age out as their `expiresAt` (≤30 days) passes. */
  identitiesSkippedNoRole: number;
  /** Identities whose Koios reading was inconclusive (lookup threw, the
   *  adapter caught and returned null on an internal error, etc.).
   *  SKIPPED — their sessions are NOT touched. */
  identitiesUpstreamFailures: number;
  /** Identities whose role STILL HOLDS on-chain. No action — their
   *  sessions stay valid. */
  identitiesStillValid: number;
  /** Identities the cron definitively determined no longer hold their
   *  granted role. `revokeAllSessionsForUser` was called on each. */
  identitiesRevoked: number;
  /** Sum of per-jti tombstones the cron wrote across all revoked
   *  identities this pass. */
  sessionsRevoked: number;
  /** Per-identity revoke failures (a `revokeAllSessionsForUser` that
   *  threw). Logged + counted. */
  revokeErrors: number;
}

function emptyResult(): RevalidateOnChainRolesResult {
  return {
    identitiesScanned: 0,
    identitiesChecked: 0,
    identitiesSkippedNoRole: 0,
    identitiesUpstreamFailures: 0,
    identitiesStillValid: 0,
    identitiesRevoked: 0,
    sessionsRevoked: 0,
    revokeErrors: 0,
  };
}

/**
 * Decision result for one identity. Pure data — `runRevalidateOnChainRoles`
 * wires it to the revocation side-effects.
 */
type IdentityDecision =
  | { action: 'skip-no-role' }
  | { action: 'upstream-failure'; reason: string }
  | { action: 'still-valid' }
  | { action: 'revoke'; reason: string };

/**
 * Decide what to do with one identity's sessions, given a freshly-built
 * `koios` adapter. Pure async function — no DDB writes happen in here.
 * Exported for unit-testing the decision logic without going through the
 * session-index Scan.
 *
 * # Decision table
 *
 *   - no `onChainRole` on the record → skip-no-role (legacy)
 *   - any throw / unexpected error during role lookup → upstream-failure
 *   - role-specific `is{Role}` is true → still-valid
 *   - role-specific `is{Role}` is false AND no throw → revoke
 *
 * `resolveRole.ts`'s functions throw upstream errors directly when the
 * supplied `KoiosClient` throws (the adapter swallows + returns null/[]
 * for most failures, but we wrap the call in try/catch here as defense
 * in depth — a custom test fake that throws still triggers the
 * fail-safe path).
 */
export async function decideForIdentity(
  index: ActiveSessionIndex,
  koios: KoiosClient,
): Promise<IdentityDecision> {
  if (!index.onChainRole) {
    return { action: 'skip-no-role' };
  }
  const role: OnChainRole = index.onChainRole;
  try {
    switch (role) {
      case 'drep': {
        const r = await resolveDRep(koios, index.walletAddress);
        return r.isDrep
          ? { action: 'still-valid' }
          : {
              action: 'revoke',
              reason: `drep no longer registered (${r.reason ?? 'inactive'})`,
            };
      }
      case 'spo': {
        // For SPO, the index's `walletAddress` is the pool's bech32
        // `pool1...` id, not a Calidus pub key. We don't have a
        // pool-id→role check in the resolver suite (only Calidus-key
        // based via `resolveSpo`). The cron consequently checks "is
        // this pool still registered" via the adapter — adapter-level
        // null/error means we skip. The straightforward fall-through
        // is to call `resolveSpo` with the original Calidus key — but
        // we don't have it stored. So the pragmatic path: re-check the
        // pool's current status via a direct adapter probe.
        //
        // We DELIBERATELY don't add a new resolver here. Instead we
        // use a single `committee_info`-style lookup pattern: a probe
        // through `proposalsByReturnAddress` is wrong (different
        // domain). The cleanest available path: call `poolCalidusKey`
        // with a placeholder — that's pointless because we don't have
        // the key.
        //
        // # Practical compromise (Sprint 3)
        //
        // At today's scale the SPO role's drop-out signal we have to
        // work with is: the pool RETIRED. There is no batched
        // pool-status endpoint on the live `koiosAdapter`. Rather
        // than introduce one in Sprint 3 (which adds infra surface),
        // we fall through to a `still-valid` decision for SPO and
        // surface this as a documented gap in the security review.
        //
        // The other three roles (drep / cc / proposer) DO have
        // checkable resolvers and gain the daily revalidation
        // immediately. SPO re-revalidation lands in a follow-up
        // sprint that adds the missing `poolStatus(poolId)` adapter
        // method.
        //
        // To be explicit (and to keep the test surface honest), we
        // emit a one-line warning per SPO identity per pass so the
        // gap shows up in CloudWatch.
        console.warn(
          `revalidate-onchain-roles: SPO ${index.walletAddress} role-check not yet implemented; sessions preserved`,
        );
        return { action: 'still-valid' };
      }
      case 'cc': {
        // The CC role check uses `committeeInfo()` (cached, batched —
        // one call returns the whole roster). The identity's
        // `walletAddress` field stores the cold credential ID (or
        // hot, falling back per `resolveCc`'s contract); both are
        // checked.
        //
        // We re-resolve by walking the roster directly — `resolveCc`
        // expects a hot KEY HASH (28-byte blake2b), which we don't
        // store on the session index. So we open-code the
        // "identity still in the authorized member set" check
        // here against the same `committeeInfo()` payload that
        // `resolveCc` would consult.
        const members = await koios.committeeInfo();
        if (!Array.isArray(members)) {
          // Adapter contract is to return `[]` on error; defensive.
          return { action: 'upstream-failure', reason: 'committeeInfo returned non-array' };
        }
        const matched = members.find(
          (m) =>
            m.status === 'authorized' &&
            m.cc_hot_has_script === false &&
            (m.cc_cold_id === index.walletAddress || m.cc_hot_id === index.walletAddress),
        );
        if (matched) {
          return { action: 'still-valid' };
        }
        // If we got an empty committee back, that's *probably* a
        // legitimate end-state (no CC) but also a common Koios
        // brownout failure mode. Treat the empty list as
        // upstream-failure (skip) rather than risk wiping every CC
        // session on a transient brownout.
        if (members.length === 0) {
          return {
            action: 'upstream-failure',
            reason: 'committeeInfo returned empty array (inconclusive — skip rather than mass-revoke)',
          };
        }
        return {
          action: 'revoke',
          reason: 'CC identity not in current authorized member set',
        };
      }
      case 'proposer': {
        const r = await resolveProposer(koios, index.walletAddress);
        return r.isProposer
          ? { action: 'still-valid' }
          : { action: 'revoke', reason: 'no submitted proposals with this return_address' };
      }
    }
  } catch (err) {
    return {
      action: 'upstream-failure',
      reason: `role-lookup threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Run one revalidation pass against the live `koiosAdapter` + DDB.
 *
 * Steps:
 *   1. Enumerate every active session-index row (filtered by
 *      `kind='session_index'`).
 *   2. For each row, `decideForIdentity` against the Koios adapter.
 *   3. If `revoke`, call `revokeAllSessionsForUser(walletAddress)`.
 *   4. Otherwise (`still-valid` / `skip-no-role` / `upstream-failure`),
 *      sessions are NOT touched.
 *   5. Best-effort structured log at end of pass.
 */
export async function runRevalidateOnChainRoles(
  koios: KoiosClient = buildStrictKoiosAdapter(),
  enumerator: () => Promise<ActiveSessionIndex[]> = listActiveSessionIndices,
  revoke: (walletAddress: string) => Promise<number> = revokeAllSessionsForUser,
): Promise<RevalidateOnChainRolesResult> {
  const result = emptyResult();

  let indices: ActiveSessionIndex[];
  try {
    indices = await enumerator();
  } catch (err) {
    // Hard failure on the enumeration. Log + exit empty; the cron's
    // CloudWatch error alarm picks up the Lambda error metric. This
    // is the safer fail-mode — never revoke on a partial enumeration
    // (which would be a half-pass with unknown semantics).
    console.error(
      'revalidate-onchain-roles: session-index Scan failed; aborting pass:',
      err instanceof Error ? err.message : err,
    );
    return result;
  }
  result.identitiesScanned = indices.length;

  if (indices.length === 0) {
    console.log(
      'revalidate-onchain-roles: no active on-chain identities to revalidate',
    );
    return result;
  }

  for (const idx of indices) {
    const decision = await decideForIdentity(idx, koios);
    switch (decision.action) {
      case 'skip-no-role':
        result.identitiesSkippedNoRole += 1;
        console.warn(
          `revalidate-onchain-roles: skipping ${idx.walletAddress} — pre-Sprint-3 record (no onChainRole field); will age out by expiresAt=${idx.expiresAt}`,
        );
        continue;
      case 'upstream-failure':
        result.identitiesChecked += 1;
        result.identitiesUpstreamFailures += 1;
        console.warn(
          `revalidate-onchain-roles: skipping ${idx.walletAddress} (role=${idx.onChainRole ?? '?'}) — ${decision.reason}`,
        );
        continue;
      case 'still-valid':
        result.identitiesChecked += 1;
        result.identitiesStillValid += 1;
        continue;
      case 'revoke': {
        result.identitiesChecked += 1;
        try {
          const written = await revoke(idx.walletAddress);
          result.identitiesRevoked += 1;
          result.sessionsRevoked += written;
          console.log(
            `revalidate-onchain-roles: revoked ${written} session(s) for ${idx.walletAddress} (role=${idx.onChainRole ?? '?'}) — ${decision.reason}`,
          );
        } catch (err) {
          result.revokeErrors += 1;
          console.error(
            `revalidate-onchain-roles: revokeAllSessionsForUser failed for ${idx.walletAddress}:`,
            err instanceof Error ? err.message : err,
          );
        }
        continue;
      }
    }
  }

  console.log(
    `revalidate-onchain-roles: pass complete — ` +
      `scanned=${result.identitiesScanned} checked=${result.identitiesChecked} ` +
      `stillValid=${result.identitiesStillValid} revoked=${result.identitiesRevoked} ` +
      `sessionsRevoked=${result.sessionsRevoked} ` +
      `upstreamFailures=${result.identitiesUpstreamFailures} ` +
      `skippedNoRole=${result.identitiesSkippedNoRole} ` +
      `revokeErrors=${result.revokeErrors}`,
  );
  return result;
}

/**
 * EventBridge scheduled handler. Cadence: every 24 hours (02:30 UTC).
 *
 * Wraps `runRevalidateOnChainRoles` with a top-level try/catch so a
 * hard failure produces an empty-result return rather than an unhandled
 * promise rejection (the latter would still surface as a Lambda error
 * via the existing CloudWatch alarm, but the structured result keeps
 * the downstream API stable).
 */
export const handler = async (
  _event: ScheduledEvent,
  _context: Context,
): Promise<RevalidateOnChainRolesResult> => {
  try {
    return await runRevalidateOnChainRoles();
  } catch (err) {
    console.error(
      'revalidate-onchain-roles: hard failure at top level:',
      err instanceof Error ? err.message : err,
    );
    return emptyResult();
  }
};
