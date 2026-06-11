/**
 * Decision #3 (2026-06-10) — link/verify handler tests.
 *
 * Proves the "no merge" safety contract end-to-end:
 *
 *   - A successful link with a valid signature maps the new
 *     credential to the CALLER's existing personId.
 *   - A bad/absent signature is rejected with 401.
 *   - A credential ALREADY mapped to a DIFFERENT person yields 409,
 *     no merge.
 *
 * Mocks the DDB layer + the Koios adapter so the cryptography itself
 * (verifyEd25519 / verifyCip8) runs for real but the role resolution
 * is controlled.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { generateKeyPairSync, sign as nodeSign, randomBytes } from 'node:crypto';

// In-memory DDB stub — same shared-store pattern as onchainVerify's
// test (one Map keyed by composite `<table>::<pk>`). Keeps mock
// fidelity high without dragging in a real DDB.
const store = new Map<string, Record<string, unknown>>();
function k(table: string, pk: string): string {
  return `${table}::${pk}`;
}

vi.mock('../../lib/dynamodb', () => ({
  tableNames: {
    authNonces: 'test-auth_nonces',
    users: 'test-users',
    identitySessions: 'test-identity_sessions',
    onchainUsers: 'test-onchain_users',
    identityLinks: 'test-identity_links',
  },
  getItem: vi.fn(async (table: string, key: Record<string, unknown>) => {
    const pk =
      (key['personId'] as string | undefined) ??
      (key['identityKey'] as string | undefined) ??
      (key['nonce'] as string | undefined) ??
      (key['sessionKey'] as string | undefined);
    if (!pk) return undefined;
    return store.get(k(table, pk));
  }),
  putItem: vi.fn(
    async (
      table: string,
      item: Record<string, unknown>,
      condition?: string,
    ) => {
      const pk =
        (item['personId'] as string | undefined) ??
        (item['identityKey'] as string | undefined) ??
        (item['nonce'] as string | undefined) ??
        (item['sessionKey'] as string | undefined);
      if (!pk) throw new Error('mock putItem: no recognised PK');
      if (condition && condition.includes('attribute_not_exists') && store.has(k(table, pk))) {
        const err = new Error('ConditionalCheckFailedException');
        err.name = 'ConditionalCheckFailedException';
        throw err;
      }
      store.set(k(table, pk), { ...item });
    },
  ),
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
    const pk =
      (key['nonce'] as string | undefined) ??
      (key['sessionKey'] as string | undefined) ??
      (key['identityKey'] as string | undefined) ??
      (key['personId'] as string | undefined);
    if (!pk) return;
    store.delete(k(table, pk));
  }),
  updateItem: vi.fn(async () => undefined),
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
      return { items, lastEvaluatedKey: undefined, count: items.length };
    },
  ),
  scanItems: vi.fn(async () => ({ items: [], lastEvaluatedKey: undefined, count: 0 })),
  docClient: {},
}));

// Koios adapter mock — same shape as onchainVerify's test.
type FakeKoiosClient = {
  drepInfo: ReturnType<typeof vi.fn>;
  proposalsByReturnAddress: ReturnType<typeof vi.fn>;
  poolCalidusKey: ReturnType<typeof vi.fn>;
  committeeInfo: ReturnType<typeof vi.fn>;
};
const fakeKoios: FakeKoiosClient = {
  drepInfo: vi.fn(async () => null),
  proposalsByReturnAddress: vi.fn(async () => []),
  poolCalidusKey: vi.fn(async () => null),
  committeeInfo: vi.fn(async () => []),
};
vi.mock('../../lib/identity/auth/koiosAdapter', () => ({
  buildKoiosAdapter: () => fakeKoios,
}));

// Import AFTER the mocks so the handler picks up our stubs.
import { handler as linkVerify } from './linkVerify';
import {
  identityKeyFor,
  resolveOrProvisionPerson,
  getIdentityLink,
} from '../../lib/identityPerson';
import { bytesToHex } from '../../lib/identity/crypto/hex';

import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';

const STAGE = 'test';

beforeAll(() => {
  process.env['STAGE'] = STAGE;
  process.env['CARDANO_NETWORK'] = 'mainnet';
  process.env['ONCHAIN_LOGIN_DOMAIN'] = 'drep.tools';
});

beforeEach(() => {
  store.clear();
  fakeKoios.drepInfo.mockReset();
  fakeKoios.proposalsByReturnAddress.mockReset();
  fakeKoios.poolCalidusKey.mockReset();
  fakeKoios.committeeInfo.mockReset();
  fakeKoios.drepInfo.mockResolvedValue(null);
  fakeKoios.proposalsByReturnAddress.mockResolvedValue([]);
  fakeKoios.poolCalidusKey.mockResolvedValue(null);
  fakeKoios.committeeInfo.mockResolvedValue([]);
});

// ---- Helpers ----

function rawSign(payload: string): {
  publicKeyHex: string;
  signatureHex: string;
  pubKey: Uint8Array;
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const ED25519_SPKI_HEADER_LEN = 12;
  const pubKey = new Uint8Array(spki.subarray(ED25519_SPKI_HEADER_LEN));
  const sig = new Uint8Array(nodeSign(null, Buffer.from(payload, 'utf8'), privateKey));
  return {
    publicKeyHex: bytesToHex(pubKey),
    signatureHex: bytesToHex(sig),
    pubKey,
  };
}

function makeNoncePayload(): { payload: string; nonce: string } {
  const nonce = randomBytes(16).toString('base64url');
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = `dreptalk:${STAGE}:drep.tools:${nonce}:${issuedAt}`;
  store.set(k('test-auth_nonces', nonce), {
    nonce,
    kind: 'identity',
    payload,
    expiresAt: issuedAt + 300,
  });
  return { payload, nonce };
}

/** Build an authorizer event with the supplied auth context. */
function buildEvent(
  body: unknown,
  authCtx: {
    walletAddress: string;
    personId?: string;
    onChainRoles?: string[];
  },
): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    body: JSON.stringify(body),
    headers: {},
    requestContext: {
      http: { method: 'POST' },
      authorizer: {
        lambda: {
          walletAddress: authCtx.walletAddress,
          roles: JSON.stringify(['guest']),
          onChainRoles: JSON.stringify(authCtx.onChainRoles ?? []),
          ...(authCtx.personId ? { personId: authCtx.personId } : {}),
        },
      },
    },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

// ---------------------------------------------------------------------------
// Happy path — caller signs in as SPO, links a CC credential
// ---------------------------------------------------------------------------

describe('linkVerify — happy path (SPO links a CC credential)', () => {
  it('maps the new CC credential to the caller existing personId', async () => {
    // Caller is already signed in as an SPO — auto-provision their
    // person + link directly in the store (mirrors what onchainVerify
    // would have done on login).
    const callerPool = 'pool1caller_spo';
    const seed = await resolveOrProvisionPerson('pool', callerPool, 'login');
    const personId = seed.personId;

    // The caller now signs the link challenge with a CC hot key.
    const { payload } = makeNoncePayload();
    const { publicKeyHex, signatureHex, pubKey } = rawSign(payload);

    // Compute the cc_hot_hex Koios would have for this key.
    const { ccHotKeyHashHex } = await import('../../lib/identity/cardano/identity');
    const hotHex = ccHotKeyHashHex(pubKey);
    const COLD_ID = 'cc_cold1linked';
    fakeKoios.committeeInfo.mockResolvedValueOnce([
      {
        status: 'authorized',
        cc_hot_id: 'cc_hot1linked',
        cc_cold_id: COLD_ID,
        cc_hot_hex: hotHex,
        cc_cold_hex: null,
        expiration_epoch: null,
        cc_hot_has_script: false,
        cc_cold_has_script: false,
      },
    ]);

    const result = (await linkVerify(
      buildEvent(
        {
          payload,
          signatureHex,
          publicKeyHex,
          role: 'cc',
        },
        {
          walletAddress: callerPool,
          personId,
          onChainRoles: ['spo'],
        },
      ),
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(200);
    const json = JSON.parse(result.body) as {
      data: {
        personId: string;
        linked: { credentialType: string; credentialId: string };
        alreadyLinked: boolean;
      };
    };
    expect(json.data.personId).toBe(personId);
    expect(json.data.linked.credentialType).toBe('cc');
    expect(json.data.linked.credentialId).toBe(COLD_ID);
    expect(json.data.alreadyLinked).toBe(false);

    // Verify the link row was written and points at the caller person.
    const link = await getIdentityLink(identityKeyFor('cc', COLD_ID));
    expect(link?.personId).toBe(personId);
    expect(link?.verifiedVia).toBe('link');
  });
});

// ---------------------------------------------------------------------------
// Bad / absent signature — REJECT (load-bearing security check)
// ---------------------------------------------------------------------------

describe('linkVerify — rejects bad/absent signatures', () => {
  it('rejects when the nonce is unknown (replay defence)', async () => {
    const { personId } = await resolveOrProvisionPerson('pool', 'pool1caller', 'login');
    // Build a payload but do NOT store it — simulates an attacker
    // reusing a nonce that was already consumed.
    const issuedAt = Math.floor(Date.now() / 1000);
    const payload = `dreptalk:${STAGE}:drep.tools:fake_nonce:${issuedAt}`;
    const { publicKeyHex, signatureHex } = rawSign(payload);

    const result = (await linkVerify(
      buildEvent(
        { payload, signatureHex, publicKeyHex, role: 'spo' },
        { walletAddress: 'pool1caller', personId, onChainRoles: ['spo'] },
      ),
    )) as { statusCode: number };

    expect(result.statusCode).toBe(401);
    // The signature was never even consulted past the nonce check.
    expect(fakeKoios.poolCalidusKey).not.toHaveBeenCalled();
  });

  it('rejects when the signature is forged (signed by a different key)', async () => {
    const { personId } = await resolveOrProvisionPerson('pool', 'pool1caller', 'login');
    const { payload } = makeNoncePayload();
    // Sign the payload with key A; submit key B's pubkey.
    const a = rawSign(payload);
    const b = rawSign(payload);

    const result = (await linkVerify(
      buildEvent(
        {
          payload,
          signatureHex: a.signatureHex, // signature from A
          publicKeyHex: b.publicKeyHex, // claimed pubkey from B
          role: 'spo',
        },
        { walletAddress: 'pool1caller', personId, onChainRoles: ['spo'] },
      ),
    )) as { statusCode: number };

    expect(result.statusCode).toBe(401);
    expect(fakeKoios.poolCalidusKey).not.toHaveBeenCalled();
  });

  it('rejects when the request body is missing required fields', async () => {
    const { personId } = await resolveOrProvisionPerson('pool', 'pool1caller', 'login');
    const result = (await linkVerify(
      buildEvent(
        { payload: '', signatureHex: '', role: '' },
        { walletAddress: 'pool1caller', personId, onChainRoles: ['spo'] },
      ),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// SAFETY — credential already linked to another person => 409, NO MERGE
// ---------------------------------------------------------------------------

describe('linkVerify — refuses to merge two persons (the safety contract)', () => {
  it('returns 409 when the new credential is already linked to a DIFFERENT person', async () => {
    // Person A — already exists, owns SPO `pool1A`.
    const a = await resolveOrProvisionPerson('pool', 'pool1A', 'login');

    // Person B — also exists, owns SPO `pool1B`.
    const b = await resolveOrProvisionPerson('pool', 'pool1B', 'login');
    expect(a.personId).not.toBe(b.personId);

    // Person A also owns a CC credential — pre-claim the cc_cold for them.
    const CONFLICT_COLD = 'cc_cold1conflict';
    const { linkCredentialToPerson } = await import('../../lib/identityPerson');
    await linkCredentialToPerson({
      credentialType: 'cc',
      credentialId: CONFLICT_COLD,
      personId: a.personId,
    });

    // Person B tries to link the SAME CC credential by signing fresh
    // — Koios will resolve to the same CONFLICT_COLD and the link
    // would silently merge B into A. The handler MUST refuse.
    const { payload } = makeNoncePayload();
    const { publicKeyHex, signatureHex, pubKey } = rawSign(payload);
    const { ccHotKeyHashHex } = await import('../../lib/identity/cardano/identity');
    const hotHex = ccHotKeyHashHex(pubKey);
    fakeKoios.committeeInfo.mockResolvedValueOnce([
      {
        status: 'authorized',
        cc_hot_id: 'cc_hot1conflict',
        cc_cold_id: CONFLICT_COLD,
        cc_hot_hex: hotHex,
        cc_cold_hex: null,
        expiration_epoch: null,
        cc_hot_has_script: false,
        cc_cold_has_script: false,
      },
    ]);

    const result = (await linkVerify(
      buildEvent(
        { payload, signatureHex, publicKeyHex, role: 'cc' },
        { walletAddress: 'pool1B', personId: b.personId, onChainRoles: ['spo'] },
      ),
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(409);
    const json = JSON.parse(result.body) as { message?: string };
    expect(json.message).toMatch(/already linked/i);

    // Person A's mapping is preserved unchanged.
    const link = await getIdentityLink(identityKeyFor('cc', CONFLICT_COLD));
    expect(link?.personId).toBe(a.personId);
  });

  it('returns 200 (idempotent) when relinking the SAME credential to the SAME person', async () => {
    const { personId } = await resolveOrProvisionPerson('pool', 'pool1caller', 'login');
    const COLD = 'cc_cold1same_person';
    const { linkCredentialToPerson } = await import('../../lib/identityPerson');
    await linkCredentialToPerson({
      credentialType: 'cc',
      credentialId: COLD,
      personId,
    });

    const { payload } = makeNoncePayload();
    const { publicKeyHex, signatureHex, pubKey } = rawSign(payload);
    const { ccHotKeyHashHex } = await import('../../lib/identity/cardano/identity');
    const hotHex = ccHotKeyHashHex(pubKey);
    fakeKoios.committeeInfo.mockResolvedValueOnce([
      {
        status: 'authorized',
        cc_hot_id: 'cc_hot1same',
        cc_cold_id: COLD,
        cc_hot_hex: hotHex,
        cc_cold_hex: null,
        expiration_epoch: null,
        cc_hot_has_script: false,
        cc_cold_has_script: false,
      },
    ]);

    const result = (await linkVerify(
      buildEvent(
        { payload, signatureHex, publicKeyHex, role: 'cc' },
        { walletAddress: 'pool1caller', personId, onChainRoles: ['spo'] },
      ),
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(200);
    const json = JSON.parse(result.body) as { data: { alreadyLinked: boolean } };
    expect(json.data.alreadyLinked).toBe(true);
  });
});
