/**
 * Security-critical tests for `verifyDRepKeySignature` — the CIP-95
 * proof-of-control verifier (Feature 2 of 3, 2026-06).
 *
 * # What this guards against
 *
 * Knowing a DRep public key proves NOTHING about who controls it (DRep
 * keys are public on-chain data). To safely set `users.drepId` we need a
 * fresh COSE_Sign1 made WITH the DRep key, over a server-issued message
 * that embeds the drep id. If verification ever drifts from "the signing
 * key IS the claimed drepKey" the impersonation door reopens — an
 * attacker could sign with their OWN DRep key, claim the victim's
 * drepKey, and have the binding succeed.
 *
 * The "REJECTS swap" test below is exactly that exploit reduced to its
 * essence. Treat its survival as the canary for the whole subsystem.
 *
 * # What we cover
 *
 *   1. **Happy path.** A real COSE_Sign1 over the canonical
 *      `buildDRepLinkMessage(...)` text, signed by the claimed DRep key.
 *      Asserts `valid: true`.
 *   2. **REJECTS the exact exploit: signed by key B, claimed for key A.**
 *      Without the pubkey↔drepKey hash check this would return `valid:
 *      true` — exactly the bug we're preventing. MUST fail closed with a
 *      reason mentioning the mismatch.
 *   3. **Wrong payload rejected.** A signature whose payload bytes don't
 *      equal `message` (e.g. signer signed a slightly different nonce).
 *   4. **Tampered signature byte rejected.** Flip a byte → reject.
 *   5. **Bogus drepKey format rejected.** Non-hex / wrong length → reject
 *      before touching CBOR.
 *   6. **DRep id consistency.** A signature with a fresh key and a
 *      drepKey hex that doesn't match its derivation is rejected.
 *
 * # Mocking strategy
 *
 * Uses `@emurgo/cardano-serialization-lib-nodejs` (already a backend dep)
 * to generate Ed25519 keypairs and CBOR-x to encode COSE_Sign1 /
 * COSE_Key exactly the way CIP-95 wallets do. The encoding is a handful
 * of bytes and matches the same `buildDataSignature` helper used by the
 * CIP-30 wallet-signature tests — the spec is unambiguous so reproducing
 * it in test code is safe.
 */
import { describe, it, expect } from 'vitest';
import { encode as cborEncode } from 'cbor-x';
import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { verifyDRepKeySignature, buildDRepLinkMessage } from './auth';
import { drepIdFromDRepKey } from './drepId';

/** Generate a fresh Ed25519 keypair via CSL. */
function freshKey(): CSL.PrivateKey {
  return CSL.PrivateKey.generate_ed25519();
}

/** Build a CIP-95 DataSignature for `message`, signed by `signingKey`.
 *  Mirrors what `cip95.signData(<arg>, hex(message))` returns in a real
 *  wallet. We deliberately do NOT include the optional `address` field
 *  in the protected header here — `verifyDRepKeySignature` doesn't
 *  check it (there's no address binding for DRep proof) and CIP-95
 *  wallets disagree on whether to set it. The core verifier sees a bare
 *  COSE_Sign1 and that's fine. */
function buildDataSignature(opts: {
  message: string;
  signingKey: CSL.PrivateKey;
}): { signature: string; key: string } {
  const payloadBytes = Buffer.from(opts.message, 'utf8');

  // Protected header: alg = EdDSA. CIP-95 wallets may include `address`
  // or omit it; verifier ignores either way.
  const headerMap = new Map<string | number, unknown>();
  headerMap.set(1, -8); // alg: EdDSA
  const protectedBytes = Buffer.from(cborEncode(headerMap));

  // Sig_Structure = ["Signature1", protected_bstr, external_aad(empty), payload_bstr]
  const sigStructure = Buffer.from(
    cborEncode(['Signature1', protectedBytes, Buffer.alloc(0), payloadBytes]),
  );

  const signature = opts.signingKey.sign(sigStructure).to_bytes();

  const coseSign1: unknown[] = [
    protectedBytes,
    new Map(), // empty unprotected header
    payloadBytes,
    Buffer.from(signature),
  ];
  const sigHex = Buffer.from(cborEncode(coseSign1)).toString('hex');

  // COSE_Key for the public key.
  const coseKeyMap = new Map<number, unknown>();
  coseKeyMap.set(1, 1); // kty: OKP
  coseKeyMap.set(3, -8); // alg: EdDSA
  coseKeyMap.set(-1, 6); // crv: Ed25519
  coseKeyMap.set(-2, Buffer.from(opts.signingKey.to_public().as_bytes()));
  const keyHex = Buffer.from(cborEncode(coseKeyMap)).toString('hex');

  return { signature: sigHex, key: keyHex };
}

/** The canonical wallet stake address used in the embedded message —
 *  doesn't affect the cryptography, just needs to be a string of plausible
 *  shape so `buildDRepLinkMessage` produces a realistic envelope. */
const WALLET_ADDRESS =
  'stake1u9pcm8gsd3v8wqgz3rxv0d6h2cfquvtw6cw4xqgse7w8qtgqzqg5w';

describe('verifyDRepKeySignature — CIP-95 proof-of-control', () => {
  it('accepts a valid signature made by the claimed DRep key', () => {
    const key = freshKey();
    const drepKeyHex = Buffer.from(key.to_public().as_bytes()).toString('hex');
    const drepId = drepIdFromDRepKey(drepKeyHex);

    const message = buildDRepLinkMessage('cafebabe', WALLET_ADDRESS, drepId);
    const sig = buildDataSignature({ message, signingKey: key });

    const result = verifyDRepKeySignature(drepKeyHex, message, sig);
    expect(result).toEqual({ valid: true });
  });

  it('REJECTS the exact exploit: signature by key B, claimed for key A (A≠B)', () => {
    // The whole point of the proof. Without the pubkey↔drepKey hash check
    // this returns valid:true and the attacker binds the victim's DRep.
    const victimKey = freshKey();
    const attackerKey = freshKey();
    const victimDrepKeyHex = Buffer.from(victimKey.to_public().as_bytes()).toString('hex');
    const victimDrepId = drepIdFromDRepKey(victimDrepKeyHex);

    // Server would have issued this for the victim's drepKey. Attacker
    // tries to satisfy it by signing with their own DRep key.
    const message = buildDRepLinkMessage('0000victim0000', WALLET_ADDRESS, victimDrepId);
    const exploitSig = buildDataSignature({ message, signingKey: attackerKey });

    const result = verifyDRepKeySignature(victimDrepKeyHex, message, exploitSig);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/match the claimed DRep key/i);
  });

  it('rejects a signature whose payload does not equal the expected message', () => {
    const key = freshKey();
    const drepKeyHex = Buffer.from(key.to_public().as_bytes()).toString('hex');
    const drepId = drepIdFromDRepKey(drepKeyHex);

    const signedMsg = buildDRepLinkMessage('aaaaaaaa', WALLET_ADDRESS, drepId);
    const expectedMsg = buildDRepLinkMessage('bbbbbbbb', WALLET_ADDRESS, drepId);
    const sig = buildDataSignature({ message: signedMsg, signingKey: key });

    const result = verifyDRepKeySignature(drepKeyHex, expectedMsg, sig);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/payload/i);
  });

  it('rejects a tampered signature byte', () => {
    const key = freshKey();
    const drepKeyHex = Buffer.from(key.to_public().as_bytes()).toString('hex');
    const drepId = drepIdFromDRepKey(drepKeyHex);

    const message = buildDRepLinkMessage('deadbeef', WALLET_ADDRESS, drepId);
    const sig = buildDataSignature({ message, signingKey: key });

    const sigBuf = Buffer.from(sig.signature, 'hex');
    sigBuf[sigBuf.length - 5] = (sigBuf[sigBuf.length - 5]! ^ 0x01) & 0xff;
    const tamperedSig = { ...sig, signature: sigBuf.toString('hex') };

    const result = verifyDRepKeySignature(drepKeyHex, message, tamperedSig);
    expect(result.valid).toBe(false);
  });

  it('rejects a drepKey that is not 32 bytes of hex', () => {
    const key = freshKey();
    const message = buildDRepLinkMessage(
      'ff',
      WALLET_ADDRESS,
      drepIdFromDRepKey(Buffer.from(key.to_public().as_bytes()).toString('hex')),
    );
    const sig = buildDataSignature({ message, signingKey: key });

    const tooShort = 'ab'.repeat(16); // 16 bytes, not 32
    const result = verifyDRepKeySignature(tooShort, message, sig);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/32-byte hex/i);
  });

  it('rejects when drepKey hash and signing-key hash differ even by one bit', () => {
    // Construct a drepKey by flipping one bit of the signing key's
    // public bytes. The signature is valid for the signing key, but
    // the hash bind step rejects because the claimed drepKey != the
    // actual signing key.
    const key = freshKey();
    const signingPub = Buffer.from(key.to_public().as_bytes());
    const flipped = Buffer.from(signingPub);
    flipped[0] = (flipped[0]! ^ 0x01) & 0xff;
    const flippedHex = flipped.toString('hex');

    // Build a message embedding the FLIPPED drepKey's id, then sign with
    // the ORIGINAL key. Payload bytes match, signature verifies, but the
    // pubkey↔drepKey bind fails.
    const message = buildDRepLinkMessage(
      'flipme',
      WALLET_ADDRESS,
      drepIdFromDRepKey(flippedHex),
    );
    const sig = buildDataSignature({ message, signingKey: key });

    const result = verifyDRepKeySignature(flippedHex, message, sig);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/match the claimed DRep key/i);
  });

  it('rejects a missing signature or key field cleanly (no throw)', () => {
    const drepKeyHex = 'a'.repeat(64);
    const empty = { signature: '', key: '' };
    const result = verifyDRepKeySignature(drepKeyHex, 'anything', empty);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/signature|key/i);
  });
});

describe('buildDRepLinkMessage — issuer/verifier byte-stability', () => {
  it('produces a deterministic, stage-bound, drep-id-embedded message', () => {
    const stagesEnvBackup = process.env['STAGE'];
    try {
      process.env['STAGE'] = 'test';
      const m1 = buildDRepLinkMessage('NONCE1', 'WALLET', 'drep1xyz');
      const m2 = buildDRepLinkMessage('NONCE1', 'WALLET', 'drep1xyz');
      expect(m1).toBe(m2);
      expect(m1).toContain('stage=test');
      expect(m1).toContain('Wallet: WALLET');
      expect(m1).toContain('DRep: drep1xyz');
      expect(m1).toContain('Nonce: NONCE1');
    } finally {
      if (stagesEnvBackup === undefined) delete process.env['STAGE'];
      else process.env['STAGE'] = stagesEnvBackup;
    }
  });
});
