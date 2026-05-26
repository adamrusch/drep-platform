/**
 * Regression tests for `lookupCurrentDrep` — the helper that makes
 * `/auth/me` return the user's LIVE on-chain DRep delegation rather
 * than the stale `drepId` baked into the JWT at sign-in time.
 *
 * # The bug this guards against (2026-05-26)
 *
 * `/auth/verify` was issuing JWTs with `existing?.drepId` — the DRep id
 * stored on the `users` table row, set when the user ran the
 * `/drep/register` flow (i.e., became a DRep THEMSELVES). The frontend
 * Clubhouse landing, `WalletAuthProvider`, and `/auth/me` all read that
 * same field and treated it as "the DRep I delegate to."
 *
 * Those are different concepts on-chain. A wallet that delegates to
 * DRep X but has never registered itself as a DRep had `drepId` ===
 * undefined in the JWT, and the Clubhouse routing fell through to a
 * stored `delegationHistory` snapshot in DynamoDB — which is even
 * staler than the JWT.
 *
 * Adam reported it as "my wallet's chosen DRep is not being
 * recognized."  Fix: `/auth/me` now also surfaces a `delegatedToDrepId`
 * field, populated by `lookupCurrentDrep` via Koios primary +
 * Blockfrost fallback on every call, cached for 60s.
 *
 * # What we want to lock in
 *
 *   1. Stake addresses route to Koios first.
 *   2. Koios error → Blockfrost fallback, NOT giving up.
 *   3. Both upstreams error → return `{drepId: null, source: null}` so
 *      the handler can distinguish "unknown" from "confirmed not
 *      delegated."
 *   4. Payment addresses skip the upstream entirely (the endpoint
 *      doesn't accept them).
 *   5. Results are cached for ~60s so a hot session-mount burst
 *      doesn't hammer upstream.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock both upstream modules BEFORE importing the SUT. Vitest hoists
// `vi.mock` calls so this is order-safe even though it looks backwards.
vi.mock('./koios', () => ({
  fetchAccountInfo: vi.fn(),
  // KoiosError needs to be importable as a class — we throw it from
  // the mocked `fetchAccountInfo` to exercise the fallback path.
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

import { fetchAccountInfo, KoiosError } from './koios';
import { getAccountInfo } from './blockfrost';
import { lookupCurrentDrep, _resetCurrentDrepCache } from './recognition';

const mockKoios = vi.mocked(fetchAccountInfo);
const mockBlockfrost = vi.mocked(getAccountInfo);

const STAKE_ADDR = 'stake1uyvjdz9rxsfsmv44rtk75k2rqyqskrga96dgdfrqjvjjpwsefcjnp';
const PAYMENT_ADDR = 'addr1qx2zgg0u72n8ym37umue04k6hg3uecmv554dv5r2n44d3w83vk3rduurs4et8zw5cf27guvfseqn0643sq4qhklcs88q8t7tdm';
const DREP_ID = 'drep1ygqgayvx8yzsaj9hprja3l6jy3v4px9z3u8uvecuvm3f92ce7mckx';

describe('lookupCurrentDrep', () => {
  beforeEach(() => {
    _resetCurrentDrepCache();
    mockKoios.mockReset();
    mockBlockfrost.mockReset();
  });

  it('returns the Koios delegated_drep when Koios responds', async () => {
    mockKoios.mockResolvedValueOnce({
      stake_address: STAKE_ADDR,
      status: 'registered',
      delegated_pool: null,
      delegated_drep: DREP_ID,
      total_balance: '10000000000',
      utxo: null,
      rewards: null,
      withdrawals: null,
      rewards_available: null,
      reserves: null,
      treasury: null,
    });

    const result = await lookupCurrentDrep(STAKE_ADDR);

    expect(result).toEqual({ drepId: DREP_ID, source: 'koios' });
    expect(mockKoios).toHaveBeenCalledExactlyOnceWith(STAKE_ADDR);
    expect(mockBlockfrost).not.toHaveBeenCalled();
  });

  it('returns drepId=null source=koios when Koios reports the address is undelegated', async () => {
    // Koios returns the row but with `delegated_drep: null` — meaning
    // the address is registered but hasn't filed a vote-delegation cert.
    // This is a CONFIRMED answer, not an error. Caller should render
    // "no DRep" rather than retrying or rendering "unknown".
    mockKoios.mockResolvedValueOnce({
      stake_address: STAKE_ADDR,
      status: 'registered',
      delegated_pool: null,
      delegated_drep: null,
      total_balance: '10000000000',
      utxo: null,
      rewards: null,
      withdrawals: null,
      rewards_available: null,
      reserves: null,
      treasury: null,
    });

    const result = await lookupCurrentDrep(STAKE_ADDR);

    expect(result).toEqual({ drepId: null, source: 'koios' });
    expect(mockBlockfrost).not.toHaveBeenCalled();
  });

  it('returns drepId=null source=koios when Koios reports the address is not in the cache', async () => {
    // Koios returns null for unregistered stake addresses (never staked).
    mockKoios.mockResolvedValueOnce(null);

    const result = await lookupCurrentDrep(STAKE_ADDR);

    expect(result).toEqual({ drepId: null, source: 'koios' });
    expect(mockBlockfrost).not.toHaveBeenCalled();
  });

  it('falls back to Blockfrost when Koios throws KoiosError', async () => {
    mockKoios.mockRejectedValueOnce(
      new KoiosError('/account_info_cached', 'HTTP 503 Service Unavailable', 503),
    );
    mockBlockfrost.mockResolvedValueOnce({
      stake_address: STAKE_ADDR,
      controlled_amount: '10000000000',
      drep_id: DREP_ID,
      pool_id: null,
      active: true,
    } as never);

    const result = await lookupCurrentDrep(STAKE_ADDR);

    expect(result).toEqual({ drepId: DREP_ID, source: 'blockfrost-fallback' });
    expect(mockKoios).toHaveBeenCalledTimes(1);
    expect(mockBlockfrost).toHaveBeenCalledExactlyOnceWith(STAKE_ADDR);
  });

  it('falls back to Blockfrost when Koios throws an unexpected error', async () => {
    // Defensive — `lookupCurrentDrep` falls back on any throw, not just
    // KoiosError instances. This protects against future Koios client
    // revisions that surface transport errors differently.
    mockKoios.mockRejectedValueOnce(new Error('unexpected'));
    mockBlockfrost.mockResolvedValueOnce({
      stake_address: STAKE_ADDR,
      controlled_amount: '10000000000',
      drep_id: DREP_ID,
      pool_id: null,
      active: true,
    } as never);

    const result = await lookupCurrentDrep(STAKE_ADDR);

    expect(result.drepId).toBe(DREP_ID);
    expect(result.source).toBe('blockfrost-fallback');
  });

  it('returns source=null when BOTH upstreams fail', async () => {
    // The "unknown" return: caller cannot distinguish from "not
    // delegated" by drepId alone, so we surface `source: null` as the
    // marker. `/auth/me` reads this and omits the `delegatedToDrepId`
    // field entirely (rather than falsely returning null).
    mockKoios.mockRejectedValueOnce(
      new KoiosError('/account_info_cached', 'HTTP 503'),
    );
    mockBlockfrost.mockRejectedValueOnce(new Error('Blockfrost 429'));

    const result = await lookupCurrentDrep(STAKE_ADDR);

    expect(result).toEqual({ drepId: null, source: null });
  });

  it('skips upstream entirely for payment-address fallback (addr1...)', async () => {
    // `useWalletAuth` falls back to `getUsedAddresses()[0]` when the
    // wallet doesn't expose a reward address, yielding a payment address
    // (`addr1...`). The `account_info_cached` endpoint only accepts
    // stake addresses; calling it with a payment address would error
    // and burn an upstream round-trip. Short-circuit early.
    const result = await lookupCurrentDrep(PAYMENT_ADDR);

    expect(result).toEqual({ drepId: null, source: null });
    expect(mockKoios).not.toHaveBeenCalled();
    expect(mockBlockfrost).not.toHaveBeenCalled();
  });

  it('caches successful Koios results for 60s', async () => {
    mockKoios.mockResolvedValueOnce({
      stake_address: STAKE_ADDR,
      status: 'registered',
      delegated_pool: null,
      delegated_drep: DREP_ID,
      total_balance: '10000000000',
      utxo: null,
      rewards: null,
      withdrawals: null,
      rewards_available: null,
      reserves: null,
      treasury: null,
    });

    // First call hits Koios.
    const r1 = await lookupCurrentDrep(STAKE_ADDR);
    expect(r1.drepId).toBe(DREP_ID);
    expect(mockKoios).toHaveBeenCalledTimes(1);

    // Second call within the TTL window — served from cache, no
    // additional upstream traffic.
    const r2 = await lookupCurrentDrep(STAKE_ADDR);
    expect(r2.drepId).toBe(DREP_ID);
    expect(mockKoios).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache the both-providers-failed case (retries next time)', async () => {
    // Caching a both-failed result for 60s would mean a transient Koios
    // outage stamps the user as "unknown" for a full minute even after
    // both upstreams recover. The next request after a both-failed must
    // retry fresh.
    mockKoios.mockRejectedValueOnce(new KoiosError('/account_info_cached', 'HTTP 503'));
    mockBlockfrost.mockRejectedValueOnce(new Error('Blockfrost 429'));

    const r1 = await lookupCurrentDrep(STAKE_ADDR);
    expect(r1.source).toBe(null);

    // Set up a fresh success for the retry.
    mockKoios.mockResolvedValueOnce({
      stake_address: STAKE_ADDR,
      status: 'registered',
      delegated_pool: null,
      delegated_drep: DREP_ID,
      total_balance: '10000000000',
      utxo: null,
      rewards: null,
      withdrawals: null,
      rewards_available: null,
      reserves: null,
      treasury: null,
    });

    const r2 = await lookupCurrentDrep(STAKE_ADDR);
    expect(r2.drepId).toBe(DREP_ID);
    // Koios was called BOTH times — the first failed-result was NOT cached.
    expect(mockKoios).toHaveBeenCalledTimes(2);
  });
});
