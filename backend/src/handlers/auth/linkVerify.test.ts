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
      if (condition?.includes('attribute_not_exists') && store.has(k(table, pk))) {
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

/**
 * Build a link-flow nonce payload bound to `personId` (M1 security
 * review fix — the link payload format is
 * `dreptalk-link:<personId>:<stage>:<domain>:<nonce>:<issuedAt>`).
 * Stores the payload in the in-memory DDB stub under the nonce PK,
 * matching what the production `linkChallenge` handler would have
 * written.
 */
function makeNoncePayload(personId: string): { payload: string; nonce: string } {
  const nonce = randomBytes(16).toString('base64url');
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = `dreptalk-link:${personId}:${STAGE}:drep.tools:${nonce}:${issuedAt}`;
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
    const { payload } = makeNoncePayload(personId);
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
    const payload = `dreptalk-link:${personId}:${STAGE}:drep.tools:fake_nonce:${issuedAt}`;
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
    const { payload } = makeNoncePayload(personId);
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
    const { payload } = makeNoncePayload(b.personId);
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

    const { payload } = makeNoncePayload(personId);
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

// ---------------------------------------------------------------------------
// M1 (2026-06-10 security review) — pre-registration account hijack defence
//
// An attacker authenticated as person P_A gets a victim (never-logged-in)
// to sign P_A's link challenge. Pre-fix, `linkVerify` would attach the
// victim's credential to P_A. Post-fix, the signed payload carries P_A's
// personId in the bytes the wallet signs; the verify path cross-checks
// that bound personId against the calling session's personId and 4xx
// when they differ. The victim's wallet now signs bytes uniquely tied to
// the attacker's account, and the server rejects the cross-account
// attempt at the bind check.
// ---------------------------------------------------------------------------

describe('linkVerify — M1: rejects a link payload bound to a different personId', () => {
  it('rejects a link payload bound to personId A presented in a session for person B', async () => {
    // Person A — the attacker's account. Bound the link challenge to A.
    const a = await resolveOrProvisionPerson('pool', 'pool1A_attacker', 'login');
    // Person B — the victim. Logs in for the FIRST time, sees the
    // attacker-supplied link challenge in their wallet, signs it.
    const b = await resolveOrProvisionPerson('pool', 'pool1B_victim', 'login');
    expect(a.personId).not.toBe(b.personId);

    // Build a link payload bound to A's personId — what the attacker
    // crafted server-side. Pre-fix, the verify side ignored the bound
    // context and would have written `cc:<victim_cred> → A.personId`.
    const { payload } = makeNoncePayload(a.personId);
    const { publicKeyHex, signatureHex, pubKey } = rawSign(payload);
    const { ccHotKeyHashHex } = await import('../../lib/identity/cardano/identity');
    const hotHex = ccHotKeyHashHex(pubKey);
    const VICTIM_COLD = 'cc_cold1victim_unlinked';
    fakeKoios.committeeInfo.mockResolvedValueOnce([
      {
        status: 'authorized',
        cc_hot_id: 'cc_hot1victim',
        cc_cold_id: VICTIM_COLD,
        cc_hot_hex: hotHex,
        cc_cold_hex: null,
        expiration_epoch: null,
        cc_hot_has_script: false,
        cc_cold_has_script: false,
      },
    ]);

    // The victim is signed in as B (their own personId) and submits
    // the attacker-bound link challenge — the verify path must reject
    // because the payload's bound personId is A but the calling
    // session is B.
    const result = (await linkVerify(
      buildEvent(
        { payload, signatureHex, publicKeyHex, role: 'cc' },
        { walletAddress: 'pool1B_victim', personId: b.personId, onChainRoles: ['spo'] },
      ),
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(401);
    // The victim's cc credential MUST NOT have been linked to person A.
    const link = await getIdentityLink(identityKeyFor('cc', VICTIM_COLD));
    expect(link).toBeUndefined();
  });

  it('accepts a link payload bound to the calling person (M1 happy path)', async () => {
    // The mirror of the above — same flow but the payload's bound
    // personId == the calling session's personId. The verify path
    // must accept and write the link, proving the cross-check is
    // surgical (not a blanket reject).
    const caller = await resolveOrProvisionPerson('pool', 'pool1self_bind', 'login');
    const { payload } = makeNoncePayload(caller.personId);
    const { publicKeyHex, signatureHex, pubKey } = rawSign(payload);
    const { ccHotKeyHashHex } = await import('../../lib/identity/cardano/identity');
    const hotHex = ccHotKeyHashHex(pubKey);
    const COLD_ID = 'cc_cold1self_bind';
    fakeKoios.committeeInfo.mockResolvedValueOnce([
      {
        status: 'authorized',
        cc_hot_id: 'cc_hot1self_bind',
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
        { payload, signatureHex, publicKeyHex, role: 'cc' },
        {
          walletAddress: 'pool1self_bind',
          personId: caller.personId,
          onChainRoles: ['spo'],
        },
      ),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(200);
    const link = await getIdentityLink(identityKeyFor('cc', COLD_ID));
    expect(link?.personId).toBe(caller.personId);
  });
});

// ---------------------------------------------------------------------------
// S1 (2026-06-10 security review) — reject legacy-cookie session
//
// A request authenticated via the legacy CIP-30 cookie (empty
// `onChainRoles`) hitting /auth/onchain/link/verify MUST be rejected.
// Pre-fix, the handler fell back to deriving an on-chain identity from
// the stake `sub` and could write a link row attributed to a legacy
// caller. Post-fix the handler 4xx on missing/empty onChainRoles.
// ---------------------------------------------------------------------------

describe('linkVerify — S1: rejects legacy-cookie session', () => {
  it('rejects a request with empty onChainRoles (legacy CIP-30 session)', async () => {
    // No setup needed — the rejection MUST happen before any nonce
    // lookup or signature work. We just need a valid-shaped body.
    const payload = `dreptalk-link:01HSOMEPERSON:${STAGE}:drep.tools:fakenonce:${Math.floor(Date.now() / 1000)}`;
    const { publicKeyHex, signatureHex } = rawSign(payload);
    const result = (await linkVerify(
      buildEvent(
        { payload, signatureHex, publicKeyHex, role: 'spo' },
        // Legacy session — walletAddress set, NO onChainRoles.
        { walletAddress: 'stake1legacy_caller', onChainRoles: [] },
      ),
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(401);
    // Pre-fix this would have proceeded into the nonce/sig path.
    expect(fakeKoios.poolCalidusKey).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// S2 (2026-06-10 security review) — a bad signature does NOT burn the nonce
//
// The link verify path now uses `consumeNonceWithCheck` (peek → run
// signature+role check → delete only on success). A bad signature must
// NOT burn the nonce: a subsequent legit attempt with the same nonce
// must still work.
// ---------------------------------------------------------------------------

describe('linkVerify — S2: bad signature does not burn the nonce', () => {
  it('a forged-signature attempt followed by a valid attempt on the SAME nonce still succeeds', async () => {
    const caller = await resolveOrProvisionPerson('pool', 'pool1burn_defense', 'login');
    const { payload } = makeNoncePayload(caller.personId);
    // Legit signer for the eventual success.
    const legit = rawSign(payload);
    // Attacker tries a forged signature — sig from key A, key from B.
    const attackerSig = rawSign(payload).signatureHex;
    const wrongKey = rawSign(payload).publicKeyHex;

    // Build a roster Koios would return for the legit key.
    const { ccHotKeyHashHex } = await import('../../lib/identity/cardano/identity');
    const hotHex = ccHotKeyHashHex(legit.pubKey);
    const COLD = 'cc_cold1burn';
    const member = {
      status: 'authorized',
      cc_hot_id: 'cc_hot1burn',
      cc_cold_id: COLD,
      cc_hot_hex: hotHex,
      cc_cold_hex: null,
      expiration_epoch: null,
      cc_hot_has_script: false,
      cc_cold_has_script: false,
    };
    // First call (the forged one) — Koios is never reached past the
    // sig check; this mock is defensive in case it ever is.
    fakeKoios.committeeInfo.mockResolvedValue([member]);

    // Attempt #1 — forged signature, MUST fail with 401.
    const bad = (await linkVerify(
      buildEvent(
        {
          payload,
          signatureHex: attackerSig,
          publicKeyHex: wrongKey,
          role: 'cc',
        },
        {
          walletAddress: 'pool1burn_defense',
          personId: caller.personId,
          onChainRoles: ['spo'],
        },
      ),
    )) as { statusCode: number };
    expect(bad.statusCode).toBe(401);

    // Attempt #2 — same nonce, legit signature. Pre-fix the nonce was
    // burned on attempt #1; post-fix it survived and #2 succeeds.
    const good = (await linkVerify(
      buildEvent(
        {
          payload,
          signatureHex: legit.signatureHex,
          publicKeyHex: legit.publicKeyHex,
          role: 'cc',
        },
        {
          walletAddress: 'pool1burn_defense',
          personId: caller.personId,
          onChainRoles: ['spo'],
        },
      ),
    )) as { statusCode: number };
    expect(good.statusCode).toBe(200);
  });
});
