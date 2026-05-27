/**
 * Tests for `runPoolMetadataSync` — populates the `pool_metadata` DDB
 * cache from Koios's `/pool_list` + `/pool_metadata`.
 *
 * # Invariants under test
 *
 *   1. First pass over an empty table writes every pool's row.
 *   2. Second pass with unchanged data writes ZERO rows (idempotent
 *      compare-then-write).
 *   3. Ticker / name / homepage changes trigger a fresh Put.
 *   4. Pools missing from `/pool_metadata` still get a row written
 *      (so the read path sees them as "cached, no human-readable
 *      identifiers" rather than "missing from cache").
 *   5. Total-cycle Koios failure on `/pool_list` aborts gracefully
 *      (no writes; errors counter increments).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../lib/koios', () => ({
  listAllPools: vi.fn(),
  fetchPoolMetadata: vi.fn(),
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

vi.mock('../lib/dynamodb', () => ({
  batchGetItems: vi.fn(),
  putItem: vi.fn(),
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

import { listAllPools, fetchPoolMetadata, KoiosError } from '../lib/koios';
import { batchGetItems, putItem } from '../lib/dynamodb';
import {
  runPoolMetadataSync,
  buildPoolMetadataItem,
  type PoolMetadataItem,
} from './pool-metadata';

const mockListAllPools = vi.mocked(listAllPools);
const mockFetchPoolMetadata = vi.mocked(fetchPoolMetadata);
const mockBatchGet = vi.mocked(batchGetItems);
const mockPut = vi.mocked(putItem);

const POOL_A = 'pool1aaaa';
const POOL_B = 'pool1bbbb';

beforeEach(() => {
  vi.clearAllMocks();
  mockListAllPools.mockResolvedValue([]);
  mockFetchPoolMetadata.mockResolvedValue([]);
  mockBatchGet.mockResolvedValue([]);
  mockPut.mockResolvedValue(undefined);
});

describe('runPoolMetadataSync — first pass (cold table)', () => {
  it('writes one row per pool when the table is empty', async () => {
    mockListAllPools.mockResolvedValue([
      {
        pool_id_bech32: POOL_A,
        pool_id_hex: 'aaaa',
        ticker: 'AAA',
        pool_status: 'registered',
        retiring_epoch: null,
        active_stake: '1000000',
      },
      {
        pool_id_bech32: POOL_B,
        pool_id_hex: 'bbbb',
        ticker: 'BBB',
        pool_status: 'registered',
        retiring_epoch: null,
        active_stake: '2000000',
      },
    ]);
    mockFetchPoolMetadata.mockResolvedValue([
      {
        pool_id_bech32: POOL_A,
        meta_url: 'https://example.com/a.json',
        meta_hash: 'hash_a',
        meta_json: { name: 'Pool Alpha', ticker: 'AAA', homepage: 'https://a.io' },
      },
    ]);

    const result = await runPoolMetadataSync();

    expect(result.totalPools).toBe(2);
    expect(result.poolsWithMetadata).toBe(1);
    expect(result.rowsWritten).toBe(2);
    expect(result.rowsSkipped).toBe(0);
    expect(result.errors).toBe(0);
    expect(mockPut).toHaveBeenCalledTimes(2);
  });

  it('writes a row even for pools missing from /pool_metadata', async () => {
    mockListAllPools.mockResolvedValue([
      {
        pool_id_bech32: POOL_A,
        pool_id_hex: 'aaaa',
        ticker: null, // also no on-chain ticker
        pool_status: 'registered',
        retiring_epoch: null,
        active_stake: '1000000',
      },
    ]);
    // Empty metadata response — this pool registered no anchor.
    mockFetchPoolMetadata.mockResolvedValue([]);

    const result = await runPoolMetadataSync();

    expect(result.rowsWritten).toBe(1);
    const written = mockPut.mock.calls[0]![1] as PoolMetadataItem;
    expect(written.poolId).toBe(POOL_A);
    // No ticker / name / homepage — but row exists so the read path
    // can distinguish "cached, no data" from "cache miss".
    expect(written.ticker).toBeUndefined();
    expect(written.name).toBeUndefined();
  });
});

describe('runPoolMetadataSync — idempotency', () => {
  it('writes zero rows on a second pass with unchanged data', async () => {
    const POOL = {
      pool_id_bech32: POOL_A,
      pool_id_hex: 'aaaa',
      ticker: 'AAA',
      pool_status: 'registered',
      retiring_epoch: null,
      active_stake: '1000000',
    };
    const META = {
      pool_id_bech32: POOL_A,
      meta_url: 'https://example.com/a.json',
      meta_hash: 'hash_a',
      meta_json: { name: 'Pool Alpha', ticker: 'AAA', homepage: 'https://a.io' },
    };
    mockListAllPools.mockResolvedValue([POOL]);
    mockFetchPoolMetadata.mockResolvedValue([META]);
    // Existing row matches what the candidate will produce. Use the
    // helper to build it so this stays in lockstep with the production
    // code.
    const existing = buildPoolMetadataItem(POOL, META, '2026-05-01T00:00:00.000Z');
    mockBatchGet.mockResolvedValue([existing]);

    const result = await runPoolMetadataSync();

    expect(result.rowsWritten).toBe(0);
    expect(result.rowsSkipped).toBe(1);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('writes a row when the ticker changes', async () => {
    const POOL_OLD = {
      pool_id_bech32: POOL_A,
      pool_id_hex: 'aaaa',
      ticker: 'OLD',
      pool_status: 'registered',
      retiring_epoch: null,
      active_stake: '1000000',
    };
    const POOL_NEW = { ...POOL_OLD, ticker: 'NEW' };
    mockListAllPools.mockResolvedValue([POOL_NEW]);
    mockFetchPoolMetadata.mockResolvedValue([]);
    // Existing row has the old ticker.
    mockBatchGet.mockResolvedValue([
      buildPoolMetadataItem(POOL_OLD, undefined, '2026-05-01T00:00:00.000Z'),
    ]);

    const result = await runPoolMetadataSync();

    expect(result.rowsWritten).toBe(1);
    expect(result.rowsSkipped).toBe(0);
    const written = mockPut.mock.calls[0]![1] as PoolMetadataItem;
    expect(written.ticker).toBe('NEW');
  });
});

describe('runPoolMetadataSync — failure modes', () => {
  it('aborts the cycle when /pool_list throws KoiosError', async () => {
    mockListAllPools.mockRejectedValue(new KoiosError('/pool_list', 'HTTP 503', 503));

    const result = await runPoolMetadataSync();

    expect(result.totalPools).toBe(0);
    expect(result.rowsWritten).toBe(0);
    expect(result.errors).toBe(1);
    expect(mockPut).not.toHaveBeenCalled();
  });
});

describe('buildPoolMetadataItem — field mapping', () => {
  it('prefers on-chain ticker when both sources have one', () => {
    const item = buildPoolMetadataItem(
      {
        pool_id_bech32: POOL_A,
        pool_id_hex: 'aaaa',
        ticker: 'ONCHAIN',
        pool_status: 'registered',
        retiring_epoch: null,
        active_stake: '1000000',
      },
      {
        pool_id_bech32: POOL_A,
        meta_url: 'https://example.com/a.json',
        meta_hash: 'hash_a',
        meta_json: { ticker: 'METADATA', name: 'X' },
      },
      '2026-05-01T00:00:00.000Z',
    );
    // On-chain wins — it's the source of truth for tickers.
    expect(item.ticker).toBe('ONCHAIN');
  });

  it('falls back to metadata ticker when on-chain is null', () => {
    const item = buildPoolMetadataItem(
      {
        pool_id_bech32: POOL_A,
        pool_id_hex: 'aaaa',
        ticker: null,
        pool_status: 'registered',
        retiring_epoch: null,
        active_stake: '1000000',
      },
      {
        pool_id_bech32: POOL_A,
        meta_url: 'https://example.com/a.json',
        meta_hash: 'hash_a',
        meta_json: { ticker: 'METADATA' },
      },
      '2026-05-01T00:00:00.000Z',
    );
    expect(item.ticker).toBe('METADATA');
  });
});
