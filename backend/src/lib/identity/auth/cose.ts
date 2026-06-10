// Adapted from DRep Talk (https://github.com/katomm/dreptalk.com), Apache-2.0. Modified for drep-platform.
// CIP-8 / CIP-30 signData signature verifier.
// Verifies COSE_Sign1 structures produced by Cardano wallets.
//
// Stack adaptations from DRep Talk:
//   - CBOR: `cbor-x` instead of `cborg`. `cbor-x` decodes CBOR maps to plain
//     JS objects by default; we construct a decoder with `mapsAsObjects: false`
//     so COSE maps come out as `Map` instances (matching DRep Talk's
//     `useMaps:true` assumption) and the verifier's Map-aware extraction works
//     unchanged.
//   - Ed25519: Node `crypto` via the `verifyEd25519` wrapper in `../crypto/ed25519`.
import { Encoder } from 'cbor-x';
import { blake2b224, blake2b256 } from '../crypto/blake';
import { hexToBytes } from '../crypto/hex';
import { bytesEqual } from '../crypto/bytes';
import { verifyEd25519 } from '../crypto/ed25519';
import { keyHashMatchesAddress } from '../cardano/identity';

// `cbor-x`'s `mapsAsObjects:false` makes CBOR maps decode to JS `Map`s — the
// shape DRep Talk's verifier expects (it used `cborg`'s `useMaps:true`).
const coseCodec = new Encoder({ mapsAsObjects: false, useRecords: false, tagUint8Array: false });

function decodeCose(bytes: Uint8Array): unknown {
  return coseCodec.decode(Buffer.from(bytes));
}

function encodeCose(value: unknown): Uint8Array {
  return new Uint8Array(coseCodec.encode(value));
}

export interface Cip8VerifyResult {
  ok: boolean;
  reason?: string; // why it failed (for logging, NOT leaked to clients)
  pubKey?: Uint8Array; // 32-byte Ed25519 pubkey (present when signature math validates)
  addressBytes?: Uint8Array; // raw address bytes from the protected header
}

// COSE algorithm label for EdDSA (-8 in CBOR integer space).
const ALG_EDDSA = -8;
// COSE key type for OKP (1).
const KTY_OKP = 1;
// COSE curve label for Ed25519 (6).
const CRV_ED25519 = 6;

/** Normalises a value that may be a Map or a plain object indexed by either
 *  numeric or string keys into a lookup function. Some CBOR decoders surface
 *  small-integer keys as JS numbers, others as decimal strings; we accept both. */
function mapGet(value: unknown, key: number | string): unknown {
  if (value instanceof Map) return value.get(key);
  if (value !== null && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    if (typeof key === 'number') {
      const asStr = String(key);
      return asStr in rec ? rec[asStr] : undefined;
    }
    return rec[key];
  }
  return undefined;
}

function isCborMap(value: unknown): boolean {
  return value instanceof Map || (value !== null && typeof value === 'object' && !Array.isArray(value));
}

function toUint8Array(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (Buffer.isBuffer(value)) return new Uint8Array(value);
  return undefined;
}

/** Verifies a CIP-8 signData COSE_Sign1 structure against an expected payload. */
export async function verifyCip8(input: {
  signatureHex: string; // COSE_Sign1, hex
  keyHex: string; // COSE_Key, hex
  expectedPayload: string; // the exact server-issued payload string the user should have signed
}): Promise<Cip8VerifyResult> {
  try {
    return await verifyCip8Internal(input);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `internal error: ${reason}` };
  }
}

async function verifyCip8Internal(input: {
  signatureHex: string;
  keyHex: string;
  expectedPayload: string;
}): Promise<Cip8VerifyResult> {
  const { signatureHex, keyHex, expectedPayload } = input;

  // Step 1: Decode COSE_Sign1 array.
  let sigBytes: Uint8Array;
  try {
    sigBytes = hexToBytes(signatureHex);
  } catch {
    return { ok: false, reason: 'signatureHex is not valid hex' };
  }
  if (sigBytes.length === 0) {
    return { ok: false, reason: 'signatureHex is empty' };
  }

  let coseSign1: unknown;
  try {
    coseSign1 = decodeCose(sigBytes);
  } catch (err: unknown) {
    return {
      ok: false,
      reason: `COSE_Sign1 CBOR decode failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!Array.isArray(coseSign1) || coseSign1.length !== 4) {
    return {
      ok: false,
      reason: `COSE_Sign1 must be a 4-element array, got ${
        Array.isArray(coseSign1) ? coseSign1.length : typeof coseSign1
      }`,
    };
  }

  const [protectedBstrRaw, unprotectedHeader, payloadBstrRaw, sigBstrRaw] = coseSign1;
  const protectedBstr = toUint8Array(protectedBstrRaw);
  const payloadBstr =
    payloadBstrRaw === null ? null : toUint8Array(payloadBstrRaw);
  const sigBstr = toUint8Array(sigBstrRaw);

  if (!protectedBstr) {
    return { ok: false, reason: 'COSE_Sign1[0] (protected) must be a bstr' };
  }
  if (payloadBstr === undefined) {
    return { ok: false, reason: 'COSE_Sign1[2] (payload) must be a bstr or null' };
  }
  if (!sigBstr) {
    return { ok: false, reason: 'COSE_Sign1[3] (signature) must be a bstr' };
  }
  if (payloadBstr === null) {
    return { ok: false, reason: 'detached payload not supported' };
  }

  // Step 2: Decode COSE_Key and extract pubkey.
  let keyBytes: Uint8Array;
  try {
    keyBytes = hexToBytes(keyHex);
  } catch {
    return { ok: false, reason: 'keyHex is not valid hex' };
  }

  let coseKey: unknown;
  try {
    coseKey = decodeCose(keyBytes);
  } catch (err: unknown) {
    return {
      ok: false,
      reason: `COSE_Key CBOR decode failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!isCborMap(coseKey)) {
    return { ok: false, reason: 'COSE_Key must be a CBOR map' };
  }

  const kty = mapGet(coseKey, 1);
  const alg = mapGet(coseKey, 3);
  const crv = mapGet(coseKey, -1);
  const pubKeyRaw = mapGet(coseKey, -2);

  if (kty !== KTY_OKP) {
    return { ok: false, reason: `COSE_Key kty must be OKP (1), got ${String(kty)}` };
  }
  if (alg !== ALG_EDDSA) {
    return { ok: false, reason: `COSE_Key alg must be EdDSA (-8), got ${String(alg)}` };
  }
  if (crv !== CRV_ED25519) {
    return { ok: false, reason: `COSE_Key crv must be Ed25519 (6), got ${String(crv)}` };
  }
  const pubKey = toUint8Array(pubKeyRaw);
  if (pubKey?.length !== 32) {
    return {
      ok: false,
      reason: `COSE_Key x (-2) must be a 32-byte bstr, got ${
        pubKey ? `${pubKey.length} bytes` : typeof pubKeyRaw
      }`,
    };
  }

  // Step 3: Decode protected header (double-encoded CBOR bstr).
  let protectedHeader: unknown;
  try {
    protectedHeader = decodeCose(protectedBstr);
  } catch (err: unknown) {
    return {
      ok: false,
      reason: `protected header CBOR decode failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  if (!isCborMap(protectedHeader)) {
    return { ok: false, reason: 'protected header must be a CBOR map' };
  }

  const protectedAlg = mapGet(protectedHeader, 1);
  if (protectedAlg !== ALG_EDDSA) {
    return {
      ok: false,
      reason: `protected header alg must be EdDSA (-8), got ${String(protectedAlg)}`,
    };
  }

  const addressBytes = toUint8Array(mapGet(protectedHeader, 'address'));
  if (!addressBytes) {
    return { ok: false, reason: 'protected header missing or invalid "address" field' };
  }

  // Step 4: Payload check.
  // Read hashed flag from unprotected header (default false).
  let hashed = false;
  const hashedFlag = mapGet(unprotectedHeader, 'hashed');
  if (typeof hashedFlag === 'boolean') {
    hashed = hashedFlag;
  }

  const expectedPayloadBytes = new TextEncoder().encode(expectedPayload);

  if (!hashed) {
    if (!bytesEqual(payloadBstr, expectedPayloadBytes)) {
      return { ok: false, reason: 'payload does not match expected payload' };
    }
  } else {
    // TODO: verify hash variant with a hardware wallet; Blake2b-224 is used here but
    // different wallets may use Blake2b-256. The DRep Talk browser fixtures use
    // hashed=false so this path is presently unexercised.
    const hashedPayload224 = blake2b224(expectedPayloadBytes);
    const hashedPayload256 = blake2b256(expectedPayloadBytes);
    if (
      !bytesEqual(payloadBstr, hashedPayload224) &&
      !bytesEqual(payloadBstr, hashedPayload256)
    ) {
      return {
        ok: false,
        reason:
          'hashed payload does not match expected payload (tried Blake2b-224 and Blake2b-256)',
      };
    }
  }

  // Step 5: Build Sig_structure and encode.
  const sigStructure = ['Signature1', protectedBstr, new Uint8Array(0), payloadBstr];
  const toBeSigned = encodeCose(sigStructure);

  // Step 6: Verify Ed25519 signature.
  const sigValid = await verifyEd25519(sigBstr, toBeSigned, pubKey);
  if (!sigValid.ok) {
    return { ok: false, reason: sigValid.reason };
  }

  // Step 7: Bind signature to address.
  if (!keyHashMatchesAddress(pubKey, addressBytes)) {
    return { ok: false, reason: 'pubkey hash does not match address in protected header' };
  }

  // Step 8: All checks passed.
  return { ok: true, pubKey, addressBytes };
}
