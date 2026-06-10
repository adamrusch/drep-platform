// Adapted from DRep Talk (https://github.com/katomm/dreptalk.com), Apache-2.0. Modified for drep-platform.
// Blake2b hash helpers.
// Stack adaptation: DRep Talk uses `blakejs` (ESM-only). We use the existing
// `blake2b` dependency (CommonJS-compatible) which exposes an
// `update`/`digest` builder rather than a one-shot function.
import blake2b from 'blake2b';

function hashBlake2b(input: Uint8Array, outLen: number): Uint8Array {
  const out = Buffer.alloc(outLen);
  blake2b(outLen).update(input).digest(out);
  return new Uint8Array(out);
}

/** Hashes bytes with Blake2b-224 (28-byte output), as used by Cardano key hashing. */
export function blake2b224(bytes: Uint8Array): Uint8Array {
  return hashBlake2b(bytes, 28);
}

/** Hashes bytes with Blake2b-256 (32-byte output). */
export function blake2b256(bytes: Uint8Array): Uint8Array {
  return hashBlake2b(bytes, 32);
}
