/**
 * Decision #3 (2026-06-10) — link/challenge handler tests.
 *
 * Minimal — confirms the handler issues a stage-bound payload and
 * rejects an unauthenticated request. The heavy nonce semantics are
 * tested in `identity/auth/nonce.test.ts`; here we just prove the
 * wiring + auth gate.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const store = new Map<string, Record<string, unknown>>();

vi.mock('../../lib/dynamodb', () => ({
  tableNames: {
    authNonces: 'test-auth_nonces',
  },
  getItem: vi.fn(async (_table: string, key: Record<string, unknown>) => {
    return store.get(key['nonce'] as string);
  }),
  putItem: vi.fn(async (_table: string, item: Record<string, unknown>) => {
    store.set(item['nonce'] as string, { ...item });
  }),
  deleteItem: vi.fn(async (_table: string, key: Record<string, unknown>) => {
    store.delete(key['nonce'] as string);
  }),
  docClient: {},
}));

import { handler as linkChallenge } from './linkChallenge';

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
            },
          }
        : {},
    },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

describe('linkChallenge', () => {
  it('returns a stage-bound payload for an authenticated caller', async () => {
    const result = (await linkChallenge(
      buildEvent({ walletAddress: 'pool1caller', onChainRoles: ['spo'] }),
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(200);
    const json = JSON.parse(result.body) as { data: { payload: string } };
    expect(json.data.payload).toMatch(/^dreptalk:test:drep\.tools:/);
  });

  it('returns 401 when no authorizer context is present', async () => {
    const result = (await linkChallenge(buildEvent())) as { statusCode: number };
    expect(result.statusCode).toBe(401);
  });
});
