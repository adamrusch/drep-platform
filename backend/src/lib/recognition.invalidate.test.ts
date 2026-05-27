/**
 * Regression tests for `_invalidateForStake` — the cache-eviction helper
 * called from `/auth/verify` and `/auth/session DELETE` (logout). Ships
 * with Batch F (#15, 2026-05-27).
 *
 * # The bug this guards against
 *
 * `lookupCurrentDrep` and `lookupStake` each cache their result for 60s
 * per-Lambda-container. A user who re-delegates between two sign-ins
 * (or signs out → signs back in) would otherwise see the OLD DRep's
 * clubhouse routing for up to a minute after authenticating. The
 * helper evicts BOTH caches' entries for the auth-flow stake address
 * so the next lookup in THIS container reads fresh.
 *
 * Per-container scope is by design — see the helper docstring. The
 * tests below assume a single container.
 *
 * # What we lock in
 *
 *   1. The helper evicts both `lookupCurrentDrep` and `lookupStake`
 *      caches for the given stake.
 *   2. After invalidate, the next call re-fetches from the upstream
 *      (Koios mock fires a second time).
 *   3. Invalidate is a no-op when the cache is empty (safe to call
 *      blindly from auth flows).
 *   4. Invalidate is scoped to the GIVEN stake — other addresses'
 *      cached entries survive.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./koios', () => ({
  fetchAccountInfo: vi.fn(),
  KoiosError: class KoiosError extends Error {
    public readonly status: number | undefined;
    public readonly endpoint: string;
    constructor(endpoint: string, message: string, status?: number) {
      super(`[Koios ${endpoint}] ${message}`);
      this.name = 'KoiosError';
      this.endpoint = endpoint;
      this.status = status;
    }
  },
}));

vi.mock('./blockfrost', () => ({
  getAccountInfo: vi.fn(),
}));

import { fetchAccountInfo } from './koios';
import { getAccountInfo } from './blockfrost';
import {
  lookupCurrentDrep,
  lookupStake,
  _invalidateForStake,
  _resetCurrentDrepCache,
  _resetStakeCache,
} from './recognition';

const mockKoios = vi.mocked(fetchAccountInfo);
const mockBlockfrost = vi.mocked(getAccountInfo);

const STAKE_A = 'stake1uyvjdz9rxsfsmv44rtk75k2rqyqskrga96dgdfrqjvjjpwsefcjnp';
const STAKE_B = 'stake1u90atgcj2vjp7y6ddnqxhg4l7zr4f6rde5h7zztu8ulptyqx0a2tx';
const DREP_OLD = 'drep1ygqgayvx8yzsaj9hprja3l6jy3v4px9z3u8uvecuvm3f92ce7mckx';
const DREP_NEW = 'drep1nv3yk8z2vm2gltn4y3kvy8rzqavkx3pn3yqz0p5dxq5gxzpqzvqq';
const LOVELACE_OLD = '10000000000';
const LOVELACE_NEW = '99999999999';

function koiosOk(drepId: string, lovelace: string): unknown {
  return {
    stake_address: STAKE_A,
    status: 'registered',
    delegated_pool: null,
    delegated_drep: drepId,
    total_balance: lovelace,
    utxo: null,
    rewards: null,
    withdrawals: null,
    rewards_available: null,
    reserves: null,
    treasury: null,
  };
}

describe('_invalidateForStake', () => {
  beforeEach(() => {
    _resetCurrentDrepCache();
    _resetStakeCache();
    mockKoios.mockReset();
    mockBlockfrost.mockReset();
  });

  it('cache hit BEFORE invalidate; cache miss (re-fetch) AFTER invalidate — lookupCurrentDrep', async () => {
    // First call populates the cache with the OLD DRep.
    mockKoios.mockResolvedValueOnce(koiosOk(DREP_OLD, LOVELACE_OLD) as never);
    const r1 = await lookupCurrentDrep(STAKE_A);
    expect(r1.drepId).toBe(DREP_OLD);
    expect(mockKoios).toHaveBeenCalledTimes(1);

    // Second call within the TTL — served from cache, no upstream hit.
    const r2 = await lookupCurrentDrep(STAKE_A);
    expect(r2.drepId).toBe(DREP_OLD);
    expect(mockKoios).toHaveBeenCalledTimes(1);

    // Invalidate (simulating a sign-in after re-delegation).
    _invalidateForStake(STAKE_A);

    // Third call should hit Koios again — fresh upstream read with the
    // NEW DRep id, no longer served from the prior cache entry.
    mockKoios.mockResolvedValueOnce(koiosOk(DREP_NEW, LOVELACE_NEW) as never);
    const r3 = await lookupCurrentDrep(STAKE_A);
    expect(r3.drepId).toBe(DREP_NEW);
    expect(mockKoios).toHaveBeenCalledTimes(2);
  });

  it('evicts the lookupStake cache as well as lookupCurrentDrep', async () => {
    // Populate the stake cache via lookupStake.
    mockKoios.mockResolvedValueOnce(koiosOk(DREP_OLD, LOVELACE_OLD) as never);
    const s1 = await lookupStake(STAKE_A);
    expect(s1.lovelace).toBe(LOVELACE_OLD);
    expect(mockKoios).toHaveBeenCalledTimes(1);

    // Cache hit.
    const s2 = await lookupStake(STAKE_A);
    expect(s2.lovelace).toBe(LOVELACE_OLD);
    expect(mockKoios).toHaveBeenCalledTimes(1);

    // Invalidate evicts BOTH caches.
    _invalidateForStake(STAKE_A);

    // Re-fetch.
    mockKoios.mockResolvedValueOnce(koiosOk(DREP_OLD, LOVELACE_NEW) as never);
    const s3 = await lookupStake(STAKE_A);
    expect(s3.lovelace).toBe(LOVELACE_NEW);
    expect(mockKoios).toHaveBeenCalledTimes(2);
  });

  it('is scoped to the given stake address (other addresses survive)', async () => {
    // Populate caches for both STAKE_A and STAKE_B.
    mockKoios.mockResolvedValueOnce(koiosOk(DREP_OLD, LOVELACE_OLD) as never);
    await lookupCurrentDrep(STAKE_A);

    mockKoios.mockResolvedValueOnce({
      stake_address: STAKE_B,
      status: 'registered',
      delegated_pool: null,
      delegated_drep: DREP_NEW,
      total_balance: LOVELACE_NEW,
      utxo: null,
      rewards: null,
      withdrawals: null,
      rewards_available: null,
      reserves: null,
      treasury: null,
    } as never);
    await lookupCurrentDrep(STAKE_B);

    expect(mockKoios).toHaveBeenCalledTimes(2);

    // Invalidate only STAKE_A.
    _invalidateForStake(STAKE_A);

    // STAKE_B's cache entry must still be live — no upstream call.
    const b2 = await lookupCurrentDrep(STAKE_B);
    expect(b2.drepId).toBe(DREP_NEW);
    expect(mockKoios).toHaveBeenCalledTimes(2);

    // STAKE_A must re-fetch.
    mockKoios.mockResolvedValueOnce(koiosOk(DREP_OLD, LOVELACE_OLD) as never);
    const a2 = await lookupCurrentDrep(STAKE_A);
    expect(a2.drepId).toBe(DREP_OLD);
    expect(mockKoios).toHaveBeenCalledTimes(3);
  });

  it('is a no-op (does not throw) when neither cache has an entry for the stake', async () => {
    // Auth-flow handlers call this unconditionally on every verify /
    // logout, including the very first call before any lookup has ever
    // populated the cache. Must be safe.
    expect(() => _invalidateForStake(STAKE_A)).not.toThrow();
    expect(() => _invalidateForStake('stake1uneverhitthecache')).not.toThrow();
  });

  it('is idempotent — calling twice for the same stake is harmless', async () => {
    mockKoios.mockResolvedValueOnce(koiosOk(DREP_OLD, LOVELACE_OLD) as never);
    await lookupCurrentDrep(STAKE_A);
    expect(mockKoios).toHaveBeenCalledTimes(1);

    _invalidateForStake(STAKE_A);
    _invalidateForStake(STAKE_A); // Second call — already evicted.

    // Re-fetch still works.
    mockKoios.mockResolvedValueOnce(koiosOk(DREP_NEW, LOVELACE_NEW) as never);
    const r = await lookupCurrentDrep(STAKE_A);
    expect(r.drepId).toBe(DREP_NEW);
    expect(mockKoios).toHaveBeenCalledTimes(2);
  });
});
