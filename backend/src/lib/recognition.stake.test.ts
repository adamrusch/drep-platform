/**
 * Regression tests for `lookupStake` — the helper that snapshots a
 * voter's wallet stake (lovelace) at the moment they cast a comment vote.
 * The stake is persisted on the vote row so the support-level math is
 * reproducible — re-reading at render time would let the displayed
 * total drift silently as wallets gain or lose balance.
 *
 * Mirrors the `lookupCurrentDrep` test set with the analogous semantics:
 *
 *   1. Stake addresses → Koios primary.
 *   2. Koios error → Blockfrost fallback.
 *   3. Both upstreams error → return `{lovelace: null, source: null}`
 *      so the caller (vote handler) can hard-reject the vote rather
 *      than silently recording a zero-weight vote.
 *   4. Payment-address fallback skips the upstream entirely.
 *   5. Successful results cache for ~60s; both-providers-failed does NOT
 *      cache (so a transient outage doesn't pin a user at zero stake).
 *   6. Undelegated / not-in-cache returns lovelace: null source: koios.
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

import { fetchAccountInfo, KoiosError } from './koios';
import { getAccountInfo } from './blockfrost';
import { lookupStake, _resetStakeCache } from './recognition';

const mockKoios = vi.mocked(fetchAccountInfo);
const mockBlockfrost = vi.mocked(getAccountInfo);

const STAKE_ADDR = 'stake1uyvjdz9rxsfsmv44rtk75k2rqyqskrga96dgdfrqjvjjpwsefcjnp';
const PAYMENT_ADDR =
  'addr1qx2zgg0u72n8ym37umue04k6hg3uecmv554dv5r2n44d3w83vk3rduurs4et8zw5cf27guvfseqn0643sq4qhklcs88q8t7tdm';
const LOVELACE = '12345678900';

describe('lookupStake', () => {
  beforeEach(() => {
    _resetStakeCache();
    mockKoios.mockReset();
    mockBlockfrost.mockReset();
  });

  it('returns Koios total_balance when Koios responds', async () => {
    mockKoios.mockResolvedValueOnce({
      stake_address: STAKE_ADDR,
      status: 'registered',
      delegated_pool: null,
      delegated_drep: null,
      total_balance: LOVELACE,
      utxo: null,
      rewards: null,
      withdrawals: null,
      rewards_available: null,
      reserves: null,
      treasury: null,
    });

    const result = await lookupStake(STAKE_ADDR);

    expect(result).toEqual({ lovelace: LOVELACE, source: 'koios' });
    expect(mockKoios).toHaveBeenCalledExactlyOnceWith(STAKE_ADDR);
    expect(mockBlockfrost).not.toHaveBeenCalled();
  });

  it('returns lovelace: null source: koios when Koios reports the address is unregistered', async () => {
    // Koios returns null for stake addresses missing from the cache —
    // a confirmed "not staked" answer. Caller should still treat the
    // result as authoritative (source !== null) and proceed.
    mockKoios.mockResolvedValueOnce(null);

    const result = await lookupStake(STAKE_ADDR);

    expect(result).toEqual({ lovelace: null, source: 'koios' });
    expect(mockBlockfrost).not.toHaveBeenCalled();
  });

  it('falls back to Blockfrost when Koios throws KoiosError', async () => {
    mockKoios.mockRejectedValueOnce(
      new KoiosError('/account_info_cached', 'HTTP 503 Service Unavailable', 503),
    );
    mockBlockfrost.mockResolvedValueOnce({
      stake_address: STAKE_ADDR,
      controlled_amount: LOVELACE,
      drep_id: null,
      pool_id: null,
      active: true,
    } as never);

    const result = await lookupStake(STAKE_ADDR);

    expect(result).toEqual({ lovelace: LOVELACE, source: 'blockfrost-fallback' });
    expect(mockKoios).toHaveBeenCalledTimes(1);
    expect(mockBlockfrost).toHaveBeenCalledExactlyOnceWith(STAKE_ADDR);
  });

  it('falls back to Blockfrost on unexpected Koios error', async () => {
    mockKoios.mockRejectedValueOnce(new Error('unexpected'));
    mockBlockfrost.mockResolvedValueOnce({
      stake_address: STAKE_ADDR,
      controlled_amount: LOVELACE,
      drep_id: null,
      pool_id: null,
      active: true,
    } as never);

    const result = await lookupStake(STAKE_ADDR);

    expect(result.lovelace).toBe(LOVELACE);
    expect(result.source).toBe('blockfrost-fallback');
  });

  it('returns source: null when BOTH upstreams fail', async () => {
    // The hard-reject signal — the vote handler reads `source === null`
    // and returns 500 rather than persisting a zero-weight vote.
    mockKoios.mockRejectedValueOnce(new KoiosError('/account_info_cached', 'HTTP 503'));
    mockBlockfrost.mockRejectedValueOnce(new Error('Blockfrost 429'));

    const result = await lookupStake(STAKE_ADDR);

    expect(result).toEqual({ lovelace: null, source: null });
  });

  it('skips upstream entirely for payment-address fallback (addr1...)', async () => {
    const result = await lookupStake(PAYMENT_ADDR);

    expect(result).toEqual({ lovelace: null, source: null });
    expect(mockKoios).not.toHaveBeenCalled();
    expect(mockBlockfrost).not.toHaveBeenCalled();
  });

  it('caches successful Koios results for 60s', async () => {
    mockKoios.mockResolvedValueOnce({
      stake_address: STAKE_ADDR,
      status: 'registered',
      delegated_pool: null,
      delegated_drep: null,
      total_balance: LOVELACE,
      utxo: null,
      rewards: null,
      withdrawals: null,
      rewards_available: null,
      reserves: null,
      treasury: null,
    });

    const r1 = await lookupStake(STAKE_ADDR);
    expect(r1.lovelace).toBe(LOVELACE);
    expect(mockKoios).toHaveBeenCalledTimes(1);

    const r2 = await lookupStake(STAKE_ADDR);
    expect(r2.lovelace).toBe(LOVELACE);
    // Cache hit — no additional upstream call.
    expect(mockKoios).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache the both-providers-failed case (retries next time)', async () => {
    // Same correctness story as lookupCurrentDrep: a transient outage
    // must not stamp a user as zero-stake for a full minute.
    mockKoios.mockRejectedValueOnce(new KoiosError('/account_info_cached', 'HTTP 503'));
    mockBlockfrost.mockRejectedValueOnce(new Error('Blockfrost 429'));

    const r1 = await lookupStake(STAKE_ADDR);
    expect(r1.source).toBe(null);

    mockKoios.mockResolvedValueOnce({
      stake_address: STAKE_ADDR,
      status: 'registered',
      delegated_pool: null,
      delegated_drep: null,
      total_balance: LOVELACE,
      utxo: null,
      rewards: null,
      withdrawals: null,
      rewards_available: null,
      reserves: null,
      treasury: null,
    });

    const r2 = await lookupStake(STAKE_ADDR);
    expect(r2.lovelace).toBe(LOVELACE);
    // Koios was called BOTH times — the prior failure was NOT cached.
    expect(mockKoios).toHaveBeenCalledTimes(2);
  });
});
