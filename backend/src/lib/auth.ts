import { SignJWT, jwtVerify, type JWTPayload as JoseJWTPayload } from 'jose';
import * as crypto from 'crypto';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { decode as cborDecode, encode as cborEncode } from 'cbor-x';
import type { JWTPayload, UserRole, SessionType, OnChainRole } from './types';
import { putItem, getItem, deleteItem, tableNames } from './dynamodb';
import {
  decodeCardanoAddress,
  publicKeyMatchesAddress,
  blake2b224,
} from './cardanoAddress';
import { drepIdFromDRepKey } from './drepId';

// ---- Auth nonce DynamoDB record ----

interface AuthNonceItem extends Record<string, unknown> {
  nonce: string;
  kind: 'challenge' | 'mutation' | 'circuit' | 'drep_link';
  walletAddress: string;
  expiresAt: number; // epoch seconds for DynamoDB TTL
}

// The session-revocation store (Sprint 1) writes onto the same
// `tableNames.authNonces` table to avoid a new CDK table this sprint.
// Discriminated via `kind: 'session'` so the legacy nonce-kind invariants
// in this file never touch these records. `nonce` here is
// SHA-256(jti) in hex — a deterministic, opaque key.

// ---- Secrets Manager client (module-level, reused across invocations) ----

const secretsClient = new SecretsManagerClient({ region: process.env['SES_REGION'] ?? 'us-east-1' });
let _jwtSecretCache: string | null = null;

async function fetchSecretString(secretName: string): Promise<string> {
  const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));
  if (!result.SecretString) throw new Error(`Secret ${secretName} has no string value`);
  return result.SecretString;
}

async function getJwtSecretString(): Promise<string> {
  if (_jwtSecretCache) return _jwtSecretCache;
  const name = process.env['JWT_SECRET_NAME'] ?? process.env['JWT_SECRET'];
  if (!name) throw new Error('JWT_SECRET_NAME environment variable is not set');
  // If it looks like a raw secret value (not a secret name path), use it directly
  if (!name.includes('/')) {
    _jwtSecretCache = name;
    return name;
  }
  _jwtSecretCache = await fetchSecretString(name);
  return _jwtSecretCache;
}

async function getJwtSecret(): Promise<Uint8Array> {
  const secret = await getJwtSecretString();
  return new TextEncoder().encode(secret);
}

// ---- Challenge / Nonce ----

const CHALLENGE_TTL_MS = 5 * 60 * 1_000; // 5 minutes
const MUTATION_NONCE_TTL_MS = 5 * 60 * 1_000; // 5 minutes

/**
 * Generate a challenge nonce. Persists to DynamoDB so the verify call (which
 * may land on a different Lambda instance) can validate it.
 *
 * Single-use semantics are enforced by `attribute_not_exists(nonce)` on insert
 * and an atomic delete during validation.
 */
export async function generateChallenge(walletAddress: string): Promise<{
  nonce: string;
  message: string;
  expiresAt: string;
}> {
  const nonce = crypto.randomBytes(32).toString('hex');
  const expiresAtDate = new Date(Date.now() + CHALLENGE_TTL_MS);
  const expiresAtSec = Math.floor(expiresAtDate.getTime() / 1000);

  const item: AuthNonceItem = {
    nonce,
    kind: 'challenge',
    walletAddress,
    expiresAt: expiresAtSec,
  };

  // ConditionExpression ensures we never overwrite an existing nonce
  await putItem(tableNames.authNonces, item, 'attribute_not_exists(#nonce)', {
    '#nonce': 'nonce',
  });

  const message = buildSignMessage(nonce, walletAddress);

  return {
    nonce,
    message,
    expiresAt: expiresAtDate.toISOString(),
  };
}

export function buildSignMessage(nonce: string, walletAddress: string): string {
  // Stage-bound (defense in depth): a challenge signed on test.drep.tools can't
  // be replayed against prod even if the per-stage nonce tables were ever
  // unified. Issuer and verifier both build via this function, so they stay
  // byte-identical within a stage. The frontend signs the server-provided
  // message verbatim (useWalletAuth), so this is a backend-only change.
  const stage = process.env['STAGE'] ?? 'dev';
  return `drep-platform wants you to sign in (stage=${stage}):\n\nWallet: ${walletAddress}\nNonce: ${nonce}\n\nThis request will not trigger a blockchain transaction or cost any gas fees.`;
}

/**
 * Check whether a challenge nonce exists, is unexpired, and matches the
 * supplied wallet address. Does NOT delete the nonce — call `consumeChallenge`
 * after signature verification has succeeded.
 *
 * Splitting peek and consume prevents a DoS vector where an attacker who
 * knows a victim's freshly-issued nonce + walletAddress could burn it by
 * submitting a bogus signature.
 */
export async function peekChallenge(
  nonce: string,
  walletAddress: string,
): Promise<{ valid: boolean; reason?: string }> {
  const stored = await getItem<AuthNonceItem>(tableNames.authNonces, { nonce });
  if (!stored || stored.kind !== 'challenge') {
    return { valid: false, reason: 'Challenge nonce not found or already used' };
  }

  // DynamoDB TTL deletion can lag by minutes, so always re-check expiry here.
  if (Date.now() / 1000 > stored.expiresAt) {
    try {
      await deleteItem(tableNames.authNonces, { nonce });
    } catch {
      // Best-effort cleanup
    }
    return { valid: false, reason: 'Challenge nonce has expired' };
  }

  if (stored.walletAddress !== walletAddress) {
    return { valid: false, reason: 'Challenge nonce does not match wallet address' };
  }

  return { valid: true };
}

/**
 * Atomically consume (delete) a challenge nonce. Use only after the signature
 * has been verified. The conditional delete ensures two concurrent verify
 * calls cannot both succeed against the same nonce.
 */
export async function consumeChallenge(
  nonce: string,
): Promise<{ valid: boolean; reason?: string }> {
  try {
    await deleteItem(
      tableNames.authNonces,
      { nonce },
      'attribute_exists(#nonce)',
      { '#nonce': 'nonce' },
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
      return { valid: false, reason: 'Challenge nonce not found or already used' };
    }
    throw err;
  }
  return { valid: true };
}

/**
 * @deprecated Use peekChallenge + consumeChallenge with signature verification
 * between them. Kept for backward compatibility with any caller that does not
 * verify signatures (none exist in this codebase as of writing).
 */
export async function validateChallenge(
  nonce: string,
  walletAddress: string,
): Promise<{ valid: boolean; reason?: string }> {
  const peek = await peekChallenge(nonce, walletAddress);
  if (!peek.valid) return peek;
  return consumeChallenge(nonce);
}

// ---- Wallet Signature Verification ----

export interface WalletSignature {
  signature: string; // CIP-30 DataSignature.signature (CBOR hex)
  key: string; // CIP-30 DataSignature.key (CBOR hex)
}

/**
 * Verifies a CIP-30 wallet signature AND binds the verified public key to
 * the claimed wallet address.
 *
 * CIP-30 wallet.signData() returns a DataSignature { signature, key } where:
 *   - signature: CBOR hex of COSE_Sign1 [protected_header_bytes, {}, payload_bytes, sig_bytes]
 *   - key: CBOR hex of COSE_Key map { 1: 1 (OKP), 3: -8 (EdDSA), -1: 6 (Ed25519), -2: pubkey_bytes }
 *
 * # The bug this guards against (P0-1, 2026-05-28 audit)
 *
 * The original implementation verified that the Ed25519 signature was valid
 * for the COSE_Key pubkey, and that the COSE_Sign1 payload matched the
 * expected challenge — but never bound that pubkey to the claimed
 * `walletAddress`. An attacker could sign the (victim-addressed) challenge
 * with THEIR OWN key, ship the resulting DataSignature with the victim's
 * address as the `walletAddress` body field, and the verifier would accept
 * it. Outcome: arbitrary account takeover for any wallet whose address the
 * attacker could observe (i.e. all of them on a public governance platform).
 *
 * # Defense layers (in order of trust)
 *
 *   1. **Pubkey → address credential binding (LOAD-BEARING).** We
 *      blake2b-224 the COSE_Key pubkey and check that the resulting 28-byte
 *      key hash matches one of the credentials embedded in the claimed
 *      bech32 address (per CIP-19). For a base address, either the payment
 *      OR stake credential may match; for a reward/stake address, only the
 *      stake credential. Script-credential addresses are rejected outright
 *      — the platform has no contract-wallet UX. Mismatch = reject.
 *
 *   2. **CIP-8 protected-header address cross-check (defense-in-depth).**
 *      CIP-30 `signData` requires the wallet to include the signing address
 *      in the COSE_Sign1 protected header as a CBOR map entry under the
 *      string key `"address"`, with the raw address bytes as the value.
 *      We decode and compare against `decoded.bytes` from step 1. Mismatch
 *      = reject. When the header field is absent (some older wallet builds
 *      omit it), we skip the cross-check and rely on step 1. Step 1 is
 *      always enough on its own — an attacker cannot forge a valid
 *      Ed25519 signature with a key whose hash falls inside someone else's
 *      address.
 *
 * # References
 *
 *   - CIP-8  https://cips.cardano.org/cips/cip8/
 *   - CIP-19 https://cips.cardano.org/cips/cip19/
 *   - CIP-30 https://cips.cardano.org/cips/cip30/  (search "signData" — the
 *           returned COSE_Sign1's protected header includes the `address`
 *           field per the spec's "DataSignature" type).
 *   - COSE   RFC 8152  (COSE_Sign1 structure, Sig_Structure encoding).
 *
 * Oracle consultation: NO subagent available in this session; implemented
 * per the CIP-8 / CIP-30 spec text above and made step 1 the load-bearing
 * check so that security never depends on the optional header parse.
 */
export function verifyWalletSignature(
  walletAddress: string,
  message: string,
  walletSig: WalletSignature,
): { valid: boolean; reason?: string } {
  const core = verifyCoseSign1Core(message, walletSig);
  if (!core.valid) return { valid: false, reason: core.reason };

  // --- 5. Bind the verified pubkey to the claimed wallet address ---
  // This is the load-bearing security check. Without it, an attacker can
  // present a valid COSE_Sign1 signed by THEIR key and claim ANY
  // walletAddress — the prior steps would all pass. See the function-
  // header docblock for the full attack story.
  //
  // We catch decode errors so a malformed/unsupported address rejects
  // cleanly (4xx-equivalent) rather than 5xx-ing through the handler's
  // generic catch.
  let decoded;
  try {
    decoded = decodeCardanoAddress(walletAddress);
  } catch {
    return {
      valid: false,
      reason: 'Claimed wallet address is malformed or unsupported',
    };
  }

  const matchResult = publicKeyMatchesAddress(core.pubkeyBytes, decoded);
  if (matchResult === 'mismatch') {
    return {
      valid: false,
      reason: 'Public key does not match the claimed wallet address',
    };
  }
  if (matchResult === 'script-credential') {
    return {
      valid: false,
      reason: 'Script-credential addresses are not supported for login',
    };
  }
  // matchResult === 'match' — fall through.

  // --- 6. (Defense-in-depth) Cross-check the protected-header address.
  //
  // CIP-30 `signData` puts the signing address in the COSE_Sign1
  // protected header (a bstr-wrapped CBOR map) under the string key
  // "address", with the raw address bytes as the value. We decode the
  // header and, when the address field is present, require it to equal
  // `decoded.bytes`. If the field is absent (some older wallet builds
  // omit it), we skip this check — step 5 above is already authoritative.
  //
  // Implementation notes:
  //   - The protected header is itself a CBOR-encoded bstr; an empty
  //     header (length 0) is valid CBOR and decodes to nothing. We
  //     treat an empty header as "no address claim" and skip.
  //   - `cbor-x` may decode the header map as a `Map<string, unknown>`
  //     OR as a plain object (its behaviour depends on internal heuristics
  //     about which keys appeared). We handle both shapes the same way
  //     the COSE_Key extraction above does.
  //   - Any decode failure on the header is logged at debug level and
  //     skipped — it MUST NOT cause a hard fail, because step 5 already
  //     bound the pubkey to the address. A malformed header from a
  //     buggy wallet would otherwise lock a legitimate user out.
  if (core.protectedBytes.length > 0) {
    try {
      const headerDecoded = cborDecode(core.protectedBytes);
      let headerAddressBytes: Buffer | undefined;
      if (headerDecoded instanceof Map) {
        const raw = headerDecoded.get('address');
        if (Buffer.isBuffer(raw)) headerAddressBytes = raw;
        else if (raw instanceof Uint8Array) headerAddressBytes = Buffer.from(raw);
      } else if (typeof headerDecoded === 'object' && headerDecoded !== null) {
        const headerMap = headerDecoded as Record<string, unknown>;
        const raw = headerMap['address'];
        if (Buffer.isBuffer(raw)) headerAddressBytes = raw;
        else if (raw instanceof Uint8Array) headerAddressBytes = Buffer.from(raw);
      }
      if (headerAddressBytes && !headerAddressBytes.equals(decoded.bytes)) {
        return {
          valid: false,
          reason:
            'COSE_Sign1 protected-header address does not match the claimed wallet address',
        };
      }
      // headerAddressBytes === undefined → no address claim in the
      // header; step 5 is authoritative.
    } catch (err) {
      // Don't fail closed on a header decode error — step 5 already
      // bound the pubkey to the address.
      console.debug(
        'verifyWalletSignature: protected header decode failed; relying on credential binding alone:',
        err,
      );
    }
  }

  return { valid: true };
}

/**
 * Internal shared core for COSE_Sign1 verification — extracted so the
 * CIP-30 wallet-login path AND the CIP-95 DRep-key proof-of-control path
 * never drift on the cryptographic primitive.
 *
 * What this does (and ONLY this):
 *   1. CBOR-decode the COSE_Sign1 array [protected, _, payload, sig].
 *   2. Confirm the payload bytes equal the expected `message` (UTF-8).
 *   3. Extract the 32-byte Ed25519 public key from the COSE_Key (`key`).
 *   4. Reconstruct the Sig_Structure and Ed25519-verify the signature.
 *
 * What this DOES NOT do:
 *   - Bind the pubkey to any address / credential. The CALLER does that
 *     binding step using a path-specific check (wallet-address credential
 *     match for login, drepKey hash equality for DRep proof).
 *   - Validate the protected-header `address` field. That's an
 *     address-credential cross-check; for the DRep path there's no address
 *     so it's not meaningful, and for the login path it's still done in
 *     `verifyWalletSignature`. Either way, this core stays neutral.
 *
 * On success returns the extracted pubkey + protected-header bytes so the
 * caller can run path-specific cross-checks against them. On failure the
 * `reason` is human-readable (suitable for surfacing to the caller as a
 * 401/400 cause).
 */
function verifyCoseSign1Core(
  message: string,
  walletSig: WalletSignature,
):
  | { valid: false; reason: string }
  | { valid: true; pubkeyBytes: Buffer; protectedBytes: Buffer } {
  if (!walletSig.signature || typeof walletSig.signature !== 'string') {
    return { valid: false, reason: 'Missing or invalid signature field' };
  }
  if (!walletSig.key || typeof walletSig.key !== 'string') {
    return { valid: false, reason: 'Missing or invalid key field' };
  }
  if (!/^[0-9a-fA-F]+$/.test(walletSig.signature)) {
    return { valid: false, reason: 'Signature is not valid hex' };
  }
  if (!/^[0-9a-fA-F]+$/.test(walletSig.key)) {
    return { valid: false, reason: 'Key is not valid hex' };
  }
  // Bound the inputs before CBOR-decoding them — a COSE_Sign1 over a short
  // message is a few hundred bytes and a COSE_Key is ~100; reject pathological
  // megabyte payloads early (cheap CPU-burn guard).
  if (walletSig.signature.length > 4096 || walletSig.key.length > 1024) {
    return { valid: false, reason: 'Signature or key is implausibly large' };
  }

  try {
    // --- 1. Decode COSE_Sign1: [protected_bstr, unprotected, payload_bstr, sig_bstr] ---
    const sigBytes = Buffer.from(walletSig.signature, 'hex');
    const coseSign1 = cborDecode(sigBytes) as unknown[];
    if (!Array.isArray(coseSign1) || coseSign1.length !== 4) {
      return { valid: false, reason: 'Invalid COSE_Sign1 structure' };
    }

    const [protectedBytes, , payloadBytes, sigBuf] = coseSign1 as [
      Buffer,
      unknown,
      Buffer,
      Buffer,
    ];

    if (!Buffer.isBuffer(protectedBytes) || !Buffer.isBuffer(payloadBytes) || !Buffer.isBuffer(sigBuf)) {
      return { valid: false, reason: 'Unexpected COSE_Sign1 field types' };
    }

    // --- 2. Verify the payload matches the expected sign message ---
    const payloadStr = payloadBytes.toString('utf8');
    if (payloadStr !== message) {
      return { valid: false, reason: 'Signature payload does not match expected message' };
    }

    // --- 3. Extract public key from COSE_Key ---
    const keyBytes = Buffer.from(walletSig.key, 'hex');
    const coseKey = cborDecode(keyBytes) as Map<number, unknown>;
    // COSE_Key map key -2 holds the raw x/pubkey bytes for OKP
    let pubkeyBytes: Buffer | undefined;
    if (coseKey instanceof Map) {
      const raw = coseKey.get(-2);
      if (Buffer.isBuffer(raw)) pubkeyBytes = raw;
      else if (raw instanceof Uint8Array) pubkeyBytes = Buffer.from(raw);
    } else if (typeof coseKey === 'object' && coseKey !== null) {
      // Some CBOR decoders return plain objects with numeric string keys
      const keyMap = coseKey as Record<string, unknown>;
      const raw = keyMap['-2'];
      if (Buffer.isBuffer(raw)) pubkeyBytes = raw;
      else if (raw instanceof Uint8Array) pubkeyBytes = Buffer.from(raw);
    }
    if (!pubkeyBytes || pubkeyBytes.length !== 32) {
      return { valid: false, reason: 'Could not extract 32-byte Ed25519 public key from COSE_Key' };
    }

    // --- 4. Reconstruct Sig_Structure and verify Ed25519 signature ---
    // Sig_Structure = ["Signature1", protected_bstr, external_aad(empty), payload_bstr]
    const sigStructure = cborEncode(["Signature1", protectedBytes, Buffer.alloc(0), payloadBytes]);

    const publicKey = crypto.createPublicKey({
      key: Buffer.concat([
        // SubjectPublicKeyInfo DER header for Ed25519 (RFC 8410)
        Buffer.from('302a300506032b6570032100', 'hex'),
        pubkeyBytes,
      ]),
      format: 'der',
      type: 'spki',
    });

    const isValid = crypto.verify(null, sigStructure, publicKey, sigBuf);
    if (!isValid) {
      return { valid: false, reason: 'Ed25519 signature verification failed' };
    }

    return { valid: true, pubkeyBytes, protectedBytes };
  } catch (err) {
    console.error('verifyCoseSign1Core error:', err);
    return { valid: false, reason: 'Signature verification threw an error' };
  }
}

/**
 * Verify a CIP-95 `signData` proof-of-control for a DRep key.
 *
 * # The problem this solves
 *
 * A DRep public key is on-chain, public information. Knowing it does NOT
 * prove the holder has the corresponding private key. To link a wallet to
 * a DRep we need a fresh signature, made with the DRep key, over a
 * server-issued nonce that embeds the drep id (so the signed bytes can't
 * be swapped between victims).
 *
 * # What this function checks
 *
 *   1. Run `verifyCoseSign1Core` — confirms the COSE_Sign1 payload bytes
 *      equal `message` AND that the signature is a valid Ed25519 sig over
 *      the Sig_Structure by the COSE_Key pubkey.
 *   2. Bind the COSE_Key pubkey to the CLAIMED `drepKey`: derive a drep id
 *      from each and require equality. Equivalently, the blake2b-224 hash
 *      of the COSE_Key pubkey must equal the blake2b-224 hash of the
 *      claimed `drepKey`. We compare via `drepIdFromDRepKey` (the same
 *      derivation used for the `users.drepId` write) so this function and
 *      the caller share the identity-derivation truth.
 *
 *   We deliberately do NOT do an address-credential check or a
 *   protected-header address check here. There is no address — the proof
 *   is the pubkey↔drepKey identity, full stop. CIP-95 wallets vary in
 *   whether they include an `address` field in the protected header
 *   (some put the DRep enterprise address, some omit), and treating that
 *   as load-bearing would lock out conformant wallets.
 *
 * # Inputs
 *
 *   - `drepKey`: hex of the 32-byte Ed25519 DRep public key the user
 *     claims to control (returned by `cip95.getPubDRepKey()`).
 *   - `message`: the exact UTF-8 string the wallet signed — the message
 *     this server issued via `generateDRepLinkNonce`.
 *   - `walletSig`: `{ signature, key }` — CIP-95 `signData`'s return,
 *     COSE_Sign1 and COSE_Key in hex respectively.
 */
export function verifyDRepKeySignature(
  drepKey: string,
  message: string,
  walletSig: WalletSignature,
): { valid: boolean; reason?: string } {
  if (!/^[0-9a-fA-F]{64}$/.test(drepKey)) {
    return { valid: false, reason: 'drepKey must be a 32-byte hex Ed25519 public key' };
  }

  const core = verifyCoseSign1Core(message, walletSig);
  if (!core.valid) return { valid: false, reason: core.reason };

  // Bind the COSE_Key pubkey to the CLAIMED drepKey by deriving the drep
  // id from each and requiring equality. Cheaper alternatives (direct hash
  // compare) would also work but routing through drepIdFromDRepKey keeps
  // the truth in one place — the same helper the handler will use to
  // compute the value it writes to users.drepId.
  let claimedDRepId: string;
  let signingDRepId: string;
  try {
    claimedDRepId = drepIdFromDRepKey(drepKey);
    signingDRepId = drepIdFromDRepKey(core.pubkeyBytes.toString('hex'));
  } catch (err) {
    console.error('verifyDRepKeySignature drep id derivation failed:', err);
    return { valid: false, reason: 'Failed to derive drep id from key' };
  }

  if (claimedDRepId !== signingDRepId) {
    return {
      valid: false,
      reason: 'Signing key does not match the claimed DRep key',
    };
  }

  // Belt-and-braces: hash equality (the relationship drep id implies).
  // If this ever drifts from the id check above, both fail closed.
  const claimedHash = blake2b224(Buffer.from(drepKey, 'hex'));
  const signingHash = blake2b224(core.pubkeyBytes);
  if (!claimedHash.equals(signingHash)) {
    return {
      valid: false,
      reason: 'Signing key hash does not match the claimed DRep key hash',
    };
  }

  return { valid: true };
}

// ---- JWT ----

const SESSION_DURATIONS: Record<SessionType, number> = {
  normal: 7 * 24 * 60 * 60, // 7 days in seconds
  remember_me: 30 * 24 * 60 * 60, // 30 days in seconds
};

/**
 * Issue a signed JWT for an authenticated wallet session.
 *
 * `registeredDrepId` is the wallet's REGISTERED-DRep id (set when this
 * wallet ran the `/drep/register` flow). It is NOT the DRep the wallet
 * delegates to — those are two different on-chain concepts; conflating
 * them caused the "my wallet's chosen DRep isn't recognized" bug.
 *
 * Renamed from `drepId` on 2026-05-27. See `verifyJWT` for backward-
 * compatibility behavior with tokens issued before this rename.
 *
 * `extra` carries optional Sprint-1 additions — `onChainRoles[]` (a
 * parallel claim alongside `roles`, proven via the on-chain login flow)
 * and `jti` (a unique session id used to drive per-session revocation
 * via the identity session store). Both are additive: pre-Sprint-1
 * callers (the legacy CIP-30 verify handler) pass nothing and tokens
 * keep the prior shape exactly. Pre-Sprint-1 tokens still verify because
 * `verifyJWT` reads both claims as optional.
 */
export async function issueJWT(
  walletAddress: string,
  roles: UserRole[],
  sessionType: SessionType,
  registeredDrepId?: string,
  tokenVersion = 0,
  extra?: { onChainRoles?: OnChainRole[]; jti?: string; personId?: string },
): Promise<{ token: string; expiresAt: string }> {
  const secret = await getJwtSecret();
  const durationSecs = SESSION_DURATIONS[sessionType];
  const expiresAt = new Date(Date.now() + durationSecs * 1000);

  // onChainRoles is a parallel claim, NOT folded into `roles`. When absent
  // or empty, we omit the field rather than writing `[]` — legacy tokens
  // round-trip with identical bytes that way.
  const onChainRoles = extra?.onChainRoles;
  const hasOnChainRoles = Array.isArray(onChainRoles) && onChainRoles.length > 0;

  // Decision #3 — `personId` is a parallel claim like `onChainRoles`. Omit
  // when absent so legacy + pre-Decision-3 tokens stay byte-identical.
  const personId =
    typeof extra?.personId === 'string' && extra.personId.length > 0
      ? extra.personId
      : undefined;

  const payload: Record<string, unknown> = {
    roles,
    sessionType,
    tokenVersion,
    ...(registeredDrepId ? { registeredDrepId } : {}),
    ...(hasOnChainRoles ? { onChainRoles } : {}),
    ...(personId ? { personId } : {}),
  };

  let builder = new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(walletAddress)
    .setIssuedAt()
    .setExpirationTime(expiresAt);
  if (extra?.jti) {
    builder = builder.setJti(extra.jti);
  }
  const token = await builder.sign(secret);

  return { token, expiresAt: expiresAt.toISOString() };
}

export async function verifyJWT(token: string): Promise<JWTPayload> {
  const secret = await getJwtSecret();
  // Pin HS256 explicitly — never let the token's own `alg` header pick the
  // verification algorithm (alg-confusion defense-in-depth).
  const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });

  // Backward-compatibility shim: tokens issued before 2026-05-27 carry
  // the registered-DRep id under the legacy field name `drepId`; tokens
  // issued on or after carry it under `registeredDrepId`. We accept
  // either during the 7-day rotation window — the new field wins when
  // both are present. This branch can be removed after 2026-06-03
  // (one normal-session TTL after the rename ships); by then every
  // legacy token will have expired naturally. `remember_me` sessions
  // (30 days) are not a concern: they don't survive a code redeploy
  // unscathed if we tighten validation, and the legacy fallback is
  // free to keep — but the comment above is the deletion trigger.
  const josePayload = payload as JoseJWTPayload & {
    roles: UserRole[];
    sessionType: SessionType;
    registeredDrepId?: string;
    tokenVersion?: number;
    drepId?: string; // legacy — remove after 2026-06-03
    onChainRoles?: OnChainRole[];
    personId?: string;
  };

  if (!josePayload.sub) {
    throw new Error('JWT payload missing sub claim');
  }
  if (!Array.isArray(josePayload.roles)) {
    throw new Error('JWT payload missing roles claim');
  }
  if (!josePayload.sessionType) {
    throw new Error('JWT payload missing sessionType claim');
  }

  // Prefer the new field; fall back to legacy for in-flight tokens.
  const registeredDrepId = josePayload.registeredDrepId ?? josePayload.drepId;

  // Sprint 1 additions: read defensively so a pre-Sprint-1 token (no
  // onChainRoles claim, no jti) continues to verify and surfaces as
  // `onChainRoles: []`. The authorizer's revocation path treats a missing
  // `jti` as "not granularly revocable" and falls back to `tokenVersion`.
  const onChainRoles = Array.isArray(josePayload.onChainRoles)
    ? josePayload.onChainRoles.filter(
        (r): r is OnChainRole => r === 'drep' || r === 'spo' || r === 'cc' || r === 'proposer',
      )
    : [];

  return {
    sub: josePayload.sub,
    roles: josePayload.roles,
    sessionType: josePayload.sessionType,
    registeredDrepId,
    tokenVersion: typeof josePayload.tokenVersion === 'number' ? josePayload.tokenVersion : 0,
    onChainRoles,
    ...(typeof josePayload.jti === 'string' && josePayload.jti.length > 0
      ? { jti: josePayload.jti }
      : {}),
    // Decision #3 — `personId` is optional on read. Pre-Decision-3
    // tokens omit it; downstream handlers fall back to resolving via
    // the on-chain credential (`identityKey` → `identity_links`).
    ...(typeof josePayload.personId === 'string' && josePayload.personId.length > 0
      ? { personId: josePayload.personId }
      : {}),
    iat: josePayload.iat ?? 0,
    exp: josePayload.exp ?? 0,
  };
}

/**
 * Per-stage session-cookie name. prod keeps `access_token`; every other stage
 * gets `access_token_<stage>` (e.g. `access_token_test`). This prevents a
 * broader parent-domain cookie (a `.drep.tools` cookie set by prod) from
 * shadowing a stage cookie on a subdomain — the test authorizer only ever
 * reads `access_token_test`, signed by the test secret. (Per-stage *domains*
 * alone don't fix this: a `.drep.tools` cookie is still sent to
 * api.test.drep.tools.)
 */
export function cookieName(): string {
  const stage = process.env['STAGE'] ?? 'dev';
  return stage === 'prod' ? 'access_token' : `access_token_${stage}`;
}

/**
 * Stage-stamped cookie name for the NEW on-chain login (Sprint 1) —
 * parallel to `cookieName()` so the legacy CIP-30 cookie keeps its
 * exact name (`access_token` / `access_token_<stage>`) and the new
 * on-chain session lives at `access_token_onchain` /
 * `access_token_onchain_<stage>`. Two cookies CAN coexist on the same
 * subdomain — the authorizer prefers the legacy one first (see
 * `extractTokenFromCookie`), and an on-chain-only login still works
 * because the new cookie is read by `extractOnChainTokenFromCookie`
 * below. The stage stamping mirrors the legacy rationale: a broader
 * `.drep.tools` cookie set by prod must not shadow a stage cookie on
 * a test subdomain.
 */
export function onChainCookieName(): string {
  const stage = process.env['STAGE'] ?? 'dev';
  return stage === 'prod' ? 'access_token_onchain' : `access_token_onchain_${stage}`;
}

/**
 * Extract a JWT for the on-chain session cookie.
 *
 * The on-chain login issues a JWT under `access_token_onchain[_<stage>]`
 * — parallel to the legacy `access_token[_<stage>]` cookie — so a wallet
 * may hold both simultaneously without either shadowing the other. This
 * helper exists so authorizer code can look up the on-chain token
 * independently of the legacy one.
 */
export function extractOnChainTokenFromCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${onChainCookieName()}=([^;]+)`));
  return match ? (match[1] ?? null) : null;
}

/**
 * Build the Set-Cookie header for a successful on-chain login.
 *
 * Mirrors `buildSetCookieHeader` (legacy) but writes to the on-chain
 * cookie name. The cookie domain (when configured) is shared so the SPA
 * at https://drep.tools authenticates against https://api.drep.tools.
 */
export function buildOnChainSetCookieHeader(token: string, sessionType: SessionType): string {
  const maxAge = SESSION_DURATIONS[sessionType];
  const cookieDomain = process.env['COOKIE_DOMAIN'];
  return [
    `${onChainCookieName()}=${token}`,
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Path=/',
    ...(cookieDomain ? [`Domain=${cookieDomain}`] : []),
  ].join('; ');
}

/** Build a clear-cookie header for the on-chain session — used by logout. */
export function buildOnChainClearCookieHeader(): string {
  const cookieDomain = process.env['COOKIE_DOMAIN'];
  const parts = [
    `${onChainCookieName()}=`,
    'Max-Age=0',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Path=/',
  ];
  if (cookieDomain) parts.push(`Domain=${cookieDomain}`);
  return parts.join('; ');
}

export function extractTokenFromCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${cookieName()}=([^;]+)`));
  return match ? (match[1] ?? null) : null;
}

/**
 * Build the Set-Cookie header for a successful auth.
 *
 * If COOKIE_DOMAIN is set (e.g. ".drep.tools"), the cookie is scoped to the
 * registrable domain so the SPA at https://drep.tools can authenticate
 * against the API at https://api.drep.tools. Without a domain, the cookie
 * is bound to the exact response origin, which still works for same-site
 * XHR but won't survive subdomain redirects.
 */
export function buildSetCookieHeader(token: string, sessionType: SessionType): string {
  const maxAge = SESSION_DURATIONS[sessionType];
  const cookieDomain = process.env['COOKIE_DOMAIN'];
  return [
    `${cookieName()}=${token}`,
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Path=/',
    ...(cookieDomain ? [`Domain=${cookieDomain}`] : []),
  ].join('; ');
}

export function buildClearCookieHeader(): string {
  const cookieDomain = process.env['COOKIE_DOMAIN'];
  const parts = [`${cookieName()}=`, 'Max-Age=0', 'HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/'];
  if (cookieDomain) parts.push(`Domain=${cookieDomain}`);
  return parts.join('; ');
}

// ---- Mutation nonce ----

export async function generateMutationNonce(walletAddress: string): Promise<{
  nonce: string;
  message: string;
  expiresAt: string;
}> {
  const nonce = crypto.randomBytes(16).toString('hex');
  const expiresAtDate = new Date(Date.now() + MUTATION_NONCE_TTL_MS);
  const expiresAtSec = Math.floor(expiresAtDate.getTime() / 1000);

  const item: AuthNonceItem = {
    nonce,
    kind: 'mutation',
    walletAddress,
    expiresAt: expiresAtSec,
  };

  await putItem(tableNames.authNonces, item, 'attribute_not_exists(#nonce)', {
    '#nonce': 'nonce',
  });

  // IMPORTANT: keep this format identical to `buildMutationMessage` below.
  // The verifier reconstructs the message from { walletAddress, nonce } and
  // both the issuer and verifier MUST produce byte-identical strings or
  // signatures will never match. Expiry is NOT included in the signed
  // message — it's enforced server-side via the DynamoDB record (TTL +
  // explicit expiry check), so the wallet doesn't need to attest to it.
  const message = buildMutationMessage(nonce, walletAddress);

  return { nonce, message, expiresAt: expiresAtDate.toISOString() };
}

/** Single source of truth for the mutation-signing message format.
 *  The issuer (`generateMutationNonce`) and verifier (`comments/create`,
 *  any future mutation handler) BOTH call this. */
export function buildMutationMessage(nonce: string, walletAddress: string): string {
  return `drep-platform mutation authorization:\n\nWallet: ${walletAddress}\nNonce: ${nonce}`;
}

export async function validateMutationNonce(
  nonce: string,
  walletAddress: string,
): Promise<{ valid: boolean; reason?: string }> {
  const stored = await getItem<AuthNonceItem>(tableNames.authNonces, { nonce });
  if (!stored || stored.kind !== 'mutation') {
    return { valid: false, reason: 'Mutation nonce not found or already used' };
  }
  if (Date.now() / 1000 > stored.expiresAt) {
    try {
      await deleteItem(tableNames.authNonces, { nonce });
    } catch {
      // Best-effort cleanup
    }
    return { valid: false, reason: 'Mutation nonce has expired' };
  }
  if (stored.walletAddress !== walletAddress) {
    return { valid: false, reason: 'Mutation nonce does not match wallet address' };
  }
  try {
    await deleteItem(
      tableNames.authNonces,
      { nonce },
      'attribute_exists(#nonce)',
      { '#nonce': 'nonce' },
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
      return { valid: false, reason: 'Mutation nonce not found or already used' };
    }
    throw err;
  }
  return { valid: true };
}

// ---- DRep-link proof-of-control nonce ----

const DREP_LINK_NONCE_TTL_MS = 5 * 60 * 1_000; // 5 minutes

/**
 * Build the message a wallet must sign with the CIP-95 DRep key to prove
 * it controls that key.
 *
 * # Why the drep id is embedded in the message
 *
 * Without it, the proof reduces to "I can sign some bytes with SOME DRep
 * key" — sufficient to prove control of A key, but not of the SPECIFIC
 * key the caller is claiming. An attacker who controls DRep B could sign
 * a nonce-only message with key B, then submit it claiming victim
 * DRep A. The handler would consume the nonce, verify the signature, and
 * — without the embed — would have no way to refuse the swap before the
 * downstream `drepKey` body field is acted on.
 *
 * With the drep id IN the signed bytes, that swap is detected at the
 * signature-payload-equality check: the message the attacker signed
 * contains DRep B's id, but the verifier is checking it against the
 * server-issued message which embeds the caller-supplied `drepKey`'s
 * derived id (DRep A). Payload mismatch → reject.
 *
 * # Why this format
 *
 *   - Stage-bound: `(stage=test)` etc. — a test signature can't be
 *     replayed against prod even if nonce tables were unified.
 *   - Two-pronged identity: BOTH the wallet stake address (the platform
 *     identity) AND the DRep id appear, so the message attests "this
 *     wallet is claiming control of this DRep" — readable to the user in
 *     a wallet signing dialog AND verifiable server-side.
 *   - Nonce: a single-use server-issued secret pins the proof to one
 *     verification attempt.
 *
 * Issuer (`generateDRepLinkNonce`) and verifier (`drep/link` handler)
 * BOTH call this helper, so the bytes stay identical.
 */
export function buildDRepLinkMessage(
  nonce: string,
  walletAddress: string,
  drepId: string,
): string {
  const stage = process.env['STAGE'] ?? 'dev';
  return (
    `drep-platform DRep proof-of-control (stage=${stage}):\n\n` +
    `Wallet: ${walletAddress}\n` +
    `DRep: ${drepId}\n` +
    `Nonce: ${nonce}`
  );
}

/**
 * Issue a single-use nonce for DRep proof-of-control. The wallet signs the
 * returned `message` with the CIP-95 DRep key; the verifier reconstructs
 * the message from { walletAddress, drepId, nonce } and rejects on any
 * mismatch.
 *
 * Distinct `kind` from the login challenge / mutation nonces so a leaked
 * challenge can't be cross-used here (and vice-versa).
 */
export async function generateDRepLinkNonce(
  walletAddress: string,
  drepId: string,
): Promise<{ nonce: string; message: string; expiresAt: string }> {
  const nonce = crypto.randomBytes(16).toString('hex');
  const expiresAtDate = new Date(Date.now() + DREP_LINK_NONCE_TTL_MS);
  const expiresAtSec = Math.floor(expiresAtDate.getTime() / 1000);

  const item: AuthNonceItem = {
    nonce,
    kind: 'drep_link',
    walletAddress,
    expiresAt: expiresAtSec,
  };

  await putItem(tableNames.authNonces, item, 'attribute_not_exists(#nonce)', {
    '#nonce': 'nonce',
  });

  const message = buildDRepLinkMessage(nonce, walletAddress, drepId);
  return { nonce, message, expiresAt: expiresAtDate.toISOString() };
}

/**
 * Peek + atomically consume a DRep-link nonce bound to `walletAddress`.
 * Same shape as `validateMutationNonce` — splits peek and consume in one
 * call because the caller has no reason to check existence without also
 * consuming on success.
 *
 * The conditional delete ensures two concurrent link attempts can never
 * both succeed against the same nonce.
 */
export async function validateDRepLinkNonce(
  nonce: string,
  walletAddress: string,
): Promise<{ valid: boolean; reason?: string }> {
  const stored = await getItem<AuthNonceItem>(tableNames.authNonces, { nonce });
  if (!stored || stored.kind !== 'drep_link') {
    return { valid: false, reason: 'DRep-link nonce not found or already used' };
  }
  if (Date.now() / 1000 > stored.expiresAt) {
    try {
      await deleteItem(tableNames.authNonces, { nonce });
    } catch {
      // Best-effort cleanup
    }
    return { valid: false, reason: 'DRep-link nonce has expired' };
  }
  if (stored.walletAddress !== walletAddress) {
    return { valid: false, reason: 'DRep-link nonce does not match wallet address' };
  }
  try {
    await deleteItem(
      tableNames.authNonces,
      { nonce },
      'attribute_exists(#nonce)',
      { '#nonce': 'nonce' },
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
      return { valid: false, reason: 'DRep-link nonce not found or already used' };
    }
    throw err;
  }
  return { valid: true };
}

// ---- Hash helpers ----

export function hashValue(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
