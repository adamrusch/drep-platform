/**
 * Tests for `getPoolName` / `getPoolNamesBulk` / `getCCMemberName` /
 * `getCCMemberNamesBulk` — the read helpers that turn bech32 SPO and
 * CC voter IDs into human-readable display strings on the Votes tab.
 *
 * # Invariants under test
 *
 *   1. Cache hit returns immediately without touching DDB.
 *   2. Cache miss issues a BatchGet, populates the cache, and returns
 *      the resolved name.
 *   3. DDB miss (row absent) returns empty result for pools / undefined
 *      for CC members, AND caches the empty result so a hot-burst of
 *      lookups for unregistered voters doesn't hammer DDB.
 *   4. DDB error does NOT cache — next call retries fresh.
 *   5. Bulk variant honors the cache for already-seen entries and only
 *      BatchGets the uncached subset.
 *   6. CC member reserved `'META'` ID is never looked up (defensive
 *      against a malformed voter ID).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./blockfrost', () => ({
  getAccountInfo: vi.fn(),
}));

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

vi.mock('./dynamodb', () => ({
  batchGetItems: vi.fn(),
  tableNames: {
    users: 'test-users',
    drepCommittees: 'test-drep_committees',
    drepDirectory: 'test-drep_directory',
    governanceActions: 'test-governance_actions',
    governanceVotes: 'test-governance_votes',
    comments: 'test-comments',
    commentVotes: 'test-comment_votes',
    clubhousePosts: 'test-clubhouse_posts',
    poolMetadata: 'test-pool_metadata',
    ccMembers: 'test-cc_members',
    auditLog: 'test-audit_log',
    authNonces: 'test-auth_nonces',
  },
}));

import { batchGetItems } from './dynamodb';
import {
  getPoolName,
  getPoolNamesBulk,
  getCCMemberName,
  getCCMemberNamesBulk,
  _resetPoolNameCache,
  _resetCCNameCache,
} from './recognition';

const mockBatchGet = vi.mocked(batchGetItems);

const POOL_A = 'pool1aaaa';
const POOL_B = 'pool1bbbb';
const HOT_A = 'cc_hot_aaaa';
const HOT_B = 'cc_hot_bbbb';

beforeEach(() => {
  vi.clearAllMocks();
  _resetPoolNameCache();
  _resetCCNameCache();
  mockBatchGet.mockResolvedValue([]);
});

describe('getPoolName', () => {
  it('returns ticker + name when the row is in DDB', async () => {
    mockBatchGet.mockResolvedValue([
      { poolId: POOL_A, ticker: 'AAA', name: 'Pool Alpha' },
    ]);

    const result = await getPoolName(POOL_A);

    expect(result).toEqual({ ticker: 'AAA', name: 'Pool Alpha' });
    expect(mockBatchGet).toHaveBeenCalledTimes(1);
  });

  it('returns empty object when the pool row is missing', async () => {
    mockBatchGet.mockResolvedValue([]);

    const result = await getPoolName(POOL_A);

    expect(result).toEqual({});
  });

  it('caches the result — second call does NOT hit DDB', async () => {
    mockBatchGet.mockResolvedValue([
      { poolId: POOL_A, ticker: 'AAA', name: 'Pool Alpha' },
    ]);

    const first = await getPoolName(POOL_A);
    const second = await getPoolName(POOL_A);

    expect(first).toEqual(second);
    // Cache hit on second call — DDB only called once.
    expect(mockBatchGet).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache on DDB error', async () => {
    mockBatchGet.mockRejectedValueOnce(new Error('DDB transient'));
    mockBatchGet.mockResolvedValueOnce([
      { poolId: POOL_A, ticker: 'AAA', name: 'Pool Alpha' },
    ]);

    const first = await getPoolName(POOL_A);
    expect(first).toEqual({}); // error returns empty

    // Second call retries fresh (not cached).
    const second = await getPoolName(POOL_A);
    expect(second).toEqual({ ticker: 'AAA', name: 'Pool Alpha' });
    expect(mockBatchGet).toHaveBeenCalledTimes(2);
  });
});

describe('getPoolNamesBulk', () => {
  it('returns one map entry per pool ID, including misses', async () => {
    mockBatchGet.mockResolvedValue([
      { poolId: POOL_A, ticker: 'AAA', name: 'Pool Alpha' },
      // POOL_B is missing — should land in the map with an empty result.
    ]);

    const result = await getPoolNamesBulk([POOL_A, POOL_B]);

    expect(result.size).toBe(2);
    expect(result.get(POOL_A)).toEqual({ ticker: 'AAA', name: 'Pool Alpha' });
    expect(result.get(POOL_B)).toEqual({});
  });

  it('does NOT re-fetch pools already in the cache', async () => {
    mockBatchGet.mockResolvedValueOnce([
      { poolId: POOL_A, ticker: 'AAA', name: 'Pool Alpha' },
    ]);
    await getPoolNamesBulk([POOL_A]); // warm cache

    mockBatchGet.mockResolvedValueOnce([
      { poolId: POOL_B, ticker: 'BBB', name: 'Pool Beta' },
    ]);

    const result = await getPoolNamesBulk([POOL_A, POOL_B]);

    expect(result.get(POOL_A)).toEqual({ ticker: 'AAA', name: 'Pool Alpha' });
    expect(result.get(POOL_B)).toEqual({ ticker: 'BBB', name: 'Pool Beta' });
    // Second call only requested POOL_B keys (POOL_A served from cache).
    const secondCallKeys = mockBatchGet.mock.calls[1]![1] as Array<{
      poolId: string;
    }>;
    expect(secondCallKeys.map((k) => k.poolId)).toEqual([POOL_B]);
  });

  it('returns empty map for empty input without hitting DDB', async () => {
    const result = await getPoolNamesBulk([]);
    expect(result.size).toBe(0);
    expect(mockBatchGet).not.toHaveBeenCalled();
  });
});

describe('getCCMemberName', () => {
  it('returns the name when the cache row has one', async () => {
    mockBatchGet.mockResolvedValue([
      { ccHotCred: HOT_A, ccName: 'Alice CC' },
    ]);

    const result = await getCCMemberName(HOT_A);

    expect(result).toBe('Alice CC');
  });

  it('returns undefined when the row exists but has no ccName', async () => {
    mockBatchGet.mockResolvedValue([{ ccHotCred: HOT_A }]); // no ccName

    const result = await getCCMemberName(HOT_A);

    expect(result).toBeUndefined();
  });

  it('returns undefined and skips DDB when looking up the reserved META key', async () => {
    const result = await getCCMemberName('META');

    expect(result).toBeUndefined();
    expect(mockBatchGet).not.toHaveBeenCalled();
  });

  it('caches the undefined result so misses do not re-hit DDB', async () => {
    mockBatchGet.mockResolvedValue([]); // no row

    await getCCMemberName(HOT_A);
    await getCCMemberName(HOT_A);

    expect(mockBatchGet).toHaveBeenCalledTimes(1);
  });
});

describe('getCCMemberNamesBulk', () => {
  it('returns only entries with non-empty names', async () => {
    mockBatchGet.mockResolvedValue([
      { ccHotCred: HOT_A, ccName: 'Alice CC' },
      { ccHotCred: HOT_B }, // no name — excluded from map
    ]);

    const result = await getCCMemberNamesBulk([HOT_A, HOT_B]);

    expect(result.size).toBe(1);
    expect(result.get(HOT_A)).toBe('Alice CC');
    expect(result.has(HOT_B)).toBe(false);
  });

  it('filters out the reserved META key from the BatchGet', async () => {
    mockBatchGet.mockResolvedValue([
      { ccHotCred: HOT_A, ccName: 'Alice CC' },
    ]);

    await getCCMemberNamesBulk([HOT_A, 'META']);

    const keysFetched = mockBatchGet.mock.calls[0]![1] as Array<{
      ccHotCred: string;
    }>;
    expect(keysFetched.map((k) => k.ccHotCred)).toEqual([HOT_A]);
  });
});
