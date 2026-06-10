// Adapted from DRep Talk (https://github.com/katomm/dreptalk.com), Apache-2.0. Modified for drep-platform.
// URL-safe base64 encoding/decoding without padding.
// Node 20 has Buffer + a global btoa/atob, but we prefer Buffer for stability and speed.

/** Encodes a Uint8Array as a base64url string (no padding). */
export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** Decodes a base64url string (with or without padding) to a Uint8Array. */
export function fromBase64Url(str: string): Uint8Array {
  return new Uint8Array(Buffer.from(str, 'base64url'));
}
