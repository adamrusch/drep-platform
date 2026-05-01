import { SignJWT, jwtVerify, type JWTPayload as JoseJWTPayload } from 'jose';
import * as crypto from 'crypto';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { decode as cborDecode, encode as cborEncode } from 'cbor-x';
import type { JWTPayload, UserRole, SessionType } from './types';
import { putItem, getItem, deleteItem, tableNames } from './dynamodb';

// ---- Auth nonce DynamoDB record ----

interface AuthNonceItem extends Record<string, unknown> {
  nonce: string;
  kind: 'challenge' | 'mutation';
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
 * Verifies a CIP-30 wallet signature.
 *
 * CIP-30 wallet.signData() returns a DataSignature { signature, key } where:
 *   - signature: CBOR hex of COSE_Sign1 [protected_header_bytes, {}, payload_bytes, sig_bytes]
 *   - key: CBOR hex of COSE_Key map { 1: 1 (OKP), 3: -8 (EdDSA), -1: 6 (Ed25519), -2: pubkey_bytes }
 *
 * Verification reconstructs the Sig_Structure and verifies the Ed25519 signature
 * with the public key extracted from the COSE_Key.
 */
export function verifyWalletSignature(
  _walletAddress: string,
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

export async function issueJWT(
  walletAddress: string,
  roles: UserRole[],
  sessionType: SessionType,
  drepId?: string,
): Promise<{ token: string; expiresAt: string }> {
  const secret = await getJwtSecret();
  const durationSecs = SESSION_DURATIONS[sessionType];
  const expiresAt = new Date(Date.now() + durationSecs * 1000);

  const payload: Record<string, unknown> = {
    roles,
    sessionType,
    ...(drepId ? { drepId } : {}),
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

  const josePayload = payload as JoseJWTPayload & {
    roles: UserRole[];
    sessionType: SessionType;
    drepId?: string;
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

  return {
    sub: josePayload.sub,
    roles: josePayload.roles,
    sessionType: josePayload.sessionType,
    drepId: josePayload.drepId,
    iat: josePayload.iat ?? 0,
    exp: josePayload.exp ?? 0,
  };
}

export function extractTokenFromCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)access_token=([^;]+)/);
  return match ? (match[1] ?? null) : null;
}

export function buildSetCookieHeader(token: string, sessionType: SessionType): string {
  const maxAge = SESSION_DURATIONS[sessionType];
  return [
    `access_token=${token}`,
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Path=/',
  ].join('; ');
}

export function buildClearCookieHeader(): string {
  return 'access_token=; Max-Age=0; HttpOnly; Secure; SameSite=Strict; Path=/';
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

  const message = `drep-platform mutation authorization:\n\nWallet: ${walletAddress}\nNonce: ${nonce}\nExpires: ${expiresAtDate.toISOString()}`;

  return { nonce, message, expiresAt: expiresAtDate.toISOString() };
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
