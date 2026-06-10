// Adapted from DRep Talk (https://github.com/katomm/dreptalk.com), Apache-2.0. Modified for drep-platform.
// Tests for the Ed25519 verification wrapper. Uses Node's `sign/Verify` directly
// (rather than @noble/curves) to generate test vectors without pulling new deps.
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { verifyEd25519 } from './ed25519';

// Generate a deterministic-ish test key by reusing the same generated keypair
// across this file. Ed25519 keygen is cheap (~µs), so generating once at module
// load is fine.
function makeTestKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  // Export the raw 32-byte public key by reading the DER SPKI and stripping the
  // 12-byte SPKI header (matching the prefix used in ed25519.ts).
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const raw = new Uint8Array(spki.slice(12));
  return { rawPubKey: raw, privateKey };
}

const { rawPubKey: PUBKEY, privateKey: PRIVKEY } = makeTestKey();
const MSG = new TextEncoder().encode('dreptalk:dreptalk.com:test-nonce:1700000000');
const SIG = new Uint8Array(nodeSign(null, Buffer.from(MSG), PRIVKEY));

describe('verifyEd25519', () => {
  it('returns ok:true for a valid signature over the message', async () => {
    const result = await verifyEd25519(SIG, MSG, PUBKEY);
    expect(result.ok).toBe(true);
  });

  it('returns ok:false when a signature byte is flipped', async () => {
    const bad = new Uint8Array(SIG);
    bad[0] ^= 0xff;
    const result = await verifyEd25519(bad, MSG, PUBKEY);
    expect(result.ok).toBe(false);
  });

  it('returns ok:false when the message differs from what was signed', async () => {
    const otherMsg = new TextEncoder().encode('dreptalk:dreptalk.com:other-nonce:1700000000');
    const result = await verifyEd25519(SIG, otherMsg, PUBKEY);
    expect(result.ok).toBe(false);
  });

  it('returns ok:false for a wrong public key', async () => {
    const { rawPubKey: otherPub } = makeTestKey();
    const result = await verifyEd25519(SIG, MSG, otherPub);
    expect(result.ok).toBe(false);
  });

  it('returns ok:false (never throws) for a malformed public key length', async () => {
    const result = await verifyEd25519(SIG, MSG, new Uint8Array(10));
    expect(result.ok).toBe(false);
  });
});
