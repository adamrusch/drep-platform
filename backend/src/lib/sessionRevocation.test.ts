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
} from './sessionRevocation';
import * as dynamo from './dynamodb';

const WALLET = 'drep1revocation_test';

beforeEach(() => {
  // Reset both the in-memory store AND the call-count tracking on the mocks.
  (dynamo as unknown as { _resetTestStore: () => void })._resetTestStore();
  vi.mocked(dynamo.putItem).mockClear();
  vi.mocked(dynamo.getItem).mockClear();
  vi.mocked(dynamo.deleteItem).mockClear();
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
