/**
 * Decision #3 (2026-06-10) — on-chain profile get + update tests.
 *
 * The handlers mirror the legacy `/profile` upsert conventions but
 * key off the session's `personId` (with the same pre-Decision-3
 * fallback as `/auth/onchain/me`). Tests cover happy paths +
 * validation + the unauth gate.
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
  queryItems: vi.fn(async () => ({ items: [], lastEvaluatedKey: undefined, count: 0 })),
}));

import { handler as onchainProfileGet } from './onchainProfileGet';
import { handler as onchainProfileUpdate } from './onchainProfileUpdate';
import {
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

function buildEvent(
  method: 'GET' | 'PUT',
  body: unknown,
  authCtx?: {
    walletAddress: string;
    personId?: string;
    onChainRoles?: string[];
    tokenSource?: 'legacy' | 'onchain';
  },
): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headers: {},
    requestContext: {
      http: { method },
      authorizer: authCtx
        ? {
            lambda: {
              walletAddress: authCtx.walletAddress,
              roles: JSON.stringify(['guest']),
              onChainRoles: JSON.stringify(authCtx.onChainRoles ?? []),
              ...(authCtx.personId ? { personId: authCtx.personId } : {}),
              ...(authCtx.tokenSource ? { tokenSource: authCtx.tokenSource } : {}),
            },
          }
        : {},
    },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

describe('onchainProfileGet', () => {
  it('returns the persons profile fields', async () => {
    const { personId } = await resolveOrProvisionPerson('drep', 'drep1abc', 'login');
    await updatePersonProfile(personId, {
      displayName: 'Alice',
      bio: 'on-chain operator',
    });

    const result = (await onchainProfileGet(
      buildEvent('GET', undefined, {
        walletAddress: 'drep1abc',
        personId,
        onChainRoles: ['drep'],
      }),
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(200);
    const json = JSON.parse(result.body) as {
      data: { personId: string; displayName?: string; bio?: string };
    };
    expect(json.data.personId).toBe(personId);
    expect(json.data.displayName).toBe('Alice');
    expect(json.data.bio).toBe('on-chain operator');
  });

  it('returns 401 for a legacy CIP-30 session', async () => {
    const result = (await onchainProfileGet(
      buildEvent('GET', undefined, {
        walletAddress: 'stake1legacy',
      }),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(401);
  });

  it('S1: rejects when tokenSource is legacy (post-S1 authorizer)', async () => {
    // Even if a legacy cookie somehow carried an on-chain role,
    // tokenSource='legacy' blocks it before reading the personId.
    const result = (await onchainProfileGet(
      buildEvent('GET', undefined, {
        walletAddress: 'stake1legacy_explicit',
        tokenSource: 'legacy',
        onChainRoles: ['drep'],
      }),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(401);
  });
});

describe('onchainProfileUpdate', () => {
  it('updates supplied fields and returns the new row', async () => {
    const { personId } = await resolveOrProvisionPerson('drep', 'drep1abc', 'login');

    const result = (await onchainProfileUpdate(
      buildEvent(
        'PUT',
        { displayName: 'Alice', bio: 'updated bio' },
        { walletAddress: 'drep1abc', personId, onChainRoles: ['drep'] },
      ),
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(200);
    const json = JSON.parse(result.body) as {
      data: { displayName?: string; bio?: string };
    };
    expect(json.data.displayName).toBe('Alice');
    expect(json.data.bio).toBe('updated bio');
  });

  it('rejects an over-long display name', async () => {
    const { personId } = await resolveOrProvisionPerson('drep', 'drep1abc', 'login');

    const result = (await onchainProfileUpdate(
      buildEvent(
        'PUT',
        { displayName: 'a'.repeat(101) },
        { walletAddress: 'drep1abc', personId, onChainRoles: ['drep'] },
      ),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(400);
  });

  it('rejects an empty body', async () => {
    const { personId } = await resolveOrProvisionPerson('drep', 'drep1abc', 'login');

    const result = (await onchainProfileUpdate({
      body: undefined,
      headers: {},
      requestContext: {
        http: { method: 'PUT' },
        authorizer: {
          lambda: {
            walletAddress: 'drep1abc',
            roles: JSON.stringify(['guest']),
            onChainRoles: JSON.stringify(['drep']),
            personId,
          },
        },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer)) as { statusCode: number };
    expect(result.statusCode).toBe(400);
  });

  // ---- S1 (2026-06-10 security review) — reject legacy tokens ----

  it('S1: rejects when tokenSource is legacy', async () => {
    const result = (await onchainProfileUpdate(
      buildEvent(
        'PUT',
        { displayName: 'Whoever' },
        {
          walletAddress: 'stake1legacy_update',
          tokenSource: 'legacy',
          onChainRoles: ['drep'],
        },
      ),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(401);
  });

  // ---- S4 (2026-06-10 security review) — socialLinks validation ----

  it('S4: accepts known social-link keys with short values', async () => {
    const { personId } = await resolveOrProvisionPerson('drep', 'drep1social_ok', 'login');
    const result = (await onchainProfileUpdate(
      buildEvent(
        'PUT',
        {
          socialLinks: {
            twitter: 'https://x.com/alice',
            github: 'alice',
            website: 'https://alice.example',
            discord: 'alice#1234',
          },
        },
        { walletAddress: 'drep1social_ok', personId, onChainRoles: ['drep'] },
      ),
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    const json = JSON.parse(result.body) as {
      data: { socialLinks?: Record<string, string> };
    };
    expect(json.data.socialLinks?.twitter).toBe('https://x.com/alice');
  });

  it('S4: rejects an unknown social-link key', async () => {
    const { personId } = await resolveOrProvisionPerson(
      'drep',
      'drep1social_unknown',
      'login',
    );
    const result = (await onchainProfileUpdate(
      buildEvent(
        'PUT',
        {
          socialLinks: {
            twitter: 'https://x.com/alice',
            mastodon: 'https://mastodon.social/@alice', // not in the allowlist
          },
        },
        { walletAddress: 'drep1social_unknown', personId, onChainRoles: ['drep'] },
      ),
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(400);
    const json = JSON.parse(result.body) as { message?: string };
    expect(json.message).toMatch(/unknown key|allowed/i);
  });

  it('S4: rejects an over-long social-link value (>200 chars)', async () => {
    const { personId } = await resolveOrProvisionPerson(
      'drep',
      'drep1social_long',
      'login',
    );
    const result = (await onchainProfileUpdate(
      buildEvent(
        'PUT',
        {
          socialLinks: {
            twitter: 'a'.repeat(201),
          },
        },
        { walletAddress: 'drep1social_long', personId, onChainRoles: ['drep'] },
      ),
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(400);
    const json = JSON.parse(result.body) as { message?: string };
    expect(json.message).toMatch(/maximum length/i);
  });

  it('S4: rejects a non-string social-link value', async () => {
    const { personId } = await resolveOrProvisionPerson(
      'drep',
      'drep1social_nonstring',
      'login',
    );
    const result = (await onchainProfileUpdate(
      buildEvent(
        'PUT',
        {
          // 42 is not a string — must reject.
          socialLinks: { twitter: 42 },
        },
        { walletAddress: 'drep1social_nonstring', personId, onChainRoles: ['drep'] },
      ),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(400);
  });

  it('S4: rejects an array (defensive — socialLinks must be an object)', async () => {
    const { personId } = await resolveOrProvisionPerson(
      'drep',
      'drep1social_array',
      'login',
    );
    const result = (await onchainProfileUpdate(
      buildEvent(
        'PUT',
        { socialLinks: ['not-an-object'] },
        { walletAddress: 'drep1social_array', personId, onChainRoles: ['drep'] },
      ),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(400);
  });
});
