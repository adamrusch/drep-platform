// Adapted from DRep Talk (https://github.com/katomm/dreptalk.com), Apache-2.0. Modified for drep-platform.
//
// Parity test — proves that a known-good CIP-30 / CIP-95 wallet signature (the
// DRep Talk fixtures, which are real preprod test-wallet signatures, not
// hand-crafted vectors) verifies through the NEW ported COSE verifier, and
// that tampered variants are rejected. This is the "existing DRep CIP-30 login
// works through the new module" exit check.
//
// Why a separate file: the per-area test files (cose / handlers) already exercise
// the same fixtures, but this one is the single grep target a reviewer can use
// to confirm "we did not break wallet auth" — it stays minimal and explicit.

import { describe, it, expect } from 'vitest';
import vectors from './__fixtures__/cip8-vectors.json';
import { verifyCip8 } from './auth/cose';
import { bytesToHex } from './crypto/hex';

const stakeVector = vectors.vectors.find(v => v.label === 'stake-key-valid');
const drepVector = vectors.vectors.find(v => v.label === 'drep-key-valid');
if (!stakeVector || !drepVector) throw new Error('expected fixtures missing');

describe('parity: DRep Talk CIP-8 fixtures verify through the ported module', () => {
  it('stake-key-valid: ok=true, pubKey matches', async () => {
    const result = await verifyCip8({
      signatureHex: stakeVector.signatureHex,
      keyHex: stakeVector.keyHex,
      expectedPayload: stakeVector.payloadUtf8,
    });
    if (!result.ok) {
      throw new Error(`parity stake fixture failed: ${result.reason}`);
    }
    expect(result.ok).toBe(true);
    expect(bytesToHex(result.pubKey as Uint8Array)).toBe(stakeVector.expectedPubKeyHex);
    expect(bytesToHex(result.addressBytes as Uint8Array)).toBe(stakeVector.addressHex);
  });

  it('drep-key-valid: ok=true, pubKey matches', async () => {
    const result = await verifyCip8({
      signatureHex: drepVector.signatureHex,
      keyHex: drepVector.keyHex,
      expectedPayload: drepVector.payloadUtf8,
    });
    if (!result.ok) {
      throw new Error(`parity drep fixture failed: ${result.reason}`);
    }
    expect(result.ok).toBe(true);
    expect(bytesToHex(result.pubKey as Uint8Array)).toBe(drepVector.expectedPubKeyHex);
  });

  it('stake-key-valid with tampered last byte → ok=false', async () => {
    const tampered = `${stakeVector.signatureHex.slice(0, -2)}ff`;
    const result = await verifyCip8({
      signatureHex: tampered,
      keyHex: stakeVector.keyHex,
      expectedPayload: stakeVector.payloadUtf8,
    });
    expect(result.ok).toBe(false);
  });

  it('stake-key-valid with wrong expected payload → ok=false', async () => {
    const result = await verifyCip8({
      signatureHex: stakeVector.signatureHex,
      keyHex: stakeVector.keyHex,
      expectedPayload: 'this is not the payload that was signed',
    });
    expect(result.ok).toBe(false);
  });

  it('stake-key-valid with drep COSE_Key (wrong pubkey) → ok=false', async () => {
    const result = await verifyCip8({
      signatureHex: stakeVector.signatureHex,
      keyHex: drepVector.keyHex,
      expectedPayload: stakeVector.payloadUtf8,
    });
    expect(result.ok).toBe(false);
  });
});
