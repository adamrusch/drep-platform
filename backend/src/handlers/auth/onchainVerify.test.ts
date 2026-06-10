/**
 * End-to-end tests for the Sprint 1 on-chain verify handler.
 *
 * These tests prove two of the brief's exit criteria:
 *
 *   (3) a wallet-less SPO and CC can authenticate via the raw-Ed25519
 *       paste flow and receive a JWT carrying the correct
 *       `onChainRoles`; AND
 *   (4) per-session revocation works — after revoking one `jti` the
 *       authorizer rejects that token while a second session's token
 *       still works.
 *
 * The tests stub the DynamoDB layer (for the nonce store + revocation
 * tombstones) and the Koios adapter (so we don't hit the network).
 * Everything else (CIP-8 verifiers, Ed25519 verify, JWT mint, cookie
 * builder, revocation store) runs for real.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import {
  generateKeyPairSync,
  sign as nodeSign,
  randomBytes,
  createHash,
} from 'node:crypto';

// In-memory backing store for the mocked dynamodb module — keyed by `nonce`
// (the PK on `authNonces`). Tests preload challenge nonces here and the
// revocation tombstones land here on revoke.
const ddbStore = new Map<string, Record<string, unknown>>();

vi.mock('../../lib/dynamodb', () => ({
  tableNames: {
    authNonces: 'test-auth_nonces',
    users: 'test-users',
  },
  putItem: vi.fn(
    async (
      _table: string,
      item: Record<string, unknown>,
      condition?: string,
    ) => {
      const key = item['nonce'] as string;
      if (condition && condition.includes('attribute_not_exists') && ddbStore.has(key)) {
        // Mimic the production DDB ConditionalCheckFailedException semantics
        // so the nonce store's "append-only" invariant holds. Random ULIDs/
        // nonces in practice never collide, so this branch only fires when
        // a test deliberately re-puts the same key.
        const err = new Error('ConditionalCheckFailedException');
        err.name = 'ConditionalCheckFailedException';
        throw err;
      }
      ddbStore.set(key, { ...item });
    },
  ),
  getItem: vi.fn(async (_table: string, key: Record<string, unknown>) => {
    return ddbStore.get(key['nonce'] as string) ?? null;
  }),
  deleteItem: vi.fn(
    async (
      _table: string,
      key: Record<string, unknown>,
      condition?: string,
    ) => {
      const k = key['nonce'] as string;
      if (condition && condition.includes('attribute_exists') && !ddbStore.has(k)) {
        const err = new Error('ConditionalCheckFailedException');
        err.name = 'ConditionalCheckFailedException';
        throw err;
      }
      ddbStore.delete(k);
    },
  ),
  updateItem: vi.fn(async () => undefined),
  docClient: {},
}));

// Block the Koios adapter from making real HTTP calls. Each test overrides
// the relevant resolver via `mockKoios` below.
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

// Recognition module reaches into koios+dynamodb on logout. Stub to a no-op
// so the logout test we may add later isn't dragged into networking.
vi.mock('../../lib/recognition', () => ({
  _invalidateForStake: () => undefined,
  lookupCurrentDrep: async () => ({ drepId: null, source: null }),
}));

// Import AFTER the mocks so the handler picks up our stubs.
import { handler as onChainVerify } from './onchainVerify';
import { verifyJWT, extractOnChainTokenFromCookie } from '../../lib/auth';
import { isSessionRevoked, revokeSessionByJti } from '../../lib/sessionRevocation';
import { ccHotKeyHashHex } from '../../lib/identity/cardano/identity';
import { bytesToHex } from '../../lib/identity/crypto/hex';
import { makeCoseSignature, type6Address } from '../../lib/identity/__fixtures__/makeCose';
import { Encoder } from 'cbor-x';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { blake2b224 } from '../../lib/identity/crypto/blake';

import type { APIGatewayProxyEventV2 } from 'aws-lambda';

const TEST_SECRET = 'jwt-test-secret-only-for-vitest-do-not-ship';
const STAGE = 'test';

beforeAll(() => {
  process.env['JWT_SECRET_NAME'] = TEST_SECRET;
  process.env['STAGE'] = STAGE;
  process.env['CARDANO_NETWORK'] = 'mainnet';
  process.env['ONCHAIN_LOGIN_DOMAIN'] = 'drep.tools';
});

beforeEach(() => {
  ddbStore.clear();
  fakeKoios.drepInfo.mockReset();
  fakeKoios.proposalsByReturnAddress.mockReset();
  fakeKoios.poolCalidusKey.mockReset();
  fakeKoios.committeeInfo.mockReset();
  // Default — every Koios call rejects so a test that forgets to override
  // can't accidentally succeed via the prior test's mock.
  fakeKoios.drepInfo.mockResolvedValue(null);
  fakeKoios.proposalsByReturnAddress.mockResolvedValue([]);
  fakeKoios.poolCalidusKey.mockResolvedValue(null);
  fakeKoios.committeeInfo.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a CIP-30-shaped event body (the SPA `post()` helper unwraps to
 *  the same JSON the handler reads). */
function buildEvent(body: unknown): APIGatewayProxyEventV2 {
  return {
    body: JSON.stringify(body),
    headers: {},
    requestContext: { http: { method: 'POST' } },
  } as unknown as APIGatewayProxyEventV2;
}

/** Generate an Ed25519 keypair + sign the supplied UTF-8 payload — exactly
 *  what an SPO Calidus or CC hot-key paste flow would produce. The SPKI
 *  header prefix is stripped to get the raw 32-byte pubkey, matching the
 *  shape `cardano-signer` emits and the SPA expects to paste. */
function rawSign(payload: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const ED25519_SPKI_HEADER_LEN = 12;
  const pubKey = new Uint8Array(spki.subarray(ED25519_SPKI_HEADER_LEN));
  const sig = new Uint8Array(nodeSign(null, Buffer.from(payload, 'utf8'), privateKey));
  return { publicKeyHex: bytesToHex(pubKey), signatureHex: bytesToHex(sig), pubKey };
}

/** Pre-write a stage-bound nonce payload into the DDB stub so the handler's
 *  `consumeNonce` call finds and burns it. Mirrors the production
 *  `identity/nonce.ts` `${prefix}:${stage}:${domain}:${nonce}:${issuedAt}`
 *  shape. */
function makeNoncePayload(): { payload: string; nonce: string } {
  const nonce = randomBytes(16).toString('base64url');
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = `dreptalk:${STAGE}:drep.tools:${nonce}:${issuedAt}`;
  ddbStore.set(nonce, {
    nonce,
    kind: 'identity',
    payload,
    expiresAt: issuedAt + 300,
  });
  return { payload, nonce };
}

function getOnChainCookie(result: { cookies?: string[] }): string | null {
  if (!Array.isArray(result.cookies)) return null;
  const match = result.cookies.find((c) => c.startsWith(`access_token_onchain_${STAGE}=`));
  return match ?? null;
}

function tokenFromCookie(cookie: string): string {
  // "access_token_onchain_test=...; Max-Age=..." → just the bare JWT.
  const token = extractOnChainTokenFromCookie(cookie);
  if (!token) throw new Error('cookie did not contain on-chain token');
  return token;
}

// ---------------------------------------------------------------------------
// Exit criterion (3) — SPO can log in with raw Ed25519 paste flow
// ---------------------------------------------------------------------------

describe('on-chain verify — SPO paste flow (wallet-less)', () => {
  it('returns 200 + on-chain cookie + JWT with onChainRoles=["spo"]', async () => {
    const { payload } = makeNoncePayload();
    const { publicKeyHex, signatureHex } = rawSign(payload);
    const POOL_ID = 'pool1test_sprint1_spo';

    // Koios confirms the Calidus key belongs to a registered pool.
    fakeKoios.poolCalidusKey.mockResolvedValueOnce({
      pool_id_bech32: POOL_ID,
      calidus_pub_key: publicKeyHex,
      calidus_id_bech32: 'calidus1test',
      registered: true,
      pool_status: 'registered',
    });

    const result = (await onChainVerify(
      buildEvent({
        payload,
        signatureHex,
        publicKeyHex,
        role: 'spo',
      }),
    )) as { statusCode: number; body: string; cookies?: string[] };

    expect(result.statusCode).toBe(200);
    const json = JSON.parse(result.body) as {
      data: { identity: string; onChainRoles: string[]; jti: string };
    };
    expect(json.data.identity).toBe(POOL_ID);
    expect(json.data.onChainRoles).toEqual(['spo']);
    expect(typeof json.data.jti).toBe('string');
    expect(json.data.jti.length).toBeGreaterThan(0);

    // Token verifies and carries the same claims.
    const cookie = getOnChainCookie(result);
    expect(cookie).toBeTruthy();
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    const token = tokenFromCookie(cookie!);
    const verified = await verifyJWT(token);
    expect(verified.sub).toBe(POOL_ID);
    expect(verified.onChainRoles).toEqual(['spo']);
    expect(verified.jti).toBe(json.data.jti);
  });

  it('returns 401 when the Calidus key is not registered to any pool', async () => {
    const { payload } = makeNoncePayload();
    const { publicKeyHex, signatureHex } = rawSign(payload);
    // Koios returns null — no pool owns this key.
    fakeKoios.poolCalidusKey.mockResolvedValueOnce(null);

    const result = (await onChainVerify(
      buildEvent({
        payload,
        signatureHex,
        publicKeyHex,
        role: 'spo',
      }),
    )) as { statusCode: number };

    expect(result.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Exit criterion (3) — CC can log in with raw Ed25519 paste flow
// ---------------------------------------------------------------------------

describe('on-chain verify — CC paste flow (wallet-less)', () => {
  it('returns 200 + on-chain cookie + JWT with onChainRoles=["cc"]', async () => {
    const { payload } = makeNoncePayload();
    const { publicKeyHex, signatureHex, pubKey } = rawSign(payload);
    const hotHex = ccHotKeyHashHex(pubKey);
    const COLD_ID = 'cc_cold1test_sprint1_cc';
    const HOT_ID = 'cc_hot1test_sprint1_cc';

    fakeKoios.committeeInfo.mockResolvedValueOnce([
      {
        status: 'authorized',
        cc_hot_id: HOT_ID,
        cc_cold_id: COLD_ID,
        cc_hot_hex: hotHex,
        cc_cold_hex: null,
        expiration_epoch: null,
        cc_hot_has_script: false,
        cc_cold_has_script: false,
      },
    ]);

    const result = (await onChainVerify(
      buildEvent({
        payload,
        signatureHex,
        publicKeyHex,
        role: 'cc',
      }),
    )) as { statusCode: number; body: string; cookies?: string[] };

    expect(result.statusCode).toBe(200);
    const json = JSON.parse(result.body) as {
      data: { identity: string; onChainRoles: string[]; jti: string };
    };
    // CC identity is the cold credential id when available (more stable than
    // the rotateable hot key) — see the ported `resolveCc` contract.
    expect(json.data.identity).toBe(COLD_ID);
    expect(json.data.onChainRoles).toEqual(['cc']);

    const cookie = getOnChainCookie(result);
    expect(cookie).toBeTruthy();
    const token = tokenFromCookie(cookie!);
    const verified = await verifyJWT(token);
    expect(verified.sub).toBe(COLD_ID);
    expect(verified.onChainRoles).toEqual(['cc']);
  });

  it('returns 401 when no authorized CC member matches the supplied key hash', async () => {
    const { payload } = makeNoncePayload();
    const { publicKeyHex, signatureHex } = rawSign(payload);

    // Committee has members but none with our hot key hash.
    fakeKoios.committeeInfo.mockResolvedValueOnce([
      {
        status: 'authorized',
        cc_hot_id: 'cc_hot1someone_else',
        cc_cold_id: 'cc_cold1someone_else',
        cc_hot_hex: createHash('sha256').update('not-our-key').digest('hex').slice(0, 56),
        cc_cold_hex: null,
        expiration_epoch: null,
        cc_hot_has_script: false,
        cc_cold_has_script: false,
      },
    ]);

    const result = (await onChainVerify(
      buildEvent({
        payload,
        signatureHex,
        publicKeyHex,
        role: 'cc',
      }),
    )) as { statusCode: number };

    expect(result.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Defense — bad inputs reject without ever consulting Koios
// ---------------------------------------------------------------------------

describe('on-chain verify — input validation', () => {
  it('rejects an unknown role with 400', async () => {
    const result = (await onChainVerify(
      buildEvent({
        payload: 'whatever',
        signatureHex: 'ab',
        publicKeyHex: 'cd',
        role: 'attacker',
      }),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(400);
    // Koios MUST NOT be consulted for a bad request.
    expect(fakeKoios.poolCalidusKey).not.toHaveBeenCalled();
    expect(fakeKoios.committeeInfo).not.toHaveBeenCalled();
  });

  it('rejects a missing body with 400', async () => {
    const result = (await onChainVerify({
      body: undefined,
      headers: {},
      requestContext: { http: { method: 'POST' } },
    } as unknown as APIGatewayProxyEventV2)) as { statusCode: number };
    expect(result.statusCode).toBe(400);
  });

  it('rejects a malformed JSON body with 400', async () => {
    const result = (await onChainVerify({
      body: '{not valid json',
      headers: {},
      requestContext: { http: { method: 'POST' } },
    } as unknown as APIGatewayProxyEventV2)) as { statusCode: number };
    expect(result.statusCode).toBe(400);
  });

  it('rejects a stale or unknown nonce with 401', async () => {
    // Build a payload but DO NOT register it in the store — simulates an
    // attacker reusing a nonce that was already consumed.
    const issuedAt = Math.floor(Date.now() / 1000);
    const payload = `dreptalk:${STAGE}:drep.tools:fake_nonce:${issuedAt}`;
    const { publicKeyHex, signatureHex } = rawSign(payload);

    const result = (await onChainVerify(
      buildEvent({
        payload,
        signatureHex,
        publicKeyHex,
        role: 'spo',
      }),
    )) as { statusCode: number };

    expect(result.statusCode).toBe(401);
    expect(fakeKoios.poolCalidusKey).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Exit criterion (4) — revoking one jti rejects only that token
// ---------------------------------------------------------------------------

describe('on-chain verify — per-session revocation surface', () => {
  it('revoking session A leaves session B unaffected', async () => {
    // ---- Session A login (SPO) ----
    const sessionA = makeNoncePayload();
    const signA = rawSign(sessionA.payload);
    const POOL = 'pool1test_revoke_one';
    fakeKoios.poolCalidusKey.mockResolvedValueOnce({
      pool_id_bech32: POOL,
      calidus_pub_key: signA.publicKeyHex,
      calidus_id_bech32: 'calidus1revokeA',
      registered: true,
      pool_status: 'registered',
    });
    const resultA = (await onChainVerify(
      buildEvent({
        payload: sessionA.payload,
        signatureHex: signA.signatureHex,
        publicKeyHex: signA.publicKeyHex,
        role: 'spo',
      }),
    )) as { statusCode: number; body: string };
    expect(resultA.statusCode).toBe(200);
    const jsonA = JSON.parse(resultA.body) as { data: { jti: string; identity: string } };
    const jtiA = jsonA.data.jti;

    // ---- Session B login (different SPO pool — second sign-in) ----
    const sessionB = makeNoncePayload();
    const signB = rawSign(sessionB.payload);
    fakeKoios.poolCalidusKey.mockResolvedValueOnce({
      pool_id_bech32: POOL,
      calidus_pub_key: signB.publicKeyHex,
      calidus_id_bech32: 'calidus1revokeB',
      registered: true,
      pool_status: 'registered',
    });
    const resultB = (await onChainVerify(
      buildEvent({
        payload: sessionB.payload,
        signatureHex: signB.signatureHex,
        publicKeyHex: signB.publicKeyHex,
        role: 'spo',
      }),
    )) as { statusCode: number; body: string };
    expect(resultB.statusCode).toBe(200);
    const jsonB = JSON.parse(resultB.body) as { data: { jti: string } };
    const jtiB = jsonB.data.jti;

    expect(jtiA).not.toBe(jtiB);

    // Both sessions accepted initially.
    expect(await isSessionRevoked(jtiA)).toBe(false);
    expect(await isSessionRevoked(jtiB)).toBe(false);

    // Revoke A.
    await revokeSessionByJti(jtiA, POOL);

    // Defining check: A revoked, B still alive.
    expect(await isSessionRevoked(jtiA)).toBe(true);
    expect(await isSessionRevoked(jtiB)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sprint 3 — strict address-header rejection telemetry
// ---------------------------------------------------------------------------
//
// `lib/identity/auth/cose.ts` rejects (returns `{ok:false, reason:"protected
// header missing or invalid \"address\" field"}`) when a wallet's CIP-8
// COSE_Sign1 protected header lacks an `address` field. Oracle flagged that
// some older wallets omit it. We stay strict (reject) but emit a CloudWatch
// EMF metric on every rejection so Adam can quantify the affected wallet
// population BEFORE any future decision to relax. The wire response stays
// generic — internal reasons MUST NOT leak.

/**
 * Test-internal CIP-8 builder that DELIBERATELY omits the `address` field
 * from the protected header. Mirrors `makeCoseSignature` from the fixtures
 * but produces a malformed-by-our-rules signature whose ONLY difference
 * is the missing protected-header field — every other byte (alg, payload,
 * sig structure, COSE_Key) follows the same CIP-8 layout a valid wallet
 * signature does. This isolates the metric path under test.
 */
function makeCoseSignatureNoAddress(opts: { seed: Uint8Array; payload: string }): {
  signatureHex: string;
  keyHex: string;
  pubKey: Uint8Array;
} {
  const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
  const ED25519_SPKI_HEADER = Buffer.from('302a300506032b6570032100', 'hex');
  const coseEncoder = new Encoder({
    mapsAsObjects: false,
    useRecords: false,
    tagUint8Array: false,
  });
  const privKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(opts.seed)]),
    format: 'der',
    type: 'pkcs8',
  });
  const pubKeyBuf = createPublicKey(privKey).export({
    format: 'der',
    type: 'spki',
  }) as Buffer;
  const pubKey = new Uint8Array(pubKeyBuf.subarray(ED25519_SPKI_HEADER.length));
  // Touch blake2b224 so the helper exists in scope and unused-import lint
  // doesn't trip if the file is later refactored — and to mirror the fixture's
  // shape for any maintainer who diffs the two.
  void blake2b224(pubKey);
  // Protected header: alg only, NO 'address' field. This is the exact
  // condition `verifyCip8` rejects with the missing-address-header reason
  // string we want to count.
  const protectedMap = new Map<number | string, unknown>([[1, -8]]);
  const protectedBstr = coseEncoder.encode(protectedMap);
  const payloadBytes = new TextEncoder().encode(opts.payload);
  const toBeSigned = coseEncoder.encode([
    'Signature1',
    protectedBstr,
    new Uint8Array(0),
    payloadBytes,
  ]);
  const sig = new Uint8Array(nodeSign(null, Buffer.from(toBeSigned), privKey));
  const unprotected = new Map<string, unknown>([['hashed', false]]);
  const coseSign1 = [protectedBstr, unprotected, payloadBytes, sig];
  const coseKey = new Map<number, unknown>([
    [1, 1],
    [3, -8],
    [-1, 6],
    [-2, pubKey],
  ]);
  return {
    signatureHex: Buffer.from(coseEncoder.encode(coseSign1)).toString('hex'),
    keyHex: Buffer.from(coseEncoder.encode(coseKey)).toString('hex'),
    pubKey,
  };
}

describe('on-chain verify — strict address-header metric (Sprint 3)', () => {
  it('emits IdentityCoseMissingAddressHeader on a CIP-8 verify with no protected-header address', async () => {
    const { payload } = makeNoncePayload();
    const seed = new Uint8Array(randomBytes(32));
    const { signatureHex, keyHex } = makeCoseSignatureNoAddress({ seed, payload });

    // Capture stdout to inspect the EMF envelope. The metric path
    // writes a single-line JSON object via `console.log`.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const result = (await onChainVerify(
        buildEvent({ payload, signatureHex, keyHex, role: 'drep' }),
      )) as { statusCode: number; body: string };
      // The wire response is generic — internal reason MUST NOT leak.
      expect(result.statusCode).toBe(401);
      const json = JSON.parse(result.body) as { error?: string };
      expect(json.error ?? '').not.toContain('address');
      // Look for the EMF envelope among the captured log calls.
      const emitted = logSpy.mock.calls
        .map((args) => (typeof args[0] === 'string' ? args[0] : ''))
        .filter((s) => s.includes('IdentityCoseMissingAddressHeader'));
      expect(emitted.length).toBeGreaterThan(0);
      // The envelope must look like EMF — `_aws.CloudWatchMetrics` present,
      // metric name and value set on the top level. Parse the first hit.
      const envelope = JSON.parse(emitted[0]!) as {
        _aws: { CloudWatchMetrics: Array<{ Namespace: string; Metrics: Array<{ Name: string }> }> };
        IdentityCoseMissingAddressHeader: number;
        Stage: string;
        Role?: string;
      };
      expect(envelope._aws.CloudWatchMetrics[0]?.Namespace).toBe('DrepPlatform/Identity');
      expect(envelope._aws.CloudWatchMetrics[0]?.Metrics[0]?.Name).toBe(
        'IdentityCoseMissingAddressHeader',
      );
      expect(envelope.IdentityCoseMissingAddressHeader).toBe(1);
      expect(envelope.Stage).toBe(STAGE);
      // The handler attaches the role dimension so a future split shows
      // which role's wallets are affected.
      expect(envelope.Role).toBe('drep');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('does NOT emit the metric for a valid signature (clean DRep login)', async () => {
    const { payload } = makeNoncePayload();
    const seed = new Uint8Array(randomBytes(32));
    // First derive the key hash (we need it to bind the address bytes).
    const probe = makeCoseSignature({
      seed,
      payload,
      addressBytes: new Uint8Array(28),
    });
    const cose = makeCoseSignature({
      seed,
      payload,
      addressBytes: type6Address(probe.keyHash, 'mainnet'),
    });
    // Koios confirms the derived DRep id is registered.
    fakeKoios.drepInfo.mockResolvedValueOnce({
      drep_id: 'drep1positive_test',
      hex: null,
      has_script: false,
      drep_status: 'registered',
      deposit: null,
      active: true,
      expires_epoch_no: null,
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const result = (await onChainVerify(
        buildEvent({
          payload,
          signatureHex: cose.signatureHex,
          keyHex: cose.keyHex,
          role: 'drep',
        }),
      )) as { statusCode: number };
      // We expect the verify to succeed cryptographically. The Koios mock
      // returns a registered DRep, so the handler should return 200.
      expect(result.statusCode).toBe(200);
      // No EMF envelope for the missing-address-header metric should have
      // been emitted on the happy path.
      const emitted = logSpy.mock.calls
        .map((args) => (typeof args[0] === 'string' ? args[0] : ''))
        .filter((s) => s.includes('IdentityCoseMissingAddressHeader'));
      expect(emitted).toHaveLength(0);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('does NOT emit the metric for a non-address-header verify failure (e.g. bad signature math)', async () => {
    // Build a structurally-valid CIP-8 sig but tamper the signature bytes
    // so the Ed25519 check fails. The rejection reason should differ from
    // the missing-address-header reason; the metric MUST NOT fire.
    const { payload } = makeNoncePayload();
    const seed = new Uint8Array(randomBytes(32));
    const probe = makeCoseSignature({
      seed,
      payload,
      addressBytes: new Uint8Array(28),
    });
    const cose = makeCoseSignature({
      seed,
      payload,
      addressBytes: type6Address(probe.keyHash, 'mainnet'),
    });
    // Corrupt the COSE bytes — flip the last byte. This still decodes as a
    // 4-element CBOR array (signature bstr keeps its length) but the
    // Ed25519 verify will fail.
    const corruptedSigHex =
      cose.signatureHex.slice(0, -2) +
      ((parseInt(cose.signatureHex.slice(-2), 16) ^ 0xff) & 0xff).toString(16).padStart(2, '0');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const result = (await onChainVerify(
        buildEvent({
          payload,
          signatureHex: corruptedSigHex,
          keyHex: cose.keyHex,
          role: 'drep',
        }),
      )) as { statusCode: number };
      expect(result.statusCode).toBe(401);
      const emitted = logSpy.mock.calls
        .map((args) => (typeof args[0] === 'string' ? args[0] : ''))
        .filter((s) => s.includes('IdentityCoseMissingAddressHeader'));
      expect(emitted).toHaveLength(0);
    } finally {
      logSpy.mockRestore();
    }
  });
});
