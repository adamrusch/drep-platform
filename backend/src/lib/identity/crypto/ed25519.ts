// Adapted from DRep Talk (https://github.com/katomm/dreptalk.com), Apache-2.0. Modified for drep-platform.
//
// Ed25519 signature verification primitive shared by the CIP-8 (wallet) login
// path and the raw-signature (Calidus / CC hot key paste) login path.
//
// Stack adaptation: DRep Talk runs on Cloudflare workerd where WebCrypto exposes
// `Ed25519` natively (or falls back to `@noble/curves`). drep-platform runs on
// Node 20 in classic-CommonJS mode; Node's WebCrypto exposes `Ed25519` as of
// 22+, but on 20 it is not always available. We use Node's `crypto` module
// (`createPublicKey` + `verify`) with the SubjectPublicKeyInfo DER prefix
// (RFC 8410) for the raw 32-byte Ed25519 public key — the same approach the
// legacy `src/lib/auth.ts` uses today.
//
// Never throws: any failure is returned as { ok: false, reason }; the reason is
// for server-side logging, never leaked to clients.

import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

export interface Ed25519VerifyResult {
  ok: boolean;
  reason?: string;
}

// SubjectPublicKeyInfo DER header for Ed25519 (RFC 8410). Prepending this to
// the raw 32-byte public key produces a 44-byte SPKI that Node's
// `createPublicKey` accepts via `format: 'der', type: 'spki'`.
const ED25519_SPKI_HEADER = Buffer.from('302a300506032b6570032100', 'hex');

/** Verifies a detached Ed25519 signature of `msg` by `pubKey`. */
export async function verifyEd25519(
  sig: Uint8Array,
  msg: Uint8Array,
  pubKey: Uint8Array,
): Promise<Ed25519VerifyResult> {
  if (pubKey.length !== 32) {
    return { ok: false, reason: `Ed25519 public key must be 32 bytes, got ${pubKey.length}` };
  }
  if (sig.length !== 64) {
    return { ok: false, reason: `Ed25519 signature must be 64 bytes, got ${sig.length}` };
  }

  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_HEADER, Buffer.from(pubKey)]),
      format: 'der',
      type: 'spki',
    });
    const valid = cryptoVerify(null, Buffer.from(msg), publicKey, Buffer.from(sig));
    return valid
      ? { ok: true }
      : { ok: false, reason: 'Ed25519 signature verification failed (node crypto)' };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `Ed25519 verification threw: ${reason}` };
  }
}
