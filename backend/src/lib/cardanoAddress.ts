/**
 * Cardano address parsing helpers used by the CIP-30 signature verifier.
 *
 * # Why this lives in its own module
 *
 * The auth-bypass fix (P0-1 in the 2026-05-28 audit) requires binding the
 * public key inside a CIP-30 DataSignature to the wallet address the caller
 * is claiming. That binding needs two steps:
 *
 *   1. Decode the bech32 `stake1...` / `addr1...` to its raw address bytes.
 *   2. Extract the 28-byte payment / staking key-hash CREDENTIAL from those
 *      bytes per CIP-19's header-nibble layout.
 *
 * The verifier then takes the COSE_Key pubkey, blake2b-224 hashes it, and
 * compares to the credential. Both pieces of logic are share-able across
 * the wallet-signing path AND any future feature that needs to validate an
 * address (e.g. checking the protected-header address claim is consistent
 * with the caller's bech32 input).
 *
 * # CIP-19 byte layout (the source of every magic number below)
 *
 *   Header byte: high nibble = address type, low nibble = network id.
 *     - 0b0000..0b0001 (0x0X / 0x1X) → BASE: payment KEY+stake KEY    (57 bytes)
 *     - 0b0010..0b0011 (0x2X / 0x3X) → BASE: payment SCRIPT+stake KEY (57 bytes)
 *     - 0b0100..0b0101 (0x4X / 0x5X) → BASE: payment KEY+stake SCRIPT (57 bytes)
 *     - 0b0110..0b0111 (0x6X / 0x7X) → ENTERPRISE: payment KEY/SCRIPT (29 bytes)
 *     - 0b1000         (0x8X)        → POINTER (29+variable bytes) — unsupported here
 *     - 0b1110         (0xeX)        → REWARD/STAKE: stake KEY        (29 bytes)
 *     - 0b1111         (0xfX)        → REWARD/STAKE: stake SCRIPT     (29 bytes)
 *   Network id: 0x1 = mainnet, 0x0 = testnet (preprod, preview).
 *
 *   For our purposes a "credential" is 28 bytes immediately following the
 *   header byte:
 *     - For a base address, the FIRST 28 bytes after the header are the
 *       payment credential; bytes 29..56 are the stake credential.
 *     - For an enterprise or reward address, bytes 1..28 are the only
 *       credential (payment or stake respectively).
 *
 *   We REJECT script-credential addresses for login because the platform
 *   has no notion of contract-controlled wallets; allowing them would
 *   let an attacker construct a script whose hash collides with their
 *   own key hash (cheap to attempt at 28 bytes if scripts were arbitrary
 *   bytes, but more importantly the platform UX has no path for it).
 *
 * # References
 *
 *   - CIP-19 Cardano addresses: https://cips.cardano.org/cips/cip19/
 *   - CIP-8  COSE_Sign1 over Cardano payloads: https://cips.cardano.org/cips/cip8/
 *   - CIP-30 dApp/wallet bridge `signData`: https://cips.cardano.org/cips/cip30/
 */
import { bech32 } from 'bech32';
import blake2b from 'blake2b';

/** Cardano bech32 addresses can exceed the BIP-173 default 90-char limit
 *  (a base address is 103 characters). 1023 is the safe upper bound used
 *  by the wider Cardano tooling ecosystem and matches the `LIMIT` chosen
 *  by `cardano-serialization-lib`. */
const BECH32_LIMIT = 1023;

/** Length of a single credential (blake2b-224 output = 28 bytes). */
export const CREDENTIAL_LENGTH = 28;

/** Stake / enterprise addresses are 29 bytes (1 header + 28 credential). */
const STAKE_OR_ENTERPRISE_LENGTH = 29;

/** Base addresses are 57 bytes (1 header + 28 payment + 28 stake). */
const BASE_ADDRESS_LENGTH = 57;

export type AddressCredentialKind = 'payment' | 'stake';

export interface DecodedAddress {
  /** Raw bytes of the address. */
  bytes: Buffer;
  /** Human-readable bech32 prefix (`'stake'`, `'addr'`, `'stake_test'`,
   *  `'addr_test'`). */
  prefix: string;
  /** The header byte. */
  header: number;
  /** Network id from the low nibble of the header. */
  networkId: number;
  /** True when the address is a reward (stake) address (header type 0xe / 0xf). */
  isStakeAddress: boolean;
  /** Whether the payment credential (or the only credential for stake /
   *  enterprise addresses) is a script hash. We reject script-credential
   *  logins so this is informational — the verifier short-circuits before
   *  hashing. */
  paymentIsScript: boolean;
  /** Whether the stake credential (only present for base addresses) is a
   *  script hash. */
  stakeIsScript: boolean;
  /** The 28-byte payment-credential bytes, when the address has one
   *  (base / enterprise). For pure reward / stake addresses this is the
   *  stake credential, copied here for convenience; callers should rely on
   *  `stakeCredential` for stake addresses. */
  paymentCredential?: Buffer;
  /** The 28-byte stake credential. Present for base and reward addresses. */
  stakeCredential?: Buffer;
}

/**
 * Decode a bech32-encoded Cardano address into its raw bytes and the
 * structural metadata the verifier needs.
 *
 * Throws if the input is not a valid bech32 string of the expected
 * length, or if the header byte indicates an unsupported address type
 * (Byron, pointer, future header values). The caller is expected to
 * catch and treat any throw as "rejected — bad address."
 */
export function decodeCardanoAddress(bech32String: string): DecodedAddress {
  // `bech32.decode` validates the checksum + character set; we relax the
  // length limit to fit base addresses.
  const decoded = bech32.decode(bech32String, BECH32_LIMIT);
  const bytes = Buffer.from(bech32.fromWords(decoded.words));
  if (bytes.length === 0) {
    throw new Error('Decoded address is empty');
  }
  const header = bytes[0]!;
  const high = (header & 0xf0) >>> 4;
  const networkId = header & 0x0f;

  // Header nibble → address type. See CIP-19 table reproduced in the
  // module header. We accept only the address types that actually serve
  // as user identities for login.
  let isStakeAddress = false;
  let paymentIsScript = false;
  let stakeIsScript = false;
  let expectedLength: number;
  let paymentCredential: Buffer | undefined;
  let stakeCredential: Buffer | undefined;

  switch (high) {
    case 0x0: // base: payment KEY + stake KEY
      paymentIsScript = false;
      stakeIsScript = false;
      expectedLength = BASE_ADDRESS_LENGTH;
      break;
    case 0x1: // base: payment SCRIPT + stake KEY
      paymentIsScript = true;
      stakeIsScript = false;
      expectedLength = BASE_ADDRESS_LENGTH;
      break;
    case 0x2: // base: payment KEY + stake SCRIPT
      paymentIsScript = false;
      stakeIsScript = true;
      expectedLength = BASE_ADDRESS_LENGTH;
      break;
    case 0x3: // base: payment SCRIPT + stake SCRIPT
      paymentIsScript = true;
      stakeIsScript = true;
      expectedLength = BASE_ADDRESS_LENGTH;
      break;
    case 0x6: // enterprise: payment KEY
      paymentIsScript = false;
      expectedLength = STAKE_OR_ENTERPRISE_LENGTH;
      break;
    case 0x7: // enterprise: payment SCRIPT
      paymentIsScript = true;
      expectedLength = STAKE_OR_ENTERPRISE_LENGTH;
      break;
    case 0xe: // reward (stake): stake KEY
      isStakeAddress = true;
      stakeIsScript = false;
      expectedLength = STAKE_OR_ENTERPRISE_LENGTH;
      break;
    case 0xf: // reward (stake): stake SCRIPT
      isStakeAddress = true;
      stakeIsScript = true;
      expectedLength = STAKE_OR_ENTERPRISE_LENGTH;
      break;
    default:
      // 0x4/0x5 (pointer addresses) are deprecated and never used by
      // wallets. 0x8..0xd are reserved. Reject anything else outright.
      throw new Error(`Unsupported address header type: 0x${high.toString(16)}`);
  }

  if (bytes.length !== expectedLength) {
    throw new Error(
      `Address length ${bytes.length} does not match expected ${expectedLength} for header 0x${header.toString(16).padStart(2, '0')}`,
    );
  }

  if (isStakeAddress) {
    stakeCredential = bytes.subarray(1, 1 + CREDENTIAL_LENGTH);
  } else if (expectedLength === BASE_ADDRESS_LENGTH) {
    paymentCredential = bytes.subarray(1, 1 + CREDENTIAL_LENGTH);
    stakeCredential = bytes.subarray(
      1 + CREDENTIAL_LENGTH,
      1 + CREDENTIAL_LENGTH * 2,
    );
  } else {
    // Enterprise address — only a payment credential.
    paymentCredential = bytes.subarray(1, 1 + CREDENTIAL_LENGTH);
  }

  return {
    bytes,
    prefix: decoded.prefix,
    header,
    networkId,
    isStakeAddress,
    paymentIsScript,
    stakeIsScript,
    ...(paymentCredential ? { paymentCredential } : {}),
    ...(stakeCredential ? { stakeCredential } : {}),
  };
}

/**
 * Normalise any Cardano address a user might paste — a payment/base address
 * (`addr1…`), an enterprise address, or a reward/stake address (`stake1…`) —
 * to its canonical STAKE (reward) bech32 address. That stake address is the
 * platform's user identity (the `walletAddress` key on the users table), so
 * this lets us match "is this person on the platform?" regardless of which
 * address form they were given.
 *
 * Returns null when the input can't be mapped to a key-hash stake identity:
 *   - not a valid/ supported address,
 *   - an enterprise address (no stake credential at all), or
 *   - a SCRIPT stake credential — those can't log in (wallet auth rejects
 *     script credentials), so admitting them as a committee member would just
 *     leave a permanently-inactive entry. Reject for consistency.
 */
export function normalizeToStakeAddress(input: string): string | null {
  let decoded: DecodedAddress;
  try {
    decoded = decodeCardanoAddress(input.trim());
  } catch {
    return null;
  }
  if (!decoded.stakeCredential) return null; // enterprise / no stake part
  if (decoded.stakeIsScript) return null; // script stake credential — can't log in
  // Reward-address header: 0xe_ = stake KEY, 0xf_ = stake SCRIPT; low nibble is
  // the network id (1 = mainnet, 0 = testnet).
  const header = ((decoded.stakeIsScript ? 0xf0 : 0xe0) | (decoded.networkId & 0x0f)) & 0xff;
  const stakeBytes = Buffer.concat([Buffer.from([header]), decoded.stakeCredential]);
  const hrp = decoded.networkId === 1 ? 'stake' : 'stake_test';
  return bech32.encode(hrp, bech32.toWords(stakeBytes), BECH32_LIMIT);
}

/**
 * Compute the 28-byte blake2b-224 hash of an Ed25519 public key — the
 * "credential" that Cardano addresses embed.
 *
 * CIP-19 uses blake2b-224 (28-byte output) for key hashes; the same
 * `blake2b` npm package we already use for anchor verification supports
 * arbitrary output lengths, so we just ask for 28 bytes.
 */
export function blake2b224(input: Buffer | Uint8Array): Buffer {
  const out = Buffer.alloc(CREDENTIAL_LENGTH);
  blake2b(CREDENTIAL_LENGTH).update(input).digest(out);
  return out;
}

/**
 * Verify that the given Ed25519 public key hashes to a credential the
 * supplied address actually contains.
 *
 * For stake / enterprise addresses we compare against the single
 * credential. For base addresses either the payment OR the stake
 * credential may match — CIP-30 `signData` callers commonly pass either
 * the payment address or the stake (reward) address and the wallet signs
 * with whichever key controls that credential. So a base address is
 * accepted if EITHER credential matches the hashed pubkey.
 *
 * Returns:
 *   - `'match'` — the pubkey's hash equals at least one key-credential
 *     in the address, and that credential is NOT a script hash.
 *   - `'script-credential'` — the matched credential slot is a script
 *     hash; reject (the platform doesn't support script-credentialed
 *     logins).
 *   - `'mismatch'` — the pubkey hash does not equal any key-credential
 *     in the address.
 */
export function publicKeyMatchesAddress(
  pubkey: Buffer,
  decoded: DecodedAddress,
): 'match' | 'script-credential' | 'mismatch' {
  const keyHash = blake2b224(pubkey);

  // Stake / reward address: single credential at bytes 1..28.
  if (decoded.isStakeAddress) {
    if (!decoded.stakeCredential) return 'mismatch';
    if (keyHash.equals(decoded.stakeCredential)) {
      return decoded.stakeIsScript ? 'script-credential' : 'match';
    }
    return 'mismatch';
  }

  // Base or enterprise address: either credential may match. Track
  // whether the MATCHING credential is a script — a key collision with
  // a script-credentialed slot is still a reject.
  if (decoded.paymentCredential && keyHash.equals(decoded.paymentCredential)) {
    return decoded.paymentIsScript ? 'script-credential' : 'match';
  }
  if (decoded.stakeCredential && keyHash.equals(decoded.stakeCredential)) {
    return decoded.stakeIsScript ? 'script-credential' : 'match';
  }
  return 'mismatch';
}
