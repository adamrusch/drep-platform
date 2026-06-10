// Adapted from DRep Talk (https://github.com/katomm/dreptalk.com), Apache-2.0. Modified for drep-platform.
// CIP-8 COSE_Sign1 verifier tests. Ported from `cose.workers.test.ts` to run on
// vitest's Node pool. Uses `cbor-x` (instead of `cborg`) and the Node-crypto
// Ed25519 verifier — the same primitives the production module uses.
import { describe, it, expect } from 'vitest';
import { Encoder } from 'cbor-x';
import vectors from '../__fixtures__/cip8-vectors.json';
import { makeCoseSignature, type6Address } from '../__fixtures__/makeCose';
import { verifyCip8 } from './cose';
import { bytesToHex, hexToBytes } from '../crypto/hex';

// Same Map-aware codec as `cose.ts` so mutation helpers round-trip identically.
const codec = new Encoder({ mapsAsObjects: false, useRecords: false, tagUint8Array: false });

const stakeVector = vectors.vectors.find(v => v.label === 'stake-key-valid');
const drepVector = vectors.vectors.find(v => v.label === 'drep-key-valid');
if (!stakeVector) throw new Error('stake-key-valid fixture missing');

// Helpers to tamper with hex bytes.
function flipByte(hex: string, byteOffset: number): string {
  const chars = hex.split('');
  const charIdx = byteOffset * 2;
  const orig = Number.parseInt(chars[charIdx] ?? '0', 16);
  chars[charIdx] = ((orig ^ 0x01) & 0xf).toString(16);
  return chars.join('');
}

function replaceLastByte(hex: string): string {
  return `${hex.slice(0, -2)}ff`;
}

describe('verifyCip8 (stake-key-valid fixture)', () => {
  it('returns ok=true for a valid stake key fixture', async () => {
    const result = await verifyCip8({
      signatureHex: stakeVector.signatureHex,
      keyHex: stakeVector.keyHex,
      expectedPayload: stakeVector.payloadUtf8,
    });

    if (!result.ok) throw new Error(`verifyCip8 failed: ${result.reason}`);
    expect(result.ok).toBe(true);
    expect(result.pubKey).toBeInstanceOf(Uint8Array);
    expect(result.pubKey?.length).toBe(32);
    expect(bytesToHex(result.pubKey as Uint8Array)).toBe(stakeVector.expectedPubKeyHex);
    expect(result.addressBytes).toBeInstanceOf(Uint8Array);
    expect(bytesToHex(result.addressBytes as Uint8Array)).toBe(stakeVector.addressHex);
  });

  it('returns ok=false for a tampered signature (flipped byte 0)', async () => {
    const tamperedSig = flipByte(stakeVector.signatureHex, 0);
    const result = await verifyCip8({
      signatureHex: tamperedSig,
      keyHex: stakeVector.keyHex,
      expectedPayload: stakeVector.payloadUtf8,
    });
    expect(result.ok).toBe(false);
  });

  it('returns ok=false for a tampered signature (flipped last byte)', async () => {
    const tamperedSig = replaceLastByte(stakeVector.signatureHex);
    const result = await verifyCip8({
      signatureHex: tamperedSig,
      keyHex: stakeVector.keyHex,
      expectedPayload: stakeVector.payloadUtf8,
    });
    expect(result.ok).toBe(false);
  });

  it('returns ok=false when expectedPayload is wrong', async () => {
    const result = await verifyCip8({
      signatureHex: stakeVector.signatureHex,
      keyHex: stakeVector.keyHex,
      expectedPayload: 'dreptalk-login:wrong-nonce',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('returns ok=false when a different (wrong) COSE_Key is supplied', async () => {
    const wrongKey = drepVector
      ? drepVector.keyHex
      : stakeVector.keyHex.replace('3a7a', 'ffff');
    const result = await verifyCip8({
      signatureHex: stakeVector.signatureHex,
      keyHex: wrongKey,
      expectedPayload: stakeVector.payloadUtf8,
    });
    expect(result.ok).toBe(false);
  });

  it('returns ok=false for empty signatureHex (no throw)', async () => {
    const result = await verifyCip8({
      signatureHex: '',
      keyHex: stakeVector.keyHex,
      expectedPayload: stakeVector.payloadUtf8,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('returns ok=false for malformed signatureHex (no throw)', async () => {
    const result = await verifyCip8({
      signatureHex: 'deadbeef',
      keyHex: stakeVector.keyHex,
      expectedPayload: stakeVector.payloadUtf8,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('returns ok=false for non-hex signatureHex (no throw)', async () => {
    const result = await verifyCip8({
      signatureHex: 'not-hex!!!!',
      keyHex: stakeVector.keyHex,
      expectedPayload: stakeVector.payloadUtf8,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});

describe('verifyCip8 (drep-key-valid fixture)', () => {
  it('returns ok=true for a valid DRep key fixture', async () => {
    if (!drepVector) return;
    const result = await verifyCip8({
      signatureHex: drepVector.signatureHex,
      keyHex: drepVector.keyHex,
      expectedPayload: drepVector.payloadUtf8,
    });
    if (!result.ok) throw new Error(`verifyCip8 drep failed: ${result.reason}`);
    expect(result.ok).toBe(true);
    expect(result.pubKey).toBeInstanceOf(Uint8Array);
    expect(bytesToHex(result.pubKey as Uint8Array)).toBe(drepVector.expectedPubKeyHex);
  });
});

describe('verifyCip8 (real DRep signatures, as a CIP-95 wallet produces)', () => {
  const PAYLOAD = 'dreptalk:dreptalk.com:real-drep-nonce:1700000000';
  const SEED = new Uint8Array(32).fill(7);

  it('accepts a CIP-19 type-6 enterprise address (preprod header 0x60)', async () => {
    const keyHash = makeCoseSignature({
      seed: SEED,
      payload: PAYLOAD,
      addressBytes: new Uint8Array(28),
    }).keyHash;
    const cose = makeCoseSignature({
      seed: SEED,
      payload: PAYLOAD,
      addressBytes: type6Address(keyHash, 'preprod'),
    });
    const result = await verifyCip8({
      signatureHex: cose.signatureHex,
      keyHex: cose.keyHex,
      expectedPayload: PAYLOAD,
    });
    if (!result.ok) throw new Error(`verifyCip8 failed: ${result.reason}`);
    expect((result.addressBytes as Uint8Array)[0]).toBe(0x60);
    expect(bytesToHex(result.pubKey as Uint8Array)).toBe(bytesToHex(cose.pubKey));
  });

  it('accepts a CIP-19 type-6 enterprise address (mainnet header 0x61)', async () => {
    const keyHash = makeCoseSignature({
      seed: SEED,
      payload: PAYLOAD,
      addressBytes: new Uint8Array(28),
    }).keyHash;
    const cose = makeCoseSignature({
      seed: SEED,
      payload: PAYLOAD,
      addressBytes: type6Address(keyHash, 'mainnet'),
    });
    const result = await verifyCip8({
      signatureHex: cose.signatureHex,
      keyHex: cose.keyHex,
      expectedPayload: PAYLOAD,
    });
    if (!result.ok) throw new Error(`verifyCip8 failed: ${result.reason}`);
    expect((result.addressBytes as Uint8Array)[0]).toBe(0x61);
  });

  it('accepts a bare 28-byte DRep key hash (no header byte)', async () => {
    const keyHash = makeCoseSignature({
      seed: SEED,
      payload: PAYLOAD,
      addressBytes: new Uint8Array(28),
    }).keyHash;
    const cose = makeCoseSignature({
      seed: SEED,
      payload: PAYLOAD,
      addressBytes: keyHash,
    });
    const result = await verifyCip8({
      signatureHex: cose.signatureHex,
      keyHex: cose.keyHex,
      expectedPayload: PAYLOAD,
    });
    if (!result.ok) throw new Error(`verifyCip8 failed: ${result.reason}`);
    expect((result.addressBytes as Uint8Array).length).toBe(28);
  });

  it('rejects when the address key hash does not match the signing key', async () => {
    const cose = makeCoseSignature({
      seed: SEED,
      payload: PAYLOAD,
      addressBytes: type6Address(new Uint8Array(28).fill(0xaa), 'preprod'),
    });
    const result = await verifyCip8({
      signatureHex: cose.signatureHex,
      keyHex: cose.keyHex,
      expectedPayload: PAYLOAD,
    });
    expect(result.ok).toBe(false);
  });
});

// Helpers for mutating COSE_Key / COSE_Sign1 via cbor-x round-trip.

function mutateCoseKey(keyHex: string, mapKey: number, newValue: number | Uint8Array): string {
  const keyMap = codec.decode(Buffer.from(hexToBytes(keyHex))) as Map<number, unknown>;
  keyMap.set(mapKey, newValue);
  return bytesToHex(new Uint8Array(codec.encode(keyMap)));
}

function mutateCoseSign1ProtectedAlg(sigHex: string, newAlg: number): string {
  const coseSign1 = codec.decode(Buffer.from(hexToBytes(sigHex))) as [
    Uint8Array,
    unknown,
    Uint8Array,
    Uint8Array,
  ];
  const [protectedBstr, unprotectedHeader, payload, sig] = coseSign1;
  const protectedMap = codec.decode(Buffer.from(protectedBstr)) as Map<number, unknown>;
  protectedMap.set(1, newAlg);
  const newProtectedBstr = new Uint8Array(codec.encode(protectedMap));
  return bytesToHex(
    new Uint8Array(codec.encode([newProtectedBstr, unprotectedHeader, payload, sig])),
  );
}

function mutateCoseSign1Sig(sigHex: string, newSig: Uint8Array): string {
  const coseSign1 = codec.decode(Buffer.from(hexToBytes(sigHex))) as [
    Uint8Array,
    unknown,
    Uint8Array,
    Uint8Array,
  ];
  const [protectedBstr, unprotectedHeader, payload] = coseSign1;
  return bytesToHex(
    new Uint8Array(codec.encode([protectedBstr, unprotectedHeader, payload, newSig])),
  );
}

describe('verifyCip8 negative guard cases (alg, kty, crv, key size, sig)', () => {
  it('rejects COSE_Key with alg changed from -8 to -7 (ok=false, no throw)', async () => {
    const mutatedKeyHex = mutateCoseKey(stakeVector.keyHex, 3, -7);
    const result = await verifyCip8({
      signatureHex: stakeVector.signatureHex,
      keyHex: mutatedKeyHex,
      expectedPayload: stakeVector.payloadUtf8,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects COSE_Key with kty changed from 1 to 2 (ok=false, no throw)', async () => {
    const mutatedKeyHex = mutateCoseKey(stakeVector.keyHex, 1, 2);
    const result = await verifyCip8({
      signatureHex: stakeVector.signatureHex,
      keyHex: mutatedKeyHex,
      expectedPayload: stakeVector.payloadUtf8,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects COSE_Key with crv changed from 6 to 1 (ok=false, no throw)', async () => {
    const mutatedKeyHex = mutateCoseKey(stakeVector.keyHex, -1, 1);
    const result = await verifyCip8({
      signatureHex: stakeVector.signatureHex,
      keyHex: mutatedKeyHex,
      expectedPayload: stakeVector.payloadUtf8,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects COSE_Key with x truncated to 31 bytes (ok=false, no throw)', async () => {
    const keyMap = codec.decode(Buffer.from(hexToBytes(stakeVector.keyHex))) as Map<number, unknown>;
    const xFull = keyMap.get(-2) as Uint8Array;
    keyMap.set(-2, xFull.slice(0, 31));
    const mutatedKeyHex = bytesToHex(new Uint8Array(codec.encode(keyMap)));
    const result = await verifyCip8({
      signatureHex: stakeVector.signatureHex,
      keyHex: mutatedKeyHex,
      expectedPayload: stakeVector.payloadUtf8,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects COSE_Sign1 with protected header alg changed from -8 to -7 (ok=false, no throw)', async () => {
    const mutatedSigHex = mutateCoseSign1ProtectedAlg(stakeVector.signatureHex, -7);
    const result = await verifyCip8({
      signatureHex: mutatedSigHex,
      keyHex: stakeVector.keyHex,
      expectedPayload: stakeVector.payloadUtf8,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects COSE_Sign1 with sigBstr replaced by empty Uint8Array (ok=false, no throw)', async () => {
    const mutatedSigHex = mutateCoseSign1Sig(stakeVector.signatureHex, new Uint8Array(0));
    const result = await verifyCip8({
      signatureHex: mutatedSigHex,
      keyHex: stakeVector.keyHex,
      expectedPayload: stakeVector.payloadUtf8,
    });
    expect(result.ok).toBe(false);
  });
});
