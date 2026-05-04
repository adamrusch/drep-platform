/**
 * Cardano address codec — converts CIP-30 hex addresses to bech32.
 *
 * **Why this file exists:**
 *
 * CIP-30 (the wallet API spec) requires `getRewardAddresses()`,
 * `getUsedAddresses()`, and `getChangeAddress()` to return addresses
 * "encoded as either Address (CDDL hex string) or RewardAddress (hex
 * string)" — i.e., hex-encoded RAW BYTES. Most wallets (Eternl, Nami,
 * Lace, Flint, Typhon) implement this verbatim — you get back something
 * like `e1932344516680c1b6...`, not the user-facing `stake1u...` form.
 *
 * Our backend's `/auth/challenge` validates `walletAddress.startsWith('addr')`
 * or `'stake')`, expecting bech32. Without this codec the wallet-auth
 * flow returns 400 the moment we try to issue a challenge. (See the
 * Connection-failed bug uncovered on 2026-05-04.)
 *
 * **Why bech32 vs raw hex everywhere:**
 *
 * Bech32 is the canonical Cardano user-facing form — it's what wallets
 * display, what block explorers show, what Koios/Blockfrost return. Hex
 * is a wire-format detail of the CIP-30 contract. Storing hex in our
 * DB and showing it to users would split the codebase between two
 * representations of the same value.
 *
 * Bech32 also makes the sign-message human-readable in the wallet popup:
 *
 *     Wallet: stake1uyvjdz9rxsfsmv44rtk75k2rqyqskrga96dgdfrqjvjjpwsefcjnp
 *     vs
 *     Wallet: e1932344516680c1b6a8d76f52ca0c001685a3a4ba6a... [scary blob]
 *
 * **Address byte layout (Shelley era — CIP-19 / CDDL):**
 *
 * Byte 0 of the raw address is a header byte. The high nibble indicates
 * the address kind, the low nibble the network discriminator (1 = mainnet,
 * 0 = testnet). Possible kinds we care about:
 *
 *   0x0X — payment (key) + stake (key)        — full base address
 *   0x1X — payment (script) + stake (key)
 *   0x2X — payment (key) + stake (script)
 *   0x3X — payment (script) + stake (script)
 *   0x4X — payment (key) + stake (pointer)    — base + pointer
 *   0x5X — payment (script) + stake (pointer)
 *   0x6X — payment (key) only                 — enterprise (no staking)
 *   0x7X — payment (script) only
 *   0xeX — stake (key)                        — reward
 *   0xfX — stake (script)
 *
 * Bech32 HRP (human-readable prefix) is decided from this:
 *   - 0x6X / 0x7X / 0x0X-0x5X (mainnet) → `addr`
 *   - 0x6X / 0x7X / 0x0X-0x5X (testnet) → `addr_test`
 *   - 0xeX / 0xfX (mainnet)             → `stake`
 *   - 0xeX / 0xfX (testnet)             → `stake_test`
 *
 * **CBOR wrapping:** the CIP-30 spec is ambiguous on whether the hex is
 * raw bytes or CBOR-wrapped bytes. In practice every major wallet returns
 * raw bytes — we attempt CBOR-decode as a fallback if the raw-bytes path
 * yields a header byte that doesn't match any known address kind.
 */

import { bech32 } from 'bech32';

/** Max length of the bech32 data part — Cardano relaxes this from the
 *  standard 90-char limit since base addresses are 57 bytes (≈103 chars
 *  in bech32). 1023 is a comfortable cap that the bech32 lib accepts. */
const BECH32_LIMIT = 1023;

/** Hex helper: decode a hex string into a Uint8Array. Throws on odd-length
 *  or non-hex characters. Defensive — wallet returns can be unpredictable. */
function hexToBytes(hex: string): Uint8Array {
  const trimmed = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (trimmed.length === 0 || trimmed.length % 2 !== 0) {
    throw new Error(`Invalid hex length: ${trimmed.length}`);
  }
  if (!/^[0-9a-fA-F]+$/.test(trimmed)) {
    throw new Error('Invalid hex characters');
  }
  const out = new Uint8Array(trimmed.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Tiny CBOR byte-string decoder — handles the four cases CIP-30 wallets
 *  might emit: `40-57` (length in low nibble), `58 LL`, `59 LLLL`, `5A LLLLLLLL`.
 *  Returns null if the input doesn't start with a CBOR byte-string marker. */
function cborByteStringPayload(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length === 0) return null;
  const first = bytes[0]!;
  // Major type 2 = byte string. Major type bits are the high 3 (0b010_).
  if ((first & 0xe0) !== 0x40) return null;
  const ai = first & 0x1f; // additional info
  if (ai < 24) {
    // Length encoded directly in low nibble.
    if (bytes.length < 1 + ai) return null;
    return bytes.slice(1, 1 + ai);
  }
  // Multi-byte length.
  let lenBytes: number;
  if (ai === 24) lenBytes = 1;
  else if (ai === 25) lenBytes = 2;
  else if (ai === 26) lenBytes = 4;
  else return null; // 8-byte length not realistic for an address
  if (bytes.length < 1 + lenBytes) return null;
  let len = 0;
  for (let i = 0; i < lenBytes; i++) len = (len << 8) | bytes[1 + i]!;
  if (bytes.length < 1 + lenBytes + len) return null;
  return bytes.slice(1 + lenBytes, 1 + lenBytes + len);
}

/** Pick the bech32 HRP from the address header byte.
 *  Returns null if the header byte doesn't look like a known Cardano
 *  address kind — the caller should treat this as a decode failure. */
function hrpForHeader(header: number): string | null {
  const kind = (header >> 4) & 0x0f;
  const network = header & 0x0f; // 1 = mainnet, 0 = testnet
  if (network !== 0 && network !== 1) return null;
  const isTestnet = network === 0;
  // Stake (reward) addresses
  if (kind === 0xe || kind === 0xf) return isTestnet ? 'stake_test' : 'stake';
  // Payment addresses (all the kinds 0x0..0x7)
  if (kind <= 0x7) return isTestnet ? 'addr_test' : 'addr';
  return null;
}

/**
 * Convert a CIP-30 hex address (as returned by `walletApi.getRewardAddresses()`,
 * `getUsedAddresses()`, `getChangeAddress()`) into its bech32 representation.
 *
 * Tries the input as raw hex bytes first (which is what every major wallet
 * we've tested actually returns). If that produces an unrecognizable header
 * byte, attempts CBOR byte-string decoding and tries again — this catches
 * any future wallet that follows the spec literally.
 *
 * @throws if the input can't be decoded as either raw or CBOR-wrapped, or
 *         if the header byte doesn't match a known Cardano address kind.
 */
export function cip30HexToBech32(hex: string): string {
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(hex);
  } catch (err) {
    throw new Error(
      `Wallet returned a non-hex address: "${hex.slice(0, 20)}…" (${(err as Error).message})`,
    );
  }
  if (bytes.length === 0) {
    throw new Error('Wallet returned an empty address');
  }

  // Path 1: treat as raw bytes.
  const headerRaw = bytes[0]!;
  const hrpRaw = hrpForHeader(headerRaw);
  if (hrpRaw) {
    const words = bech32.toWords(bytes);
    return bech32.encode(hrpRaw, words, BECH32_LIMIT);
  }

  // Path 2: maybe it's CBOR-wrapped. Unwrap and retry.
  const inner = cborByteStringPayload(bytes);
  if (inner && inner.length > 0) {
    const headerInner = inner[0]!;
    const hrpInner = hrpForHeader(headerInner);
    if (hrpInner) {
      const words = bech32.toWords(inner);
      return bech32.encode(hrpInner, words, BECH32_LIMIT);
    }
  }

  throw new Error(
    `Wallet returned an unrecognizable address (header byte 0x${headerRaw.toString(16)})`,
  );
}

/**
 * If `value` is already bech32 (starts with `addr`/`stake`), return it
 * unchanged. Otherwise treat it as a CIP-30 hex address and convert.
 *
 * Useful at the boundary between wallet API output and our own backend
 * — some MeshSDK paths already pre-convert, others pass through the raw
 * CIP-30 value. Idempotent.
 */
export function ensureBech32Address(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.startsWith('addr1') ||
    trimmed.startsWith('addr_test1') ||
    trimmed.startsWith('stake1') ||
    trimmed.startsWith('stake_test1')
  ) {
    return trimmed;
  }
  return cip30HexToBech32(trimmed);
}
