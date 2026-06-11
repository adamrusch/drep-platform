/**
 * Decision #3 (2026-06-10) — `/auth/onchain/me` aggregation tests.
 *
 * Proves:
 *   - The handler reads the person + every linked credential and
 *     surfaces them with the role union.
 *   - The pre-Decision-3 fallback path (no `personId` on the JWT)
 *     resolves via the carried credential and still returns the
 *     correct profile.
 *   - A legacy CIP-30 session (no on-chain roles) is rejected with
 *     401 — this endpoint is for on-chain sessions only.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const store = new Map<string, Record<string, unknown>>();
function k(table: string, pk: string): string {
  return `${table}::${pk}`;
}

vi.mock('../../lib/dynamodb', () => ({
  tableNames: {
    onchainUsers: 'test-onchain_users',
    identityLinks: 'test-identity_links',
  },
  getItem: vi.fn(async (table: string, key: Record<string, unknown>) => {
    const pk =
      (key['personId'] as string | undefined) ??
      (key['identityKey'] as string | undefined);
    if (!pk) return undefined;
    return store.get(k(table, pk));
  }),
  putItem: vi.fn(async (table: string, item: Record<string, unknown>) => {
    const pk =
      (item['personId'] as string | undefined) ??
      (item['identityKey'] as string | undefined);
    if (!pk) throw new Error('mock putItem: no recognised PK');
    store.set(k(table, pk), { ...item });
  }),
  putItemIfAbsent: vi.fn(
    async (
      table: string,
      item: Record<string, unknown>,
      keyAttrs: { partitionKey: string; sortKey?: string },
    ) => {
      const pk = item[keyAttrs.partitionKey] as string;
      const composite = k(table, pk);
      if (store.has(composite)) return { outcome: 'skipped' as const };
      store.set(composite, { ...item });
      return { outcome: 'written' as const };
    },
  ),
  queryItems: vi.fn(
    async (
      table: string,
      opts: { expressionAttributeValues: Record<string, unknown> },
    ) => {
      const wanted = opts.expressionAttributeValues[':personId'];
      const prefix = `${table}::`;
      const items: Record<string, unknown>[] = [];
      for (const [key, row] of store.entries()) {
        if (!key.startsWith(prefix)) continue;
        if (row['personId'] !== wanted) continue;
        items.push(row);
      }
      items.sort((a, b) =>
        String(a['verifiedAt']).localeCompare(String(b['verifiedAt'])),
      );
      return { items, lastEvaluatedKey: undefined, count: items.length };
    },
  ),
}));

import { handler as onchainMe } from './onchainMe';
import {
  linkCredentialToPerson,
  resolveOrProvisionPerson,
  updatePersonProfile,
} from '../../lib/identityPerson';

import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';

beforeAll(() => {
  process.env['STAGE'] = 'test';
});

beforeEach(() => {
  store.clear();
});

function buildEvent(authCtx: {
  walletAddress: string;
  personId?: string;
  onChainRoles?: string[];
  tokenSource?: 'legacy' | 'onchain';
}): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    body: undefined,
    headers: {},
    requestContext: {
      http: { method: 'GET' },
      authorizer: {
        lambda: {
          walletAddress: authCtx.walletAddress,
          roles: JSON.stringify(['guest']),
          onChainRoles: JSON.stringify(authCtx.onChainRoles ?? []),
          ...(authCtx.personId ? { personId: authCtx.personId } : {}),
          ...(authCtx.tokenSource ? { tokenSource: authCtx.tokenSource } : {}),
        },
      },
    },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

describe('onchainMe — full aggregation', () => {
  it('returns the person + every linked credential + the role union', async () => {
    // Person seeded as a DRep, plus linked SPO + CC + wallet-stake.
    const seed = await resolveOrProvisionPerson('drep', 'drep1abc', 'login');
    const personId = seed.personId;
    await linkCredentialToPerson({
      credentialType: 'pool',
      credentialId: 'pool1abc',
      personId,
    });
    await linkCredentialToPerson({
      credentialType: 'cc',
      credentialId: 'cc_cold1abc',
      personId,
    });
    await linkCredentialToPerson({
      credentialType: 'stake',
      credentialId: 'stake1abc',
      personId,
    });
    await updatePersonProfile(personId, {
      displayName: 'Alice',
      bio: 'multi-credential operator',
    });

    const result = (await onchainMe(
      buildEvent({
        walletAddress: 'drep1abc',
        personId,
        onChainRoles: ['drep'],
      }),
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(200);
    const json = JSON.parse(result.body) as {
      data: {
        person: { personId: string; displayName?: string; bio?: string };
        credentials: Array<{ identityKey: string; role: string }>;
        onChainRoles: string[];
        currentSession: { identity: string; onChainRoles: string[] };
      };
    };
    expect(json.data.person.personId).toBe(personId);
    expect(json.data.person.displayName).toBe('Alice');
    expect(json.data.person.bio).toBe('multi-credential operator');
    expect(json.data.credentials).toHaveLength(4);

    const keys = json.data.credentials.map((c) => c.identityKey).sort();
    expect(keys).toEqual([
      'cc:cc_cold1abc',
      'drep:drep1abc',
      'pool:pool1abc',
      'stake:stake1abc',
    ]);

    // Role union — every credential type contributes a role.
    const roles = json.data.onChainRoles.sort();
    expect(roles).toEqual(['cc', 'drep', 'proposer', 'spo']);

    // The current session is echoed.
    expect(json.data.currentSession.identity).toBe('drep1abc');
    expect(json.data.currentSession.onChainRoles).toEqual(['drep']);
  });
});

describe('onchainMe — pre-Decision-3 fallback (no personId on the token)', () => {
  it('resolves the person via the carried credential when personId is absent', async () => {
    // Imagine a session minted BEFORE Decision #3: the JWT carries
    // `sub=pool1xyz` + `onChainRoles=['spo']` but no `personId`. The
    // /auth/onchain/me handler must still produce a coherent view.
    const seed = await resolveOrProvisionPerson('pool', 'pool1xyz', 'login');

    const result = (await onchainMe(
      buildEvent({
        walletAddress: 'pool1xyz',
        // personId DELIBERATELY OMITTED — simulates a pre-Decision-3 token.
        onChainRoles: ['spo'],
      }),
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(200);
    const json = JSON.parse(result.body) as {
      data: { person: { personId: string }; onChainRoles: string[] };
    };
    expect(json.data.person.personId).toBe(seed.personId);
    expect(json.data.onChainRoles).toContain('spo');
  });

  it('auto-provisions a fresh person for an unmapped credential (rolling-upgrade safety net)', async () => {
    // No prior person row exists — yet the caller has an on-chain
    // session for `pool1virgin`. Provision on demand so the user is
    // recognised from here on.
    const result = (await onchainMe(
      buildEvent({
        walletAddress: 'pool1virgin',
        onChainRoles: ['spo'],
      }),
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(200);
    const json = JSON.parse(result.body) as {
      data: { person: { personId: string }; credentials: unknown[] };
    };
    expect(typeof json.data.person.personId).toBe('string');
    expect(json.data.credentials).toHaveLength(1);
  });
});

describe('onchainMe — rejects legacy sessions', () => {
  it('returns 401 when the caller has no on-chain roles (legacy CIP-30 session)', async () => {
    const result = (await onchainMe(
      buildEvent({
        walletAddress: 'stake1legacy_wallet_user',
        // No personId, no onChainRoles — pure legacy session.
      }),
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(401);
    const json = JSON.parse(result.body) as { message?: string };
    expect(json.message).toMatch(/on-chain session/i);
  });

  it('S1: returns 401 when tokenSource is legacy (post-S1 authorizer)', async () => {
    // Even if the legacy cookie's JWT happens to carry an on-chain
    // role claim (e.g. a downgraded token replayed against this
    // endpoint), the tokenSource signal blocks it before any binding
    // work proceeds.
    const result = (await onchainMe(
      buildEvent({
        walletAddress: 'stake1legacy_token_source',
        tokenSource: 'legacy',
        // Even with a (fake) on-chain role claim, the legacy source
        // must override and 401.
        onChainRoles: ['drep'],
      }),
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(401);
  });
});
