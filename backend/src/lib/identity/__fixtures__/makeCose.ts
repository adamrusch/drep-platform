// Adapted from DRep Talk (https://github.com/katomm/dreptalk.com), Apache-2.0. Modified for drep-platform.
// Test-only helper: builds a real CIP-8 COSE_Sign1 + COSE_Key from an ephemeral
// Ed25519 key, exactly as a CIP-30 / CIP-95 wallet's signData would. Used to
// exercise verifyCip8 and the auth gates against genuine, wallet-shaped
// signatures instead of hand-pinned fixtures.
//
// Stack adaptations from DRep Talk's version:
//   - Ed25519 signing: Node `crypto` (createPrivateKey + sign) instead of
//     `@noble/curves`. We build a private key from the SEED bytes by wrapping
//     them in the PKCS#8 DER header for Ed25519 (RFC 8410); this lets the test
//     remain deterministic from a fixed seed without pulling new deps.
//   - CBOR encoding: `cbor-x`'s configured Encoder with `mapsAsObjects: false`
//     so Map values serialise as CBOR maps (not arrays/objects), matching what
//     a real wallet emits.

import { createPrivateKey, createPublicKey, sign as nodeSign } from 'node:crypto';
import { Encoder } from 'cbor-x';
import { blake2b224 } from '../crypto/blake';
import { bytesToHex } from '../crypto/hex';

// Encoder configured to preserve Map shapes — CBOR maps in / Maps out.
const coseEncoder = new Encoder({ mapsAsObjects: false, useRecords: false, tagUint8Array: false });

// PKCS#8 DER prefix for an Ed25519 private key seeded with 32 raw bytes
// (RFC 8410). The 32-byte seed slots in after the prefix to make the 48-byte
// PKCS#8 envelope Node `createPrivateKey` expects.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
// Same SubjectPublicKeyInfo header used by `crypto/ed25519.ts`.
const ED25519_SPKI_HEADER = Buffer.from('302a300506032b6570032100', 'hex');

function ed25519PublicKey(seed: Uint8Array): Uint8Array {
  // Round-trip the seed through Node's keypair to derive the raw 32-byte pubkey.
  const privKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)]),
    format: 'der',
    type: 'pkcs8',
  });
  const pubKey = createPublicKey(privKey);
  const spki = pubKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return new Uint8Array(spki.subarray(ED25519_SPKI_HEADER.length));
}

function ed25519Sign(msg: Uint8Array, seed: Uint8Array): Uint8Array {
  const privKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)]),
    format: 'der',
    type: 'pkcs8',
  });
  return new Uint8Array(nodeSign(null, Buffer.from(msg), privKey));
}

export interface MadeCose {
  signatureHex: string;
  keyHex: string;
  pubKey: Uint8Array;
  keyHash: Uint8Array; // blake2b224(pubKey)
  addressBytes: Uint8Array;
}

/**
 * Builds a COSE_Sign1 over `payload`, signed by the Ed25519 key derived from
 * `seed`, with `addressBytes` placed verbatim in the protected header (as a
 * wallet does). The payload is signed un-hashed (hashed=false).
 */
export function makeCoseSignature(opts: {
  seed: Uint8Array; // 32-byte Ed25519 secret seed
  payload: string;
  addressBytes: Uint8Array;
}): MadeCose {
  const pubKey = ed25519PublicKey(opts.seed);
  const keyHash = blake2b224(pubKey);

  // Protected header: alg EdDSA (-8) + the raw address bytes (no CBOR tag).
  const protectedMap = new Map<number | string, unknown>([
    [1, -8],
    ['address', opts.addressBytes],
  ]);
  const protectedBstr = coseEncoder.encode(protectedMap);
  const payloadBytes = new TextEncoder().encode(opts.payload);

  // Sig_structure = ['Signature1', protected, external_aad(empty), payload].
  const toBeSigned = coseEncoder.encode([
    'Signature1',
    protectedBstr,
    new Uint8Array(0),
    payloadBytes,
  ]);
  const sig = ed25519Sign(toBeSigned, opts.seed);

  const unprotected = new Map<string, unknown>([['hashed', false]]);
  const coseSign1 = [protectedBstr, unprotected, payloadBytes, sig];

  const coseKey = new Map<number, unknown>([
    [1, 1], // kty: OKP
    [3, -8], // alg: EdDSA
    [-1, 6], // crv: Ed25519
    [-2, pubKey], // x: public key
  ]);

  return {
    signatureHex: bytesToHex(coseEncoder.encode(coseSign1)),
    keyHex: bytesToHex(coseEncoder.encode(coseKey)),
    pubKey,
    keyHash,
    addressBytes: opts.addressBytes,
  };
}

/** CIP-19 type-6 (enterprise) address: header byte (0x61 mainnet / 0x60 preprod) + 28-byte key hash. */
export function type6Address(keyHash: Uint8Array, network: 'mainnet' | 'preprod'): Uint8Array {
  const out = new Uint8Array(29);
  out[0] = network === 'mainnet' ? 0x61 : 0x60;
  out.set(keyHash, 1);
  return out;
}
