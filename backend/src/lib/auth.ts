import { SignJWT, jwtVerify, type JWTPayload as JoseJWTPayload } from 'jose';
import * as crypto from 'crypto';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { decode as cborDecode, encode as cborEncode } from 'cbor-x';
import type { JWTPayload, UserRole, SessionType } from './types';
import { putItem, getItem, deleteItem, tableNames } from './dynamodb';
import {
  decodeCardanoAddress,
  publicKeyMatchesAddress,
} from './cardanoAddress';

// ---- Auth nonce DynamoDB record ----

interface AuthNonceItem extends Record<string, unknown> {
  nonce: string;
  kind: 'challenge' | 'mutation' | 'circuit';
  walletAddress: string;
  expiresAt: number; // epoch seconds for DynamoDB TTL
}

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
  return `drep-platform wants you to sign in:\n\nWallet: ${walletAddress}\nNonce: ${nonce}\n\nThis request will not trigger a blockchain transaction or cost any gas fees.`;
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

    const matchResult = publicKeyMatchesAddress(pubkeyBytes, decoded);
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
    if (protectedBytes.length > 0) {
      try {
        const headerDecoded = cborDecode(protectedBytes);
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
  } catch (err) {
    console.error('verifyWalletSignature error:', err);
    return { valid: false, reason: 'Signature verification threw an error' };
  }
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
 */
export async function issueJWT(
  walletAddress: string,
  roles: UserRole[],
  sessionType: SessionType,
  registeredDrepId?: string,
): Promise<{ token: string; expiresAt: string }> {
  const secret = await getJwtSecret();
  const durationSecs = SESSION_DURATIONS[sessionType];
  const expiresAt = new Date(Date.now() + durationSecs * 1000);

  const payload: Record<string, unknown> = {
    roles,
    sessionType,
    ...(registeredDrepId ? { registeredDrepId } : {}),
  };

  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(walletAddress)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(secret);

  return { token, expiresAt: expiresAt.toISOString() };
}

export async function verifyJWT(token: string): Promise<JWTPayload> {
  const secret = await getJwtSecret();
  const { payload } = await jwtVerify(token, secret);

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
    drepId?: string; // legacy — remove after 2026-06-03
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

  return {
    sub: josePayload.sub,
    roles: josePayload.roles,
    sessionType: josePayload.sessionType,
    registeredDrepId,
    iat: josePayload.iat ?? 0,
    exp: josePayload.exp ?? 0,
  };
}

export function extractTokenFromCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)access_token=([^;]+)/);
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
    `access_token=${token}`,
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
  const parts = ['access_token=', 'Max-Age=0', 'HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/'];
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

// ---- Hash helpers ----

export function hashValue(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
