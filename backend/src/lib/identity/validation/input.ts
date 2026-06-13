// Adapted from DRep Talk (https://github.com/katomm/dreptalk.com), Apache-2.0. Modified for drep-platform.
// Validation helpers for untrusted input (auth request bodies), applied before
// any decode, crypto, or storage.

// Generous upper bounds for the CIP-8 login body. Real values are far smaller
// (a COSE_Key is well under 100 bytes, a login COSE_Sign1 under ~500), so these
// never reject a legitimate request; they only stop oversized payloads from
// reaching the hex decoder and signature verification.
export const MAX_PAYLOAD_LEN = 2048;
export const MAX_KEY_HEX_LEN = 4096;
export const MAX_SIG_HEX_LEN = 16384;

// Raw Ed25519 sizes for the Calidus / CC-hot paste login flow: a detached
// signature is exactly 64 bytes (128 hex chars) and a public key exactly 32
// bytes (64 hex chars). These are enforced exactly, not as upper bounds.
export const RAW_SIG_HEX_LEN = 128;
export const RAW_PUBKEY_HEX_LEN = 64;

const HEX_RE = /^[0-9a-fA-F]*$/;

/** True when `s` is an even-length hex string of at most `maxLen` characters. */
export function isHex(s: string, maxLen: number): boolean {
  return s.length <= maxLen && s.length % 2 === 0 && HEX_RE.test(s);
}

/** True when `s` is a hex string of exactly `exactLen` characters. */
export function isHexExact(s: string, exactLen: number): boolean {
  return s.length === exactLen && HEX_RE.test(s);
}
