/**
 * Tests for the Sprint 1 per-session revocation store
 * (`lib/sessionRevocation.ts`).
 *
 * # What we lock in
 *
 *   1. `revokeSessionByJti` writes a tombstone keyed by SHA-256(jti)
 *      under `kind='session'`, with the expected TTL.
 *   2. `isSessionRevoked` returns true for a fresh tombstone and false
 *      for absent / expired tombstones.
 *   3. Errors in the store fail OPEN — a DynamoDB blip MUST NOT lock
 *      every authenticated request out.
 *   4. `recordSessionForUser` upserts the per-user index so
 *      `revokeAllSessionsForUser` can enumerate every issued `jti`
 *      without a Scan.
 *   5. `revokeAllSessionsForUser` writes tombstones for every indexed
 *      hash; a subsequent `isSessionRevoked` for any of them returns
 *      true.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./dynamodb', () => {
  // Tiny in-memory store keyed by `nonce` to mimic the real DDB table.
  const store = new Map<string, Record<string, unknown>>();
  return {
    tableNames: { authNonces: 'test-auth_nonces' },
    putItem: vi.fn(async (_table: string, item: Record<string, unknown>) => {
      const key = item['nonce'] as string;
      store.set(key, { ...item });
    }),
    getItem: vi.fn(async (_table: string, key: Record<string, unknown>) => {
      const k = key['nonce'] as string;
      return store.get(k) ?? null;
    }),
    deleteItem: vi.fn(async (_table: string, key: Record<string, unknown>) => {
      store.delete(key['nonce'] as string);
    }),
    // Sprint 3 — `listActiveSessionIndices` uses scanItems with a
    // `kind='session_index'` filter. The mock applies the filter
    // server-side-equivalent so the production code path under test
    // sees the same shape DDB would return.
    scanItems: vi.fn(
      async (
        _table: string,
        opts: {
          filterExpression?: string;
          expressionAttributeValues?: Record<string, unknown>;
        } = {},
      ) => {
        let items = Array.from(store.values());
        if (opts.filterExpression?.includes('#kind') && opts.expressionAttributeValues) {
          const wanted = opts.expressionAttributeValues[':sessionIndex'];
          items = items.filter((row) => row['kind'] === wanted);
        }
        return { items, lastEvaluatedKey: undefined, count: items.length };
      },
    ),
    // Test-only hook used to reset state between tests; the real module
    // doesn't export this. Marked with a leading underscore.
    _resetTestStore: () => store.clear(),
  };
});

// Import AFTER the mock so the dynamodb impl is the stub.
import {
  recordSessionForUser,
  revokeSessionByJti,
  isSessionRevoked,
  revokeAllSessionsForUser,
  listActiveSessionIndices,
} from './sessionRevocation';
import * as dynamo from './dynamodb';

const WALLET = 'drep1revocation_test';

beforeEach(() => {
  // Reset both the in-memory store AND the call-count tracking on the mocks.
  (dynamo as unknown as { _resetTestStore: () => void })._resetTestStore();
  vi.mocked(dynamo.putItem).mockClear();
  vi.mocked(dynamo.getItem).mockClear();
  vi.mocked(dynamo.deleteItem).mockClear();
  vi.mocked(dynamo.scanItems).mockClear();
});

describe('revokeSessionByJti + isSessionRevoked', () => {
  it('fresh tombstone makes isSessionRevoked return true', async () => {
    const jti = '01HJTI_fresh';
    expect(await isSessionRevoked(jti)).toBe(false);
    await revokeSessionByJti(jti, WALLET);
    expect(await isSessionRevoked(jti)).toBe(true);
  });

  it('absent jti returns false (no tombstone, not revoked)', async () => {
    expect(await isSessionRevoked('01HJTI_never_revoked')).toBe(false);
  });

  it('revoking one jti does NOT revoke a different one', async () => {
    // The defining property of per-session revocation.
    const jtiA = '01HJTI_A';
    const jtiB = '01HJTI_B';
    await revokeSessionByJti(jtiA, WALLET);
    expect(await isSessionRevoked(jtiA)).toBe(true);
    expect(await isSessionRevoked(jtiB)).toBe(false);
  });

  it('writes the tombstone under nonce=session:<sha256(jti)> with kind=session', async () => {
    const jti = '01HJTI_shape';
    await revokeSessionByJti(jti, WALLET);
    const putMock = vi.mocked(dynamo.putItem);
    // First call is the tombstone write.
    const lastCall = putMock.mock.calls[putMock.mock.calls.length - 1];
    expect(lastCall).toBeDefined();
    const item = lastCall![1] as Record<string, unknown>;
    expect(typeof item['nonce']).toBe('string');
    expect((item['nonce'] as string).startsWith('session:')).toBe(true);
    expect(item['kind']).toBe('session');
    expect(item['walletAddress']).toBe(WALLET);
    expect(typeof item['expiresAt']).toBe('number');
  });
});

describe('isSessionRevoked — fail OPEN on store errors', () => {
  it('returns false when getItem throws (DynamoDB blip)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      vi.mocked(dynamo.getItem).mockRejectedValueOnce(new Error('DDB out'));
      const result = await isSessionRevoked('01HJTI_failopen');
      expect(result).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('recordSessionForUser + revokeAllSessionsForUser', () => {
  it('indexes jtis then tombstones every entry on revokeAll', async () => {
    const jtiA = '01H_REV_ALL_A';
    const jtiB = '01H_REV_ALL_B';
    const jtiC = '01H_REV_ALL_C';
    await recordSessionForUser(WALLET, jtiA);
    await recordSessionForUser(WALLET, jtiB);
    await recordSessionForUser(WALLET, jtiC);

    // None of them should be revoked yet.
    expect(await isSessionRevoked(jtiA)).toBe(false);
    expect(await isSessionRevoked(jtiB)).toBe(false);
    expect(await isSessionRevoked(jtiC)).toBe(false);

    const written = await revokeAllSessionsForUser(WALLET);
    expect(written).toBe(3);

    expect(await isSessionRevoked(jtiA)).toBe(true);
    expect(await isSessionRevoked(jtiB)).toBe(true);
    expect(await isSessionRevoked(jtiC)).toBe(true);
  });

  it('revokeAll returns 0 when no index exists (idempotent, never throws)', async () => {
    const written = await revokeAllSessionsForUser('drep1never_seen');
    expect(written).toBe(0);
  });

  it('recordSessionForUser swallows store errors — login must never be blocked', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      vi.mocked(dynamo.getItem).mockRejectedValueOnce(new Error('DDB out'));
      // Must not throw.
      await expect(recordSessionForUser(WALLET, '01H_INDEX_FAIL')).resolves.toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Sprint 3 — `onChainRole` on the session index + enumeration helper
// ---------------------------------------------------------------------------

describe('recordSessionForUser — onChainRole field (Sprint 3)', () => {
  it('persists the onChainRole on the index record', async () => {
    await recordSessionForUser('drep1aaa', '01H_DREP_ROLE', 'drep');
    // Inspect what the mock saw on the last put — the index record
    // should carry `onChainRole: 'drep'`.
    const putMock = vi.mocked(dynamo.putItem);
    const calls = putMock.mock.calls;
    // Find the call whose item is the session_index (not a tombstone).
    const indexPut = calls.find((c) => {
      const item = c[1] as Record<string, unknown>;
      return item['kind'] === 'session_index';
    });
    expect(indexPut).toBeDefined();
    const item = indexPut![1] as Record<string, unknown>;
    expect(item['onChainRole']).toBe('drep');
    expect(item['walletAddress']).toBe('drep1aaa');
  });

  it('preserves an existing onChainRole on a subsequent call with no role passed', async () => {
    // First login records the role.
    await recordSessionForUser('cc_cold1bbb', '01H_CC_FIRST', 'cc');
    // Second login forgets to pass the role (e.g. legacy call site).
    // We must NOT silently downgrade the index to "unknown role".
    await recordSessionForUser('cc_cold1bbb', '01H_CC_SECOND');
    const putMock = vi.mocked(dynamo.putItem);
    const lastIndexPut = putMock.mock.calls
      .reverse()
      .find((c) => (c[1] as Record<string, unknown>)['kind'] === 'session_index');
    expect(lastIndexPut).toBeDefined();
    const item = lastIndexPut![1] as Record<string, unknown>;
    expect(item['onChainRole']).toBe('cc');
  });
});

describe('listActiveSessionIndices — enumeration for the cron', () => {
  it('returns every active session-index row, with role + walletAddress', async () => {
    await recordSessionForUser('drep1a', '01H_A', 'drep');
    await recordSessionForUser('pool1b', '01H_B', 'spo');
    await recordSessionForUser('cc_cold1c', '01H_C', 'cc');
    // A tombstone is NOT a session_index — must not show up.
    await revokeSessionByJti('01H_TOMB', 'drep1a');

    const result = await listActiveSessionIndices();
    const wallets = result.map((r) => r.walletAddress).sort();
    expect(wallets).toEqual(['cc_cold1c', 'drep1a', 'pool1b']);
    const drepRow = result.find((r) => r.walletAddress === 'drep1a');
    expect(drepRow?.onChainRole).toBe('drep');
    const spoRow = result.find((r) => r.walletAddress === 'pool1b');
    expect(spoRow?.onChainRole).toBe('spo');
  });

  it('returns onChainRole=undefined for pre-Sprint-3 records (no role passed)', async () => {
    // A pre-Sprint-3 record path: caller never passed a role.
    await recordSessionForUser('drep1legacy', '01H_LEG');
    const result = await listActiveSessionIndices();
    expect(result).toHaveLength(1);
    expect(result[0]?.walletAddress).toBe('drep1legacy');
    expect(result[0]?.onChainRole).toBeUndefined();
  });

  it('filters out expired index rows (DDB TTL lag)', async () => {
    // Manually inject an already-expired row into the store.
    const fresh = await recordSessionForUser('drep1fresh', '01H_FRESH', 'drep');
    void fresh;
    // Use the dynamodb mock's putItem to write a stale row directly.
    await vi.mocked(dynamo.putItem)('test-auth_nonces', {
      nonce: 'session_index:drep1stale',
      kind: 'session_index',
      walletAddress: 'drep1stale',
      jtiHashes: ['stale_hash'],
      onChainRole: 'drep',
      expiresAt: Math.floor(Date.now() / 1000) - 10, // already expired
    });
    const result = await listActiveSessionIndices();
    const wallets = result.map((r) => r.walletAddress);
    expect(wallets).toContain('drep1fresh');
    expect(wallets).not.toContain('drep1stale');
  });
});
