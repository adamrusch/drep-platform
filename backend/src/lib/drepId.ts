import { blake2b224 } from './cardanoAddress';

/**
 * DRep id derivation (CIP-129).
 *
 * A key-hash DRep id is the bech32 encoding (hrp "drep") of a 1-byte header
 * (0x22 — key-hash governance credential) followed by the blake2b-224 hash of
 * the DRep public key. We derive it server-side from the CIP-95 DRep key the
 * wallet provides, so the committee binds to the caller's REAL on-chain DRep
 * rather than a placeholder.
 */

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const KEY_HASH_DREP_HEADER = 0x22; // CIP-129 key-hash governance credential

function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i] ?? 0;
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function createChecksum(hrp: string, data: number[]): number[] {
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ 1;
  const out: number[] = [];
  for (let i = 0; i < 6; i++) out.push((mod >> (5 * (5 - i))) & 31);
  return out;
}

function bech32Encode(hrp: string, data: number[]): string {
  const combined = [...data, ...createChecksum(hrp, data)];
  return `${hrp}1${combined.map((d) => CHARSET[d]).join('')}`;
}

/** Convert 8-bit bytes → 5-bit groups (with padding). */
function convertBits(bytes: Uint8Array, pad = true): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = 31;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad && bits > 0) out.push((acc << (5 - bits)) & maxv);
  return out;
}

/** drep1… id from a 28-byte key-hash credential (hex). */
export function drepIdFromCredentialHashHex(hashHex: string): string {
  if (!/^[0-9a-fA-F]{56}$/.test(hashHex)) {
    throw new Error('DRep credential hash must be 28 bytes (56 hex chars)');
  }
  const payload = Buffer.concat([
    Buffer.from([KEY_HASH_DREP_HEADER]),
    Buffer.from(hashHex, 'hex'),
  ]);
  return bech32Encode('drep', convertBits(payload));
}

/** drep1… id from a CIP-95 DRep public key (Ed25519, 32 bytes, hex). */
export function drepIdFromDRepKey(pubkeyHex: string): string {
  if (!/^[0-9a-fA-F]{64}$/.test(pubkeyHex)) {
    throw new Error('DRep public key must be 32 bytes (64 hex chars)');
  }
  const hash = blake2b224(Buffer.from(pubkeyHex, 'hex'));
  return drepIdFromCredentialHashHex(hash.toString('hex'));
}
