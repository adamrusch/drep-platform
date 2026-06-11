/**
 * Tests for the per-session revocation store
 * (`lib/sessionRevocation.ts`) — Decision #1 (2026-06-10) version,
 * backed by the dedicated `identity_sessions` DynamoDB table.
 *
 * # What we lock in
 *
 *   1. `revokeSessionByJti` flips the row to `revoked:true` (creating
 *      a fresh row if the original login-time write missed).
 *   2. `isSessionRevoked` returns true ONLY for present + unexpired +
 *      revoked rows; false for absent / expired / active rows.
 *   3. Errors in the store fail OPEN — a DynamoDB blip MUST NOT lock
 *      every authenticated request out.
 *   4. `recordSessionForUser` writes a row keyed by SHA-256(jti) that
 *      the cron / revoke-all path can find via the
 *      `identityId-issuedAt-index` GSI.
 *   5. `revokeAllSessionsForUser` enumerates via the GSI and flips
 *      every active row; idempotent (already-revoked rows are
 *      skipped); never throws.
 *   6. `listActiveSessionIndices` folds the per-identity active rows
 *      into the same `ActiveSessionIndex` shape the cron consumes —
 *      surface preserved across the table migration.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory backing store for the mocked dynamodb module. Mimics the
// new `identity_sessions` table: PK=`sessionKey` with attributes
// `identityId`, `onChainRoles[]`, `issuedAt`, `expiresAt`, `revoked?`.
// The GSI `identityId-issuedAt-index` is emulated by the `queryItems`
// stub doing an in-memory filter against `identityId`.
vi.mock('./dynamodb', () => {
  const store = new Map<string, Record<string, unknown>>();
  return {
    tableNames: {
      authNonces: 'test-auth_nonces',
      identitySessions: 'test-identity_sessions',
    },
    putItem: vi.fn(async (_table: string, item: Record<string, unknown>) => {
      const key = item['sessionKey'] as string;
      store.set(key, { ...item });
    }),
    getItem: vi.fn(async (_table: string, key: Record<string, unknown>) => {
      const k = key['sessionKey'] as string;
      return store.get(k) ?? null;
    }),
    updateItem: vi.fn(
      async (
        _table: string,
        key: Record<string, unknown>,
        _updateExpr: string,
        _names: Record<string, string>,
        values: Record<string, unknown>,
      ) => {
        const k = key['sessionKey'] as string;
        const existing = store.get(k);
        if (!existing) {
          // Mimic DDB's missing-row update behavior. The production
          // `updateItem` would actually upsert (DDB Update on a missing
          // key inserts an "empty" item plus the SET attributes), but
          // for the test we want the catch-branch of
          // `revokeSessionByJti` to engage when the row genuinely
          // doesn't exist — throw to drive that path.
          const err = new Error('row not found');
          err.name = 'ConditionalCheckFailedException';
          throw err;
        }
        const updated: Record<string, unknown> = { ...existing };
        if (':true' in values) updated['revoked'] = values[':true'];
        if (':exp' in values) updated['expiresAt'] = values[':exp'];
        store.set(k, updated);
      },
    ),
    queryItems: vi.fn(
      async (
        _table: string,
        opts: {
          indexName?: string;
          expressionAttributeValues?: Record<string, unknown>;
        },
      ) => {
        // We only support the `identityId-issuedAt-index` GSI in this
        // fake — the production code only Queries via that index.
        const wanted = opts.expressionAttributeValues?.[':identityId'];
        const items = Array.from(store.values()).filter(
          (row) => row['identityId'] === wanted,
        );
        return { items, lastEvaluatedKey: undefined, count: items.length };
      },
    ),
    scanItems: vi.fn(
      async (
        _table: string,
        opts: {
          filterExpression?: string;
          expressionAttributeValues?: Record<string, unknown>;
        } = {},
      ) => {
        let items = Array.from(store.values());
        // Mimic the production filter:
        //   (attribute_not_exists(#revoked) OR #revoked = :false)
        //   AND #expiresAt > :now
        if (opts.filterExpression && opts.expressionAttributeValues) {
          const now = opts.expressionAttributeValues[':now'] as number;
          items = items.filter((row) => {
            const revoked = row['revoked'];
            const notRevoked = revoked === undefined || revoked === false;
            const expiresAt =
              typeof row['expiresAt'] === 'number'
                ? (row['expiresAt'] as number)
                : 0;
            return notRevoked && expiresAt > now;
          });
        }
        return { items, lastEvaluatedKey: undefined, count: items.length };
      },
    ),
    deleteItem: vi.fn(async () => undefined),
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
import { createHash } from 'node:crypto';

const WALLET = 'drep1revocation_test';

function hashJti(jti: string): string {
  return createHash('sha256').update(jti, 'utf8').digest('hex');
}

beforeEach(() => {
  (dynamo as unknown as { _resetTestStore: () => void })._resetTestStore();
  vi.mocked(dynamo.putItem).mockClear();
  vi.mocked(dynamo.getItem).mockClear();
  vi.mocked(dynamo.updateItem).mockClear();
  vi.mocked(dynamo.queryItems).mockClear();
  vi.mocked(dynamo.scanItems).mockClear();
});

// ---------------------------------------------------------------------------
// revokeSessionByJti + isSessionRevoked
// ---------------------------------------------------------------------------

describe('revokeSessionByJti + isSessionRevoked', () => {
  it('a freshly-recorded session is NOT revoked', async () => {
    const jti = '01HJTI_fresh';
    await recordSessionForUser(WALLET, jti, 'drep');
    expect(await isSessionRevoked(jti)).toBe(false);
  });

  it('revoking the session flips isSessionRevoked to true', async () => {
    const jti = '01HJTI_flipped';
    await recordSessionForUser(WALLET, jti, 'drep');
    await revokeSessionByJti(jti, WALLET);
    expect(await isSessionRevoked(jti)).toBe(true);
  });

  it('absent jti returns false (no row, not revoked)', async () => {
    expect(await isSessionRevoked('01HJTI_never_recorded')).toBe(false);
  });

  it('revoking jtiA does NOT revoke jtiB (per-session granularity)', async () => {
    // The defining property of per-session revocation.
    const jtiA = '01HJTI_A';
    const jtiB = '01HJTI_B';
    await recordSessionForUser(WALLET, jtiA, 'drep');
    await recordSessionForUser(WALLET, jtiB, 'drep');
    await revokeSessionByJti(jtiA, WALLET);
    expect(await isSessionRevoked(jtiA)).toBe(true);
    expect(await isSessionRevoked(jtiB)).toBe(false);
  });

  it('row shape: sessionKey = SHA-256(jti), revoked:true, identityId carried', async () => {
    const jti = '01HJTI_shape';
    await recordSessionForUser(WALLET, jti, 'drep');
    await revokeSessionByJti(jti, WALLET);
    const stored = await vi.mocked(dynamo.getItem)('test-identity_sessions', {
      sessionKey: hashJti(jti),
    });
    expect(stored).toBeTruthy();
    const row = stored as Record<string, unknown>;
    expect(row['sessionKey']).toBe(hashJti(jti));
    expect(row['identityId']).toBe(WALLET);
    expect(row['revoked']).toBe(true);
    expect(typeof row['expiresAt']).toBe('number');
  });

  it('revoking a jti that was NEVER recorded still flips isSessionRevoked to true', async () => {
    // Defensive — if `recordSessionForUser` missed at login time
    // (write blip), an explicit logout MUST still revoke the jti.
    // The implementation writes a fresh `revoked:true` row in this
    // branch.
    const jti = '01HJTI_no_record';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await revokeSessionByJti(jti, WALLET);
      expect(await isSessionRevoked(jti)).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// TTL / expiry handling
// ---------------------------------------------------------------------------

describe('isSessionRevoked — TTL/expiry', () => {
  it('returns false on a row whose expiresAt is in the past (DDB TTL lag)', async () => {
    const jti = '01HJTI_expired_tomb';
    // Hand-write a stale revoked row.
    await vi.mocked(dynamo.putItem)('test-identity_sessions', {
      sessionKey: hashJti(jti),
      identityId: WALLET,
      onChainRoles: ['drep'],
      issuedAt: Math.floor(Date.now() / 1000) - 1000,
      expiresAt: Math.floor(Date.now() / 1000) - 10, // already expired
      revoked: true,
    });
    expect(await isSessionRevoked(jti)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fail-OPEN on read errors
// ---------------------------------------------------------------------------

describe('isSessionRevoked — fail OPEN on store errors', () => {
  it('returns false when getItem throws (DynamoDB blip)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      vi.mocked(dynamo.getItem).mockRejectedValueOnce(new Error('DDB out'));
      const result = await isSessionRevoked('01HJTI_failopen');
      // Even if a tombstone EXISTS in the store, a read-error must
      // resolve to "not revoked" so the authorizer fails open. The
      // invariant the brief calls out: a store outage must not lock
      // everyone out.
      expect(result).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// recordSessionForUser + revokeAllSessionsForUser via the GSI
// ---------------------------------------------------------------------------

describe('recordSessionForUser + revokeAllSessionsForUser', () => {
  it('records N jtis then revokeAll flips every one of them', async () => {
    const jtiA = '01H_REV_ALL_A';
    const jtiB = '01H_REV_ALL_B';
    const jtiC = '01H_REV_ALL_C';
    await recordSessionForUser(WALLET, jtiA, 'drep');
    await recordSessionForUser(WALLET, jtiB, 'drep');
    await recordSessionForUser(WALLET, jtiC, 'drep');

    expect(await isSessionRevoked(jtiA)).toBe(false);
    expect(await isSessionRevoked(jtiB)).toBe(false);
    expect(await isSessionRevoked(jtiC)).toBe(false);

    const written = await revokeAllSessionsForUser(WALLET);
    expect(written).toBe(3);

    expect(await isSessionRevoked(jtiA)).toBe(true);
    expect(await isSessionRevoked(jtiB)).toBe(true);
    expect(await isSessionRevoked(jtiC)).toBe(true);
  });

  it('revokeAll returns 0 when no rows exist (idempotent, never throws)', async () => {
    const written = await revokeAllSessionsForUser('drep1never_seen');
    expect(written).toBe(0);
  });

  it('revokeAll is idempotent — already-revoked rows are NOT re-counted', async () => {
    const jtiA = '01H_REV_IDEM_A';
    const jtiB = '01H_REV_IDEM_B';
    await recordSessionForUser(WALLET, jtiA, 'drep');
    await recordSessionForUser(WALLET, jtiB, 'drep');
    await revokeAllSessionsForUser(WALLET); // revokes both
    // Re-revoke — every row is already revoked, count must be 0.
    const written2 = await revokeAllSessionsForUser(WALLET);
    expect(written2).toBe(0);
  });

  it('revokeAll only touches rows for the supplied identityId (GSI filter)', async () => {
    const myJti = '01H_REV_MY';
    const theirJti = '01H_REV_THEIRS';
    await recordSessionForUser(WALLET, myJti, 'drep');
    await recordSessionForUser('drep1someone_else', theirJti, 'drep');
    await revokeAllSessionsForUser(WALLET);
    expect(await isSessionRevoked(myJti)).toBe(true);
    // The other identity's session is untouched.
    expect(await isSessionRevoked(theirJti)).toBe(false);
  });

  it('recordSessionForUser swallows store errors — login must never be blocked', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      vi.mocked(dynamo.putItem).mockRejectedValueOnce(new Error('DDB out'));
      // Must not throw.
      await expect(
        recordSessionForUser(WALLET, '01H_INDEX_FAIL', 'drep'),
      ).resolves.toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it('revokeAll fails closed-but-quiet on a GSI Query throw (returns 0, no throw)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      vi.mocked(dynamo.queryItems).mockRejectedValueOnce(new Error('GSI out'));
      const written = await revokeAllSessionsForUser(WALLET);
      // No tombstones written — the legacy `tokenVersion` bump in
      // the caller (logout handler) is the safety net for this case.
      expect(written).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// recordSessionForUser — onChainRole field
// ---------------------------------------------------------------------------

describe('recordSessionForUser — onChainRole field', () => {
  it('persists the onChainRole on the session row', async () => {
    await recordSessionForUser('drep1aaa', '01H_DREP_ROLE', 'drep');
    // Inspect what the mock saw on the last put.
    const putMock = vi.mocked(dynamo.putItem);
    const calls = putMock.mock.calls;
    const sessionPut = calls.find((c) => {
      const item = c[1] as Record<string, unknown>;
      return item['identityId'] === 'drep1aaa';
    });
    expect(sessionPut).toBeDefined();
    const item = sessionPut![1] as Record<string, unknown>;
    expect(item['onChainRoles']).toEqual(['drep']);
    expect(item['identityId']).toBe('drep1aaa');
  });
});

// ---------------------------------------------------------------------------
// listActiveSessionIndices — enumeration for the cron
// ---------------------------------------------------------------------------

describe('listActiveSessionIndices — enumeration for the cron', () => {
  it('returns every active identity, folded with role + walletAddress', async () => {
    await recordSessionForUser('drep1a', '01H_A', 'drep');
    await recordSessionForUser('pool1b', '01H_B', 'spo');
    await recordSessionForUser('cc_cold1c', '01H_C', 'cc');
    // A revoked session is NOT active — must not show up.
    await recordSessionForUser('drep1a', '01H_TOMB', 'drep');
    await revokeSessionByJti('01H_TOMB', 'drep1a');

    const result = await listActiveSessionIndices();
    const wallets = result.map((r) => r.walletAddress).sort();
    expect(wallets).toEqual(['cc_cold1c', 'drep1a', 'pool1b']);
    const drepRow = result.find((r) => r.walletAddress === 'drep1a');
    expect(drepRow?.onChainRole).toBe('drep');
    const spoRow = result.find((r) => r.walletAddress === 'pool1b');
    expect(spoRow?.onChainRole).toBe('spo');
  });

  it('folds multiple active sessions for the same identity into one entry', async () => {
    await recordSessionForUser('drep1multi', '01H_M1', 'drep');
    await recordSessionForUser('drep1multi', '01H_M2', 'drep');
    await recordSessionForUser('drep1multi', '01H_M3', 'drep');

    const result = await listActiveSessionIndices();
    expect(result).toHaveLength(1);
    expect(result[0]?.walletAddress).toBe('drep1multi');
    expect(result[0]?.jtiHashes.length).toBe(3);
  });

  it('filters out revoked rows (only active sessions surface)', async () => {
    await recordSessionForUser('drep1mix', '01H_ACTIVE', 'drep');
    await recordSessionForUser('drep1mix', '01H_TOREVOKE', 'drep');
    await revokeSessionByJti('01H_TOREVOKE', 'drep1mix');

    const result = await listActiveSessionIndices();
    expect(result).toHaveLength(1);
    expect(result[0]?.walletAddress).toBe('drep1mix');
    expect(result[0]?.jtiHashes.length).toBe(1); // only the active one
  });

  it('filters out expired rows (DDB TTL lag)', async () => {
    await recordSessionForUser('drep1fresh', '01H_FRESH', 'drep');
    // Inject a stale (expired) row directly.
    const staleJti = '01H_STALE';
    await vi.mocked(dynamo.putItem)('test-identity_sessions', {
      sessionKey: hashJti(staleJti),
      identityId: 'drep1stale',
      onChainRoles: ['drep'],
      issuedAt: Math.floor(Date.now() / 1000) - 1000,
      expiresAt: Math.floor(Date.now() / 1000) - 10,
      revoked: false,
    });
    const result = await listActiveSessionIndices();
    const wallets = result.map((r) => r.walletAddress);
    expect(wallets).toContain('drep1fresh');
    expect(wallets).not.toContain('drep1stale');
  });
});
