// Adapter that maps the live drep-platform Koios client (`backend/src/lib/koios.ts`)
// onto the structural `KoiosClient` interface the ported identity resolvers use.
//
// Why a separate file (not in `identity/auth/koios.ts`): that file is the
// porting boundary — it ONLY declares the structural interface and reference
// shapes the resolvers consume. Implementations are caller concerns and stay
// in the live tree. This adapter is the one place the ported module reaches
// into the legacy Koios fetch helpers.
//
// What this adapter does NOT do:
//   - It does not cache. The legacy Koios client already has TTL caches
//     (drep_info ~10min, committee_info ~1hr) — wrapping with another layer
//     would just add staleness for no win.
//   - It does not fall back to Blockfrost. The identity flow is a
//     correctness-critical role check; if Koios is down, we'd rather fail
//     closed (return null / empty) so the caller surfaces a clean 401 or
//     503 than ship a token without a verified role.

import {
  fetchDRepInfoBatch,
  getCommitteeMembers,
  listAllPools,
  listProposals,
  type KoiosDRepInfo,
  type KoiosProposal,
  type KoiosCommitteeMember,
  type KoiosPool,
} from '../../koios';
import type {
  KoiosClient,
  DrepInfo,
  Proposal,
  PoolCalidusKeyRow,
  PoolStatusRow,
  CommitteeMember,
} from './koios';

const KOIOS_BASE = process.env['KOIOS_BASE_URL'] ?? 'https://api.koios.rest/api/v1';
/** Aggressive timeout for the SPO Calidus lookup — this is a small, single-
 *  row request, but a stuck Koios shouldn't keep the login hanging. */
const CALIDUS_TIMEOUT_MS = 8_000;

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

function mapProposal(row: KoiosProposal): Proposal | null {
  if (!row.proposal_id || !row.return_address) return null;
  return {
    proposal_id: row.proposal_id,
    return_address: row.return_address,
    proposal_type: row.proposal_type,
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

function mapPoolStatus(row: KoiosPool): PoolStatusRow {
  return {
    pool_id_bech32: row.pool_id_bech32,
    pool_status: row.pool_status,
    retiring_epoch: row.retiring_epoch ?? null,
  };
}

/**
 * Build a `KoiosClient` over the live drep-platform Koios helpers.
 *
 * The factory is parameterless on purpose — every method reads
 * `process.env['KOIOS_BASE_URL']` (with the standard public default) and
 * the underlying helpers cache + retry as configured upstream. Tests
 * supply a fake `KoiosClient` directly to the handlers; production code
 * calls this factory once per Lambda invocation.
 */
export function buildKoiosAdapter(): KoiosClient {
  return {
    async drepInfo(drepId: string): Promise<DrepInfo | null> {
      try {
        const rows = await fetchDRepInfoBatch([drepId]);
        const match = rows.find((r) => r.drep_id === drepId);
        return match ? mapDrepInfo(match) : null;
      } catch (err) {
        console.warn(
          'koiosAdapter.drepInfo: lookup failed:',
          err instanceof Error ? err.message : err,
        );
        return null;
      }
    },

    async proposalsByReturnAddress(stakeAddress: string): Promise<Proposal[]> {
      // The legacy client doesn't expose a return-address scoped lookup,
      // so we use the cached `/proposal_list` (it's already module-cached
      // in `koios.ts` for 60s) and filter in-memory. ~109 proposals on
      // mainnet today; this is a tiny pass.
      try {
        const all = await listProposals();
        return all
          .filter((p) => p.return_address === stakeAddress)
          .map(mapProposal)
          .filter((p): p is Proposal => p !== null);
      } catch (err) {
        console.warn(
          'koiosAdapter.proposalsByReturnAddress: listProposals failed:',
          err instanceof Error ? err.message : err,
        );
        return [];
      }
    },

    async poolCalidusKey(calidusPubKeyHex: string): Promise<PoolCalidusKeyRow | null> {
      // The legacy Koios client doesn't wrap `/pool_calidus_keys`, so we
      // hit Koios directly here. Single small POST — no need for the
      // streaming-response apparatus.
      try {
        const url = `${KOIOS_BASE}/pool_calidus_keys`;
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), CALIDUS_TIMEOUT_MS);
        let res: Response;
        try {
          res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            // Koios `/pool_calidus_keys` accepts `_calidus_pub_keys`
            // (lowercase). The endpoint is keyed; we keep the request
            // minimal so a stuck Koios doesn't hold a connection open.
            body: JSON.stringify({ _calidus_pub_keys: [calidusPubKeyHex.toLowerCase()] }),
            signal: ac.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        if (!res.ok) {
          console.warn(
            `koiosAdapter.poolCalidusKey: HTTP ${res.status} ${res.statusText}`,
          );
          return null;
        }
        const parsed = (await res.json()) as unknown;
        if (!Array.isArray(parsed)) return null;
        const rows = parsed as Array<{
          pool_id_bech32?: string;
          calidus_pub_key?: string;
          calidus_id_bech32?: string;
          registered?: boolean;
          pool_status?: string;
        }>;
        const want = calidusPubKeyHex.toLowerCase();
        const match = rows.find(
          (r) => typeof r.calidus_pub_key === 'string' && r.calidus_pub_key.toLowerCase() === want,
        );
        if (!match) return null;
        if (
          typeof match.pool_id_bech32 !== 'string' ||
          typeof match.calidus_pub_key !== 'string' ||
          typeof match.calidus_id_bech32 !== 'string' ||
          typeof match.registered !== 'boolean' ||
          typeof match.pool_status !== 'string'
        ) {
          return null;
        }
        return {
          pool_id_bech32: match.pool_id_bech32,
          calidus_pub_key: match.calidus_pub_key,
          calidus_id_bech32: match.calidus_id_bech32,
          registered: match.registered,
          pool_status: match.pool_status,
        };
      } catch (err) {
        console.warn(
          'koiosAdapter.poolCalidusKey: lookup failed:',
          err instanceof Error ? err.message : err,
        );
        return null;
      }
    },

    async committeeInfo(): Promise<CommitteeMember[]> {
      try {
        const rows = await getCommitteeMembers();
        return rows.map(mapCommitteeMember);
      } catch (err) {
        console.warn(
          'koiosAdapter.committeeInfo: lookup failed:',
          err instanceof Error ? err.message : err,
        );
        return [];
      }
    },

    async poolStatus(poolIdBech32: string): Promise<PoolStatusRow | null> {
      // The legacy Koios client doesn't wrap a single-pool `/pool_info`
      // lookup, but it DOES wrap `/pool_list` (paginated full roster) via
      // `listAllPools` — used by the pool-metadata sync to enumerate every
      // pool ID. We piggyback on that here: one paginated walk, then
      // filter to the requested pool. The verify-path adapter is
      // expected to fail-CLOSED on errors (return null), matching the
      // other methods on this file.
      //
      // # Why `/pool_list` and not a per-pool `/pool_info`
      //
      // The cron's batch enumeration path will issue ONE poolStatus
      // call per active SPO identity per day. At today's scale (handful
      // of identities) the per-call cost of pulling the full pool list
      // is acceptable, and the legacy client already module-caches the
      // result (30 min TTL via `listActivePools`'s `_poolCache`).
      //
      // The strict adapter under `revalidate-onchain-roles.ts` will
      // override this method to propagate errors instead of swallowing,
      // so the cron can distinguish a definitive "pool absent" from a
      // brownout.
      try {
        const rows = await listAllPools();
        const match = rows.find((r) => r.pool_id_bech32 === poolIdBech32);
        return match ? mapPoolStatus(match) : null;
      } catch (err) {
        console.warn(
          'koiosAdapter.poolStatus: lookup failed:',
          err instanceof Error ? err.message : err,
        );
        return null;
      }
    },

    async poolCalidusKeyByPool(poolIdBech32: string): Promise<PoolCalidusKeyRow | null> {
      // M5 fix (2026-06-10 security review) — look up the CURRENT
      // Calidus key for a pool by pool id. Same `/pool_calidus_keys`
      // endpoint as `poolCalidusKey` above but with the inverse filter
      // (`_pool_id_bech32` instead of `_calidus_pub_keys`). Returns the
      // registered row when present, null when there's no current
      // registered Calidus key.
      //
      // The verify-path adapter fails CLOSED on errors (returns null);
      // the strict adapter used by `revalidate-onchain-roles.ts`
      // overrides this method to propagate so the cron can
      // fail-SAFE — never revoke an SPO on a Koios brownout.
      try {
        const url = `${KOIOS_BASE}/pool_calidus_keys`;
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), CALIDUS_TIMEOUT_MS);
        let res: Response;
        try {
          res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify({ _pool_id_bech32: [poolIdBech32] }),
            signal: ac.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        if (!res.ok) {
          console.warn(
            `koiosAdapter.poolCalidusKeyByPool: HTTP ${res.status} ${res.statusText}`,
          );
          return null;
        }
        const parsed = (await res.json()) as unknown;
        if (!Array.isArray(parsed)) return null;
        const rows = parsed as Array<{
          pool_id_bech32?: string;
          calidus_pub_key?: string;
          calidus_id_bech32?: string;
          registered?: boolean;
          pool_status?: string;
        }>;
        // Find the registered Calidus key row for the requested pool.
        // If Koios returns multiple rows for the pool (history), we
        // want the registered one — CIP-151 says only one Calidus key
        // is registered at a time.
        const match = rows.find(
          (r) =>
            typeof r.pool_id_bech32 === 'string' &&
            r.pool_id_bech32 === poolIdBech32 &&
            r.registered === true,
        );
        if (!match) return null;
        if (
          typeof match.pool_id_bech32 !== 'string' ||
          typeof match.calidus_pub_key !== 'string' ||
          typeof match.calidus_id_bech32 !== 'string' ||
          typeof match.registered !== 'boolean' ||
          typeof match.pool_status !== 'string'
        ) {
          return null;
        }
        return {
          pool_id_bech32: match.pool_id_bech32,
          calidus_pub_key: match.calidus_pub_key,
          calidus_id_bech32: match.calidus_id_bech32,
          registered: match.registered,
          pool_status: match.pool_status,
        };
      } catch (err) {
        console.warn(
          'koiosAdapter.poolCalidusKeyByPool: lookup failed:',
          err instanceof Error ? err.message : err,
        );
        return null;
      }
    },
  };
}
