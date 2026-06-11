// Adapted from DRep Talk (https://github.com/katomm/dreptalk.com), Apache-2.0. Modified for drep-platform.
// Converted from `handlers.workers.test.ts` to run on vitest's Node pool.
//
// The Cloudflare-bindings have been replaced by:
//   - `nonceStore` / `sessionStore` — in-memory implementations from
//     `../stores/*`.
//   - `userStore` — `InMemoryUserStore` from `./users`.
//   - `koios` — fake clients defined in this file.
// The CIP-8 fixtures (`__fixtures__/cip8-vectors.json`) are carried over
// verbatim from DRep Talk; the synthetic COSE signatures use the local
// `makeCose.ts` adapter that swaps `@noble/curves` for Node `crypto`.
//
// Nonce alignment — same trick as DRep Talk's workers test:
// the fixtures sign a fixed payload ("dreptalk-login:test-vector-001") whose
// shape doesn't match our stage-bound parser. We inject a custom `consumeNonce`
// for the happy-path fixture tests that simulates single-use semantics via the
// in-memory store. Reject-flow tests use real consumeNonce + a properly
// shaped payload.

import { describe, it, expect, beforeEach } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import vectors from '../__fixtures__/cip8-vectors.json';
import { makeCoseSignature, type6Address } from '../__fixtures__/makeCose';
import { handleChallenge, handleVerify, handleLogout } from './handlers';
import { getSession } from './session';
import { ccHotKeyHashHex } from '../cardano/identity';
import { bytesToHex } from '../crypto/hex';
import { InMemoryNonceStore, type NonceStore } from '../stores/nonceStore';
import { InMemorySessionStore } from '../stores/sessionStore';
import { InMemoryUserStore } from './users';
import type { KoiosClient } from './koios';

function koiosRejectAll(): KoiosClient {
  return {
    drepInfo: async () => null,
    proposalsByReturnAddress: async () => [],
    poolCalidusKey: async () => null,
    committeeInfo: async () => [],
    poolStatus: async () => null,
  };
}

function fakeKoios(overrides: Partial<KoiosClient> = {}): KoiosClient {
  return { ...koiosRejectAll(), ...overrides };
}

// Raw Ed25519 signing for the SPO/CC paste login flow. We use Node crypto for
// determinism and to avoid a `@noble/curves` dependency.
function rawSign(payload: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const ED25519_SPKI_HEADER_LEN = 12;
  const pubKey = new Uint8Array(spki.subarray(ED25519_SPKI_HEADER_LEN));
  const sig = new Uint8Array(nodeSign(null, Buffer.from(payload, 'utf8'), privateKey));
  return { publicKeyHex: bytesToHex(pubKey), signatureHex: bytesToHex(sig), pubKey };
}

const stakeVector = vectors.vectors.find(v => v.label === 'stake-key-valid');
const drepVector = vectors.vectors.find(v => v.label === 'drep-key-valid');
if (!stakeVector || !drepVector) throw new Error('expected fixtures missing');

// Fixture-nonce override: simulates a single-use nonce store keyed by the
// fixture payload string (which is too short to match the real parser).
function makeFixtureNonceOverride(store: InMemoryNonceStore, payload: string) {
  const sentinelKey = `fixture:${payload}`;
  // Preload the sentinel under a long TTL (mirrors a freshly-issued nonce).
  void store.put(sentinelKey, payload, 3600);
  return async (kvArg: NonceStore, payloadArg: string): Promise<boolean> => {
    if (payloadArg !== payload) return false;
    const stored = await kvArg.get(sentinelKey);
    if (stored === null) return false;
    await kvArg.delete(sentinelKey);
    return true;
  };
}

// ---------------------------------------------------------------------------
// Per-test fresh stores
// ---------------------------------------------------------------------------

let nonceStore: InMemoryNonceStore;
let sessionStore: InMemorySessionStore;
let userStore: InMemoryUserStore;

beforeEach(() => {
  nonceStore = new InMemoryNonceStore();
  sessionStore = new InMemorySessionStore();
  userStore = new InMemoryUserStore();
});

// ---------------------------------------------------------------------------
// handleChallenge
// ---------------------------------------------------------------------------

describe('handleChallenge', () => {
  it('returns a payload in the dreptalk:<stage>:<domain>:<nonce>:<ts> format', async () => {
    const result = await handleChallenge({
      nonceStore,
      domain: 'dreptalk.com',
      stage: 'test',
    });
    expect(typeof result.payload).toBe('string');
    expect(result.payload).toMatch(/^dreptalk:test:dreptalk\.com:[^:]+:\d+$/);
  });
});

// ---------------------------------------------------------------------------
// handleVerify -- happy path: PROPOSER
// ---------------------------------------------------------------------------

describe('handleVerify: happy path (proposer)', () => {
  it('returns 200, ok:true, a Set-Cookie, and inserts a users row', async () => {
    const fixturePayload = stakeVector.payloadUtf8;
    const consumeOverride = makeFixtureNonceOverride(nonceStore, fixturePayload);

    const result = await handleVerify(
      {
        body: {
          payload: fixturePayload,
          signatureHex: stakeVector.signatureHex,
          keyHex: stakeVector.keyHex,
          role: 'proposer',
        },
        nonceStore,
        sessionStore,
        userStore,
        koios: fakeKoios({
          proposalsByReturnAddress: async addr => [
            { proposal_id: 'gov_action1fixture', return_address: addr, proposal_type: 'InfoAction' },
          ],
        }),
        network: 'preprod',
        stage: 'test',
        now: 1_700_000_000,
        secure: false,
      },
      { consumeNonce: consumeOverride },
    );

    expect(result.status).toBe(200);
    expect((result.json as { ok: boolean }).ok).toBe(true);
    expect(result.setCookie).toBeTruthy();
    expect(result.setCookie).toContain('dreptalk_session=');
    expect(result.setCookie).toContain('HttpOnly');

    const json = result.json as { ok: boolean; user: { id: string; roles: string[] } };
    expect(json.user).toBeTruthy();
    expect(json.user.roles).toContain('proposer');

    const row = await userStore.getUserById(json.user.id);
    expect(row).not.toBeNull();
    expect(row?.is_proposer).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleVerify -- happy path: DREP
// ---------------------------------------------------------------------------

describe('handleVerify: happy path (drep)', () => {
  it('returns 200 and inserts a drep user row for a real type-6 DRep signature', async () => {
    const payload = 'dreptalk:test:dreptalk.com:drep-happy-nonce:1700000000';
    const consumeOverride = makeFixtureNonceOverride(nonceStore, payload);

    const seed = new Uint8Array(32).fill(9);
    const { keyHash } = makeCoseSignature({ seed, payload, addressBytes: new Uint8Array(28) });
    const cose = makeCoseSignature({
      seed,
      payload,
      addressBytes: type6Address(keyHash, 'preprod'),
    });

    const result = await handleVerify(
      {
        body: {
          payload,
          signatureHex: cose.signatureHex,
          keyHex: cose.keyHex,
          role: 'drep',
        },
        nonceStore,
        sessionStore,
        userStore,
        koios: fakeKoios({
          drepInfo: async (id: string) => ({
            drep_id: id,
            hex: 'bb',
            has_script: false,
            drep_status: 'registered',
            active: true,
            deposit: '500000000',
            expires_epoch_no: null,
          }),
        }),
        network: 'preprod',
        stage: 'test',
        now: 1_700_000_100,
        secure: false,
      },
      { consumeNonce: consumeOverride },
    );

    expect(result.status).toBe(200);
    expect((result.json as { ok: boolean }).ok).toBe(true);
    expect(result.setCookie).toBeTruthy();

    const json = result.json as { ok: boolean; user: { id: string; roles: string[] } };
    expect(json.user.roles).toContain('drep');
    const row = await userStore.getUserById(json.user.id);
    expect(row?.is_drep).toBe(true);
  });

  it('accepts a bare 28-byte DRep key hash address form', async () => {
    const payload = 'dreptalk:test:dreptalk.com:drep-bare-nonce:1700000000';
    const consumeOverride = makeFixtureNonceOverride(nonceStore, payload);

    const seed = new Uint8Array(32).fill(10);
    const { keyHash } = makeCoseSignature({ seed, payload, addressBytes: new Uint8Array(28) });
    const cose = makeCoseSignature({ seed, payload, addressBytes: keyHash });

    const result = await handleVerify(
      {
        body: { payload, signatureHex: cose.signatureHex, keyHex: cose.keyHex, role: 'drep' },
        nonceStore,
        sessionStore,
        userStore,
        koios: fakeKoios({
          drepInfo: async (id: string) => ({
            drep_id: id,
            hex: 'cc',
            has_script: false,
            drep_status: 'registered',
            active: true,
            deposit: '500000000',
            expires_epoch_no: null,
          }),
        }),
        network: 'preprod',
        stage: 'test',
        now: 1_700_000_100,
        secure: false,
      },
      { consumeNonce: consumeOverride },
    );

    expect(result.status).toBe(200);
    expect((result.json as { ok: boolean }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleVerify -- happy path: SPO (Calidus, raw Ed25519)
// ---------------------------------------------------------------------------

describe('handleVerify: happy path (spo)', () => {
  it('returns 200 and inserts an spo user for a registered calidus key', async () => {
    const payload = 'dreptalk:test:dreptalk.com:spo-happy-nonce:1700000000';
    const consumeOverride = makeFixtureNonceOverride(nonceStore, payload);
    const { publicKeyHex, signatureHex } = rawSign(payload);
    const POOL = 'pool1test-spo-happy';

    const result = await handleVerify(
      {
        body: { payload, signatureHex, publicKeyHex, role: 'spo' },
        nonceStore,
        sessionStore,
        userStore,
        koios: fakeKoios({
          poolCalidusKey: async (hex: string) =>
            hex.toLowerCase() === publicKeyHex.toLowerCase()
              ? {
                  pool_id_bech32: POOL,
                  calidus_pub_key: publicKeyHex,
                  calidus_id_bech32: 'calidus1test',
                  registered: true,
                  pool_status: 'registered',
                }
              : null,
        }),
        network: 'preprod',
        stage: 'test',
        now: 1_700_000_000,
        secure: false,
      },
      { consumeNonce: consumeOverride },
    );

    expect(result.status).toBe(200);
    const json = result.json as { ok: boolean; user: { id: string; roles: string[] } };
    expect(json.ok).toBe(true);
    expect(json.user.roles).toContain('spo');
    expect(json.user.id).toBe(POOL);
    const row = await userStore.getUserById(json.user.id);
    expect(row?.is_spo).toBe(true);
    expect(row?.pool_id).toBe(POOL);
  });

  it('returns 401 when the calidus key is not registered to any pool', async () => {
    const payload = 'dreptalk:test:dreptalk.com:spo-unknown-nonce:1700000000';
    const consumeOverride = makeFixtureNonceOverride(nonceStore, payload);
    const { publicKeyHex, signatureHex } = rawSign(payload);

    const result = await handleVerify(
      {
        body: { payload, signatureHex, publicKeyHex, role: 'spo' },
        nonceStore,
        sessionStore,
        userStore,
        koios: fakeKoios({ poolCalidusKey: async () => null }),
        network: 'preprod',
        stage: 'test',
        now: 1_700_000_000,
        secure: false,
      },
      { consumeNonce: consumeOverride },
    );

    expect(result.status).toBe(401);
  });

  it('returns 401 when the raw signature does not verify (flipped byte)', async () => {
    const payload = 'dreptalk:test:dreptalk.com:spo-badsig-nonce:1700000000';
    const consumeOverride = makeFixtureNonceOverride(nonceStore, payload);
    const { publicKeyHex, signatureHex } = rawSign(payload);
    const badSig = signatureHex.slice(0, -2) + (signatureHex.endsWith('00') ? 'ff' : '00');

    const result = await handleVerify(
      {
        body: { payload, signatureHex: badSig, publicKeyHex, role: 'spo' },
        nonceStore,
        sessionStore,
        userStore,
        koios: fakeKoios({
          poolCalidusKey: async () => ({
            pool_id_bech32: 'pool1x',
            calidus_pub_key: publicKeyHex,
            calidus_id_bech32: 'calidus1x',
            registered: true,
            pool_status: 'registered',
          }),
        }),
        network: 'preprod',
        stage: 'test',
        now: 1_700_000_000,
        secure: false,
      },
      { consumeNonce: consumeOverride },
    );

    expect(result.status).toBe(401);
  });

  it('returns 400 when the signature has the wrong length', async () => {
    const payload = 'dreptalk:test:dreptalk.com:spo-badlen-nonce:1700000000';
    const consumeOverride = makeFixtureNonceOverride(nonceStore, payload);
    const { publicKeyHex } = rawSign(payload);

    const result = await handleVerify(
      {
        body: { payload, signatureHex: 'abcd', publicKeyHex, role: 'spo' },
        nonceStore,
        sessionStore,
        userStore,
        koios: fakeKoios(),
        network: 'preprod',
        stage: 'test',
        now: 1_700_000_000,
        secure: false,
      },
      { consumeNonce: consumeOverride },
    );

    expect(result.status).toBe(400);
  });

  it('returns 400 when publicKeyHex is missing for an spo login', async () => {
    const payload = 'dreptalk:test:dreptalk.com:spo-nopub-nonce:1700000000';
    const consumeOverride = makeFixtureNonceOverride(nonceStore, payload);
    const { signatureHex } = rawSign(payload);

    const result = await handleVerify(
      {
        body: { payload, signatureHex, role: 'spo' } as Parameters<typeof handleVerify>[0]['body'],
        nonceStore,
        sessionStore,
        userStore,
        koios: fakeKoios(),
        network: 'preprod',
        stage: 'test',
        now: 1_700_000_000,
        secure: false,
      },
      { consumeNonce: consumeOverride },
    );

    expect(result.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// handleVerify -- happy path: CC (committee hot key, raw Ed25519)
// ---------------------------------------------------------------------------

describe('handleVerify: happy path (cc)', () => {
  it('returns 200 and inserts a cc user for an authorized key-based member', async () => {
    const payload = 'dreptalk:test:dreptalk.com:cc-happy-nonce:1700000000';
    const consumeOverride = makeFixtureNonceOverride(nonceStore, payload);
    const { publicKeyHex, signatureHex, pubKey } = rawSign(payload);
    const hotHex = ccHotKeyHashHex(pubKey);
    const COLD = 'cc_cold1test-cc-happy';

    const result = await handleVerify(
      {
        body: { payload, signatureHex, publicKeyHex, role: 'cc' },
        nonceStore,
        sessionStore,
        userStore,
        koios: fakeKoios({
          committeeInfo: async () => [
            {
              status: 'authorized',
              cc_hot_id: 'cc_hot1test',
              cc_cold_id: COLD,
              cc_hot_hex: hotHex,
              cc_cold_hex: 'aabbcc',
              expiration_epoch: 300,
              cc_hot_has_script: false,
              cc_cold_has_script: false,
            },
          ],
        }),
        network: 'preprod',
        stage: 'test',
        now: 1_700_000_000,
        secure: false,
      },
      { consumeNonce: consumeOverride },
    );

    expect(result.status).toBe(200);
    const json = result.json as { ok: boolean; user: { id: string; roles: string[] } };
    expect(json.ok).toBe(true);
    expect(json.user.roles).toContain('cc');
    expect(json.user.id).toBe(COLD);
    const row = await userStore.getUserById(json.user.id);
    expect(row?.is_cc).toBe(true);
    expect(row?.cc_cred).toBe(COLD);
  });

  it('returns 401 when the member exists but is not authorized', async () => {
    const payload = 'dreptalk:test:dreptalk.com:cc-unauth-nonce:1700000000';
    const consumeOverride = makeFixtureNonceOverride(nonceStore, payload);
    const { publicKeyHex, signatureHex, pubKey } = rawSign(payload);
    const hotHex = ccHotKeyHashHex(pubKey);

    const result = await handleVerify(
      {
        body: { payload, signatureHex, publicKeyHex, role: 'cc' },
        nonceStore,
        sessionStore,
        userStore,
        koios: fakeKoios({
          committeeInfo: async () => [
            {
              status: 'not_authorized',
              cc_hot_id: null,
              cc_cold_id: 'cc_cold1x',
              cc_hot_hex: hotHex,
              cc_cold_hex: 'aa',
              expiration_epoch: 300,
              cc_hot_has_script: null,
              cc_cold_has_script: false,
            },
          ],
        }),
        network: 'preprod',
        stage: 'test',
        now: 1_700_000_000,
        secure: false,
      },
      { consumeNonce: consumeOverride },
    );

    expect(result.status).toBe(401);
  });

  it('returns 401 when the matching credential is a native script (not key-based)', async () => {
    const payload = 'dreptalk:test:dreptalk.com:cc-script-nonce:1700000000';
    const consumeOverride = makeFixtureNonceOverride(nonceStore, payload);
    const { publicKeyHex, signatureHex, pubKey } = rawSign(payload);
    const hotHex = ccHotKeyHashHex(pubKey);

    const result = await handleVerify(
      {
        body: { payload, signatureHex, publicKeyHex, role: 'cc' },
        nonceStore,
        sessionStore,
        userStore,
        koios: fakeKoios({
          committeeInfo: async () => [
            {
              status: 'authorized',
              cc_hot_id: 'cc_hot1x',
              cc_cold_id: 'cc_cold1x',
              cc_hot_hex: hotHex,
              cc_cold_hex: 'aa',
              expiration_epoch: 300,
              cc_hot_has_script: true,
              cc_cold_has_script: true,
            },
          ],
        }),
        network: 'preprod',
        stage: 'test',
        now: 1_700_000_000,
        secure: false,
      },
      { consumeNonce: consumeOverride },
    );

    expect(result.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// handleVerify -- reject: replayed nonce
// ---------------------------------------------------------------------------

describe('handleVerify: reject replayed nonce (spo)', () => {
  it('returns 401 on the second call with the same nonce', async () => {
    const payload = 'dreptalk:test:dreptalk.com:spo-replay-nonce:1700000000';
    const consumeOverride = makeFixtureNonceOverride(nonceStore, payload);
    const { publicKeyHex, signatureHex } = rawSign(payload);

    const input = {
      body: { payload, signatureHex, publicKeyHex, role: 'spo' as const },
      nonceStore,
      sessionStore,
      userStore,
      koios: fakeKoios({
        poolCalidusKey: async () => ({
          pool_id_bech32: 'pool1replay',
          calidus_pub_key: publicKeyHex,
          calidus_id_bech32: 'calidus1x',
          registered: true,
          pool_status: 'registered',
        }),
      }),
      network: 'preprod' as const,
      stage: 'test',
      now: 1_700_000_000,
      secure: false,
    };
    const deps = { consumeNonce: consumeOverride };

    const first = await handleVerify(input, deps);
    expect(first.status).toBe(200);
    const second = await handleVerify(input, deps);
    expect(second.status).toBe(401);
  });
});

describe('handleVerify: reject replayed nonce (proposer fixture)', () => {
  it('returns 401 on the second call with the same nonce', async () => {
    const fixturePayload = stakeVector.payloadUtf8;
    const consumeOverride = makeFixtureNonceOverride(nonceStore, fixturePayload);

    const commonInput = {
      body: {
        payload: fixturePayload,
        signatureHex: stakeVector.signatureHex,
        keyHex: stakeVector.keyHex,
        role: 'proposer' as const,
      },
      nonceStore,
      sessionStore,
      userStore,
      koios: fakeKoios({
        proposalsByReturnAddress: async addr => [
          { proposal_id: 'x', return_address: addr, proposal_type: 'InfoAction' },
        ],
      }),
      network: 'preprod' as const,
      stage: 'test',
      now: 1_700_000_000,
      secure: false,
    };
    const commonDeps = { consumeNonce: consumeOverride };

    const first = await handleVerify(commonInput, commonDeps);
    expect(first.status).toBe(200);

    const second = await handleVerify(commonInput, commonDeps);
    expect(second.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// handleVerify -- reject: bad signature
// ---------------------------------------------------------------------------

describe('handleVerify: reject bad signature', () => {
  it('returns 401 when the signature has a flipped byte', async () => {
    const fixturePayload = stakeVector.payloadUtf8;
    const consumeOverride = makeFixtureNonceOverride(nonceStore, fixturePayload);

    const badSig = `${stakeVector.signatureHex.slice(0, -2)}ff`;

    const result = await handleVerify(
      {
        body: {
          payload: fixturePayload,
          signatureHex: badSig,
          keyHex: stakeVector.keyHex,
          role: 'proposer',
        },
        nonceStore,
        sessionStore,
        userStore,
        koios: fakeKoios(),
        network: 'preprod',
        stage: 'test',
        now: 1_700_000_000,
        secure: false,
      },
      { consumeNonce: consumeOverride },
    );

    expect(result.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// handleVerify -- reject: koios says not a proposer
// ---------------------------------------------------------------------------

describe('handleVerify: reject when koios returns no proposals', () => {
  it('returns 401 when koios returns empty proposals', async () => {
    const fixturePayload = stakeVector.payloadUtf8;
    const consumeOverride = makeFixtureNonceOverride(nonceStore, fixturePayload);

    const result = await handleVerify(
      {
        body: {
          payload: fixturePayload,
          signatureHex: stakeVector.signatureHex,
          keyHex: stakeVector.keyHex,
          role: 'proposer',
        },
        nonceStore,
        sessionStore,
        userStore,
        koios: fakeKoios(),
        network: 'preprod',
        stage: 'test',
        now: 1_700_000_000,
        secure: false,
      },
      { consumeNonce: consumeOverride },
    );

    expect(result.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// handleVerify -- grant moderator role via the stake-key allowlist
// ---------------------------------------------------------------------------

describe('handleVerify: moderator allowlist', () => {
  it('logs in an allowlisted stake address that has no proposals, with the admin role', async () => {
    const fixturePayload = stakeVector.payloadUtf8;
    const consumeOverride = makeFixtureNonceOverride(nonceStore, fixturePayload);

    const result = await handleVerify(
      {
        body: {
          payload: fixturePayload,
          signatureHex: stakeVector.signatureHex,
          keyHex: stakeVector.keyHex,
          role: 'proposer',
        },
        nonceStore,
        sessionStore,
        userStore,
        koios: fakeKoios(),
        network: 'preprod',
        stage: 'test',
        now: 1_700_000_000,
        secure: false,
      },
      { consumeNonce: consumeOverride, getModeratorRole: () => 'admin' },
    );

    expect(result.status).toBe(200);
    const json = result.json as { ok: boolean; user: { roles: string[] } };
    expect(json.ok).toBe(true);
    expect(json.user.roles).toContain('admin');
  });
});

// ---------------------------------------------------------------------------
// handleVerify -- reject: wrong header byte for the role
// ---------------------------------------------------------------------------

describe('handleVerify: reject wrong address type for role', () => {
  it('rejects stake-key fixture (header 0xe0) when role=drep', async () => {
    const fixturePayload = stakeVector.payloadUtf8;
    const consumeOverride = makeFixtureNonceOverride(nonceStore, fixturePayload);

    const result = await handleVerify(
      {
        body: {
          payload: fixturePayload,
          signatureHex: stakeVector.signatureHex,
          keyHex: stakeVector.keyHex,
          role: 'drep',
        },
        nonceStore,
        sessionStore,
        userStore,
        koios: fakeKoios(),
        network: 'preprod',
        stage: 'test',
        now: 1_700_000_000,
        secure: false,
      },
      { consumeNonce: consumeOverride },
    );

    expect(result.status).toBe(401);
  });

  it('rejects drep-key fixture (header 0x22) when role=proposer on preprod (expects 0xe0)', async () => {
    const fixturePayload = drepVector.payloadUtf8;
    const consumeOverride = makeFixtureNonceOverride(nonceStore, fixturePayload);

    const result = await handleVerify(
      {
        body: {
          payload: fixturePayload,
          signatureHex: drepVector.signatureHex,
          keyHex: drepVector.keyHex,
          role: 'proposer',
        },
        nonceStore,
        sessionStore,
        userStore,
        koios: fakeKoios(),
        network: 'preprod',
        stage: 'test',
        now: 1_700_000_000,
        secure: false,
      },
      { consumeNonce: consumeOverride },
    );

    expect(result.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// handleVerify -- reject: malformed body
// ---------------------------------------------------------------------------

describe('handleVerify: reject malformed body', () => {
  it('returns 400 when body is missing required fields', async () => {
    const result = await handleVerify({
      body: { payload: '', signatureHex: '', keyHex: '', role: '' },
      nonceStore,
      sessionStore,
      userStore,
      koios: fakeKoios(),
      network: 'preprod',
      stage: 'test',
    });
    expect(result.status).toBe(400);
  });

  it('returns 400 when role is not drep or proposer', async () => {
    const result = await handleVerify({
      body: { payload: 'x', signatureHex: 'y', keyHex: 'z', role: 'admin' },
      nonceStore,
      sessionStore,
      userStore,
      koios: fakeKoios(),
      network: 'preprod',
      stage: 'test',
    });
    expect(result.status).toBe(400);
  });

  it('does not throw for a completely wrong body (no throw guarantee)', async () => {
    const result = await handleVerify({
      body: null as unknown as Parameters<typeof handleVerify>[0]['body'],
      nonceStore,
      sessionStore,
      userStore,
      koios: fakeKoios(),
      network: 'preprod',
      stage: 'test',
    });
    expect(result.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// handleLogout
// ---------------------------------------------------------------------------

describe('handleLogout', () => {
  it('revokes the session so getSession returns null afterwards', async () => {
    const { createSession } = await import('./session');
    const token = await createSession(sessionStore, {
      id: 'logout-test-user',
      roles: ['proposer'],
    });

    expect(await getSession(sessionStore, token)).not.toBeNull();

    const cookieHeader = `dreptalk_session=${token}`;
    const result = await handleLogout({ sessionStore, cookieHeader });

    expect(result.status).toBe(200);
    expect((result.json as { ok: boolean }).ok).toBe(true);
    expect(result.setCookie).toContain('Max-Age=0');

    expect(await getSession(sessionStore, token)).toBeNull();
  });

  it('succeeds gracefully with no cookie (no throw)', async () => {
    const result = await handleLogout({ sessionStore, cookieHeader: null });
    expect(result.status).toBe(200);
  });

  it('succeeds gracefully with an unknown token cookie (no throw)', async () => {
    const result = await handleLogout({
      sessionStore,
      cookieHeader: 'dreptalk_session=unknown-garbage-token-xyz',
    });
    expect(result.status).toBe(200);
  });
});
