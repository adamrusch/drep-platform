/**
 * CIP-95 proof-of-control linking helpers.
 *
 * Owns the wallet-side dance for proving the connected wallet controls a
 * DRep key:
 *
 *   1. `enable({ extensions: [{ cip: 95 }] })` then `cip95.getPubDRepKey()`.
 *   2. Server issues a `{ nonce, message, drepId }` via POST /drep/link/challenge.
 *   3. `cip95.signData(<addr>, hex(message))` — and here be dragons (see below).
 *   4. POST /drep/link with `{ drepKey, nonce, signature, key }`.
 *
 * # The "what is the first arg to cip95.signData?" ambiguity
 *
 * CIP-95 documents `signData(address, payload)` where `address` is "a
 * bech32 string representation of the DRep key", BUT wallet implementations
 * disagree on what they accept:
 *
 *   - Some accept the bech32 `drep1…` id itself.
 *   - Some accept ONLY raw hex of a credential.
 *   - Some accept a TYPE-6 (enterprise) address built from the DRep
 *     key-hash credential, because their internal signing path goes
 *     through the same code that handles wallet addresses.
 *   - Some accept the DRep key-hash hex directly.
 *
 * We can't tell up-front which form a given wallet wants. The strategy is
 * to try the most "spec-faithful" form first (the drep1… bech32) and fall
 * back through the alternatives the field has converged on, surfacing a
 * clear error only if NONE work. The server doesn't actually care about
 * which first-arg form was used — verification reads the signing key out
 * of the COSE_Key and checks it against the claimed drepKey directly. The
 * first arg is purely a wallet-internal "which credential signs this?"
 * key-lookup signal.
 *
 * # Why we don't pull in CSL on the frontend just for this
 *
 * Cardano-serialization-lib would derive these forms cleanly but it's a
 * ~1.3 MB gz / 5.4 MB WASM hot-load — overkill for one bech32 encode and
 * a single-byte header swap. We do the derivations inline below; the
 * blake2b-224 of the key hash is already known to us as the credential
 * embedded in the drep id we got from the server, so we just decode that
 * to get the 28 bytes.
 */

import { bech32 } from 'bech32';

const BECH32_LIMIT = 1023;

/** UTF-8 → hex encoder. CIP-30 / CIP-95 `signData` expect the payload as hex. */
export function utf8ToHex(text: string): string {
  const enc = new TextEncoder().encode(text);
  let out = '';
  for (const b of enc) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * Decode a `drep1…` bech32 id back to its 28-byte key-hash credential
 * (hex). CIP-129 drep ids prefix the 28-byte hash with a 1-byte header
 * (0x22 = key-hash governance credential); this strips the header.
 *
 * Returns null if the input doesn't look like a drep1 id.
 */
export function drepIdToKeyHashHex(drepId: string): string | null {
  try {
    const decoded = bech32.decode(drepId, BECH32_LIMIT);
    if (decoded.prefix !== 'drep') return null;
    const bytes = bech32.fromWords(decoded.words);
    if (bytes.length !== 29) return null; // 1 header + 28 hash
    const tail = bytes.slice(1); // drop the 0x22 header
    let hex = '';
    for (const b of tail) hex += b.toString(16).padStart(2, '0');
    return hex;
  } catch {
    return null;
  }
}

/**
 * Build a type-6 (enterprise) address from the DRep key-hash credential.
 *
 * Why type 6? It's the lowest-friction "wrap an Ed25519 key hash in an
 * address" form: header 0x6X (payment key, enterprise) + 28-byte
 * credential. No stake part, no scripts. Some CIP-95 wallets internally
 * route signData through their general address-credential matcher and
 * accept this form when the bech32 drep id confuses them.
 *
 * We default to mainnet (network 1) when no signal is available; the
 * server verification ignores the first arg form entirely, so the
 * network byte choice only affects whether the WALLET decides to sign.
 * Most wallets are lenient with mainnet enterprise-address probes.
 *
 * Returns the bech32 `addr1…` string, or null if `keyHashHex` is the
 * wrong shape.
 */
export function drepKeyHashToEnterpriseAddress(
  keyHashHex: string,
  network: 0 | 1 = 1,
): string | null {
  if (!/^[0-9a-fA-F]{56}$/.test(keyHashHex)) return null;
  const header = (0x60 | network) & 0xff; // 0x61 mainnet, 0x60 testnet — enterprise payment-key
  const hashBytes = new Uint8Array(28);
  for (let i = 0; i < 28; i++) hashBytes[i] = parseInt(keyHashHex.slice(i * 2, i * 2 + 2), 16);
  const addr = new Uint8Array(29);
  addr[0] = header;
  addr.set(hashBytes, 1);
  const hrp = network === 1 ? 'addr' : 'addr_test';
  return bech32.encode(hrp, bech32.toWords(addr), BECH32_LIMIT);
}

/** CIP-95 wallet API surface — only the bits this module uses. */
export interface Cip95Api {
  signData?: (
    addressOrId: string,
    payloadHex: string,
  ) => Promise<{ signature: string; key: string }>;
  getPubDRepKey?: () => Promise<string>;
}

/** CIP-30 wallet API with the CIP-95 extension nested under `.cip95`. */
export interface WalletApiWithCip95 {
  cip95?: Cip95Api;
}

/**
 * Try `cip95.signData(arg, hex(message))` against a sequence of plausible
 * `arg` forms until one succeeds. Returns the wallet's `{ signature, key }`
 * on the first call that doesn't throw.
 *
 * The order is "most likely to work" first:
 *   1. bech32 drep1… id  — what the CIP-95 spec text suggests.
 *   2. enterprise `addr1…` derived from the DRep key hash — what some
 *      wallets actually accept when their internal path runs through the
 *      address matcher.
 *   3. raw key-hash hex — last-resort fallback for any wallet that
 *      treats `signData` as "match this credential and sign".
 *
 * If all three throw, surfaces the LAST wallet error so the user sees a
 * concrete message rather than a generic "everything failed" wall.
 */
export async function tryCip95SignData(opts: {
  api: WalletApiWithCip95;
  drepId: string;
  message: string;
}): Promise<{ signature: string; key: string; usedArg: 'drepId' | 'enterpriseAddr' | 'keyHashHex' }> {
  if (!opts.api.cip95?.signData) {
    throw new Error(
      'This wallet does not expose cip95.signData. Update to a CIP-95-capable build (Eternl, Lace, Nufi recent versions).',
    );
  }
  const payloadHex = utf8ToHex(opts.message);

  const keyHashHex = drepIdToKeyHashHex(opts.drepId);
  const enterpriseAddr = keyHashHex ? drepKeyHashToEnterpriseAddress(keyHashHex) : null;

  const candidates: Array<{ form: 'drepId' | 'enterpriseAddr' | 'keyHashHex'; value: string }> = [
    { form: 'drepId', value: opts.drepId },
    ...(enterpriseAddr ? [{ form: 'enterpriseAddr' as const, value: enterpriseAddr }] : []),
    ...(keyHashHex ? [{ form: 'keyHashHex' as const, value: keyHashHex }] : []),
  ];

  let lastErr: unknown = null;
  for (const c of candidates) {
    try {
      const sig = await opts.api.cip95.signData(c.value, payloadHex);
      if (sig?.signature && sig?.key) {
        return { signature: sig.signature, key: sig.key, usedArg: c.form };
      }
      lastErr = new Error('Wallet returned an empty signature.');
    } catch (err) {
      lastErr = err;
      // try the next form
    }
  }

  // None of the forms worked. Surface the most recent wallet error.
  if (lastErr instanceof Error) throw lastErr;
  throw new Error('Wallet rejected every CIP-95 signData form we tried.');
}
