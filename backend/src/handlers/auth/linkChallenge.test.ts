/**
 * Decision #3 (2026-06-10) — link/challenge handler tests.
 *
 * Confirms the handler issues a stage-bound payload bound to the
 * caller's personId (M1 fix, 2026-06-10 security review), and rejects
 * unauthenticated / legacy-cookie requests. The heavy nonce semantics
 * are tested in `identity/auth/nonce.test.ts`; here we just prove the
 * wiring + auth gate + personId binding.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// In-memory DDB stub keyed by composite `<table>::<pk>` — mirrors the
// linkVerify test's stub so the `getIdentityLink` fallback path the
// challenge handler now exercises has a place to read/write.
const store = new Map<string, Record<string, unknown>>();
function k(table: string, pk: string): string {
  return `${table}::${pk}`;
}

vi.mock('../../lib/dynamodb', () => ({
  tableNames: {
    authNonces: 'test-auth_nonces',
    onchainUsers: 'test-onchain_users',
    identityLinks: 'test-identity_links',
  },
  getItem: vi.fn(async (table: string, key: Record<string, unknown>) => {
    const pk =
      (key['personId'] as string | undefined) ??
      (key['identityKey'] as string | undefined) ??
      (key['nonce'] as string | undefined);
    if (!pk) return undefined;
    return store.get(k(table, pk));
  }),
  putItem: vi.fn(async (table: string, item: Record<string, unknown>) => {
    const pk =
      (item['personId'] as string | undefined) ??
      (item['identityKey'] as string | undefined) ??
      (item['nonce'] as string | undefined);
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
  deleteItem: vi.fn(async (table: string, key: Record<string, unknown>) => {
    const pk = (key['nonce'] as string | undefined) ?? (key['identityKey'] as string | undefined);
    if (!pk) return;
    store.delete(k(table, pk));
  }),
  queryItems: vi.fn(async () => ({ items: [], lastEvaluatedKey: undefined, count: 0 })),
  scanItems: vi.fn(async () => ({ items: [], lastEvaluatedKey: undefined, count: 0 })),
  docClient: {},
}));

import { handler as linkChallenge } from './linkChallenge';
import { resolveOrProvisionPerson } from '../../lib/identityPerson';

import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';

beforeAll(() => {
  process.env['STAGE'] = 'test';
  process.env['ONCHAIN_LOGIN_DOMAIN'] = 'drep.tools';
});

beforeEach(() => {
  store.clear();
});

function buildEvent(authCtx?: {
  walletAddress: string;
  personId?: string;
  onChainRoles?: string[];
}): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    body: undefined,
    headers: {},
    requestContext: {
      http: { method: 'POST' },
      authorizer: authCtx
        ? {
            lambda: {
              walletAddress: authCtx.walletAddress,
              roles: JSON.stringify(['guest']),
              onChainRoles: JSON.stringify(authCtx.onChainRoles ?? []),
              ...(authCtx.personId ? { personId: authCtx.personId } : {}),
            },
          }
        : {},
    },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

describe('linkChallenge', () => {
  it('returns a stage-bound link payload bound to the caller personId', async () => {
    // Auto-provision the caller's person so the handler's fallback
    // resolves to a real personId (mirrors how onchainVerify would
    // have seeded the link row at login time).
    const caller = await resolveOrProvisionPerson('pool', 'pool1caller', 'login');
    const result = (await linkChallenge(
      buildEvent({
        walletAddress: 'pool1caller',
        personId: caller.personId,
        onChainRoles: ['spo'],
      }),
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(200);
    const json = JSON.parse(result.body) as { data: { payload: string } };
    // M1 fix — link payloads use the new `dreptalk-link:<personId>:...`
    // prefix so the personId is bound into the bytes the wallet signs.
    expect(json.data.payload).toMatch(
      new RegExp(`^dreptalk-link:${caller.personId}:test:drep\\.tools:`),
    );
  });

  it('falls back to credential→person resolve for pre-Decision-3 tokens (no personId claim)', async () => {
    // Seed the link so the handler's fallback path resolves to it.
    const caller = await resolveOrProvisionPerson('pool', 'pool1prelegacy', 'login');
    const result = (await linkChallenge(
      buildEvent({
        walletAddress: 'pool1prelegacy',
        onChainRoles: ['spo'],
        // No personId on the JWT — fallback must still bind a personId.
      }),
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    const json = JSON.parse(result.body) as { data: { payload: string } };
    expect(json.data.payload).toMatch(
      new RegExp(`^dreptalk-link:${caller.personId}:test:drep\\.tools:`),
    );
  });

  it('returns 401 when no authorizer context is present', async () => {
    const result = (await linkChallenge(buildEvent())) as { statusCode: number };
    expect(result.statusCode).toBe(401);
  });

  it('S1: rejects a legacy-cookie session (no onChainRoles claim)', async () => {
    // Legacy CIP-30 session — walletAddress set but onChainRoles
    // empty. The handler MUST reject before binding a personId.
    const result = (await linkChallenge(
      buildEvent({ walletAddress: 'stake1legacy_session', onChainRoles: [] }),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(401);
  });
});
