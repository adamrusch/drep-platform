// Adapted from DRep Talk (https://github.com/katomm/dreptalk.com), Apache-2.0. Modified for drep-platform.
//
// Testable auth handler functions with injected dependencies.
//
// Stack adaptations:
//   - KVNamespace → NonceStore / SessionStore interfaces.
//   - D1Database  → UserStore interface (`upsertUserFromAuth` + `getUserById`).
//   - KoiosClient → structural interface in `./koios.ts`.
//   - Moderator allowlist  → unchanged shape (string mapper injected via `deps`).
//
// The flows themselves (4 paths: drep, proposer, spo, cc; fail-closed verify;
// nonce single-use; stake-vs-cred binding; CIP-95 type-6 vs reward address
// gating) are preserved. The verify handler does NOT yet read or set
// production HTTP — it returns a structured `VerifyResult`. The wiring into
// the live Lambda handler is intentionally deferred (per the porting brief).

import { consumeNonce, issueNonce } from './nonce';
import { verifyCip8 } from './cose';
import { verifyEd25519 } from '../crypto/ed25519';
import { hexToBytes } from '../crypto/hex';
import {
  isHex,
  isHexExact,
  MAX_PAYLOAD_LEN,
  MAX_KEY_HEX_LEN,
  MAX_SIG_HEX_LEN,
  RAW_SIG_HEX_LEN,
  RAW_PUBKEY_HEX_LEN,
} from '../validation/input';
import {
  drepIdFromPubKey,
  stakeAddressFromPubKey,
  ccHotKeyHashHex,
  isDrepCredentialAddress,
  type CardanoNetwork,
} from '../cardano/identity';
import { resolveDRep, resolveProposer, resolveSpo, resolveCc } from './resolveRole';
import type { KoiosClient } from './koios';
import {
  createSession,
  revokeSession,
  buildSessionCookie,
  clearSessionCookie,
  parseSessionToken,
} from './session';
import type { NonceStore } from '../stores/nonceStore';
import type { SessionStore } from '../stores/sessionStore';
import type { UserStore, AuthRole } from './users';

// Moderator-role mapper signature. DRep Talk uses a module-level allowlist;
// the port leaves the source of truth out so callers can inject their own.
export type ModeratorRole = 'admin' | 'moderator';

// ---------------------------------------------------------------------------
// Address header bytes
// ---------------------------------------------------------------------------

// CIP-19 reward address header: testnet (preprod) = 0xe0, mainnet = 0xe1.
const REWARD_ADDR_PREPROD = 0xe0;
const REWARD_ADDR_MAINNET = 0xe1;

// ---------------------------------------------------------------------------
// Challenge handler
// ---------------------------------------------------------------------------

export interface ChallengeInput {
  nonceStore: NonceStore;
  domain: string;
  stage: string;
  now?: number;
}

export interface ChallengeResult {
  payload: string;
}

/** Issues a single-use, stage-bound nonce.
 *  Returns the opaque payload the client must sign. */
export async function handleChallenge(input: ChallengeInput): Promise<ChallengeResult> {
  const { payload } = await issueNonce(input.nonceStore, {
    domain: input.domain,
    stage: input.stage,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  return { payload };
}

// ---------------------------------------------------------------------------
// Verify handler
// ---------------------------------------------------------------------------

export interface VerifyBody {
  payload: string;
  signatureHex: string;
  /** COSE_Key, present for the CIP-8 wallet flow (drep / proposer). */
  keyHex?: string;
  /** Raw 32-byte Ed25519 public key (hex), present for the paste flow (spo / cc). */
  publicKeyHex?: string;
  role: string;
}

export interface VerifyInput {
  body: VerifyBody;
  nonceStore: NonceStore;
  sessionStore: SessionStore;
  userStore: UserStore;
  koios: KoiosClient;
  network: CardanoNetwork;
  /** Required so the verifier can reject a payload that was signed under a
   *  different stage (stage-binding defense). */
  stage: string;
  now?: number;
  secure?: boolean;
}

/** Injected dependencies for handleVerify. All fields are optional; defaults
 *  are the real implementations. */
export interface VerifyDeps {
  consumeNonce?: (
    store: NonceStore,
    payload: string,
    opts?: { now?: number; expectedStage?: string },
  ) => Promise<boolean>;
  /** Resolves a derived stake address to a moderator role, or null when the
   *  address is not on the allowlist. Defaults to "no moderators". */
  getModeratorRole?: (stakeAddr: string) => ModeratorRole | null;
}

export interface VerifyResult {
  status: number;
  json: unknown;
  setCookie?: string;
}

/**
 * Full CIP-8 verify flow with fail-closed semantics.
 * Returns a structured result (status + json + optional Set-Cookie).
 * Never throws to the caller; all failures are caught and returned as 4xx/5xx.
 */
export async function handleVerify(input: VerifyInput, deps?: VerifyDeps): Promise<VerifyResult> {
  try {
    return await handleVerifyInternal(input, deps);
  } catch {
    return { status: 500, json: { ok: false, error: 'internal error' } };
  }
}

async function handleVerifyInternal(input: VerifyInput, deps?: VerifyDeps): Promise<VerifyResult> {
  const { body } = input;

  // Step 1: Validate the fields common to both flows.
  if (
    !body ||
    typeof body.payload !== 'string' ||
    typeof body.signatureHex !== 'string' ||
    typeof body.role !== 'string'
  ) {
    return { status: 400, json: { ok: false, error: 'invalid request' } };
  }
  const role = body.role;
  if (role !== 'drep' && role !== 'proposer' && role !== 'spo' && role !== 'cc') {
    return { status: 400, json: { ok: false, error: 'invalid request' } };
  }
  if (body.payload.length > MAX_PAYLOAD_LEN) {
    return { status: 400, json: { ok: false, error: 'invalid request' } };
  }

  if (role === 'drep' || role === 'proposer') {
    return await verifyWalletCip8(role, input, deps);
  }
  return await verifyRawEd25519(role, input, deps);
}

/** DRep / Proposer login: CIP-8 COSE signature from a CIP-30 wallet. */
async function verifyWalletCip8(
  role: 'drep' | 'proposer',
  input: VerifyInput,
  deps?: VerifyDeps,
): Promise<VerifyResult> {
  const { body, nonceStore, koios, network, now, stage } = input;
  const consumeNonceFn = deps?.consumeNonce ?? consumeNonce;
  const getModeratorRole = deps?.getModeratorRole ?? (() => null);

  if (
    typeof body.keyHex !== 'string' ||
    !isHex(body.keyHex, MAX_KEY_HEX_LEN) ||
    !isHex(body.signatureHex, MAX_SIG_HEX_LEN)
  ) {
    return { status: 400, json: { ok: false, error: 'invalid request' } };
  }

  const nonceValid = await consumeNonceFn(nonceStore, body.payload, {
    ...(now !== undefined ? { now } : {}),
    expectedStage: stage,
  });
  if (!nonceValid) {
    return { status: 401, json: { ok: false, error: 'invalid or expired nonce' } };
  }

  const verifyResult = await verifyCip8({
    signatureHex: body.signatureHex,
    keyHex: body.keyHex,
    expectedPayload: body.payload,
  });
  if (!verifyResult.ok || !verifyResult.pubKey) {
    return { status: 401, json: { ok: false, error: 'signature verification failed' } };
  }

  const { pubKey, addressBytes, addressBound } = verifyResult;

  // Decision #4 (2026-06-10) — relaxed COSE address-header.
  //
  // When the wallet's CIP-8 protected header carried an `address` field,
  // `cose.ts` bound it to the pubkey hash and we still run the
  // address-type-for-role pre-filter as before. When the field was absent,
  // `cose.ts` returned `addressBound: false` and we skip the
  // address-type-for-role gate; the Koios role resolution downstream is
  // the authoritative role check (a wallet whose header omits the address
  // but isn't a registered DRep / proposer still fails at the Koios
  // gate). The pubkey-derived identity stays the same regardless.
  if (addressBound !== false) {
    if (!addressBytes || addressBytes.length === 0) {
      return { status: 401, json: { ok: false, error: 'invalid address in signature' } };
    }
    if (role === 'proposer') {
      const expectedHeader = network === 'mainnet' ? REWARD_ADDR_MAINNET : REWARD_ADDR_PREPROD;
      if (addressBytes[0] !== expectedHeader) {
        return { status: 401, json: { ok: false, error: 'address type mismatch for role' } };
      }
    } else if (!isDrepCredentialAddress(addressBytes)) {
      return { status: 401, json: { ok: false, error: 'address type mismatch for role' } };
    }
  }

  const grantedRoles: AuthRole[] = [];
  let modRole: ModeratorRole | null = null;
  let drepId: string | undefined;
  let stakeAddr: string | undefined;

  if (role === 'drep') {
    drepId = drepIdFromPubKey(pubKey);
    const resolution = await resolveDRep(koios, drepId);
    if (!resolution.isDrep) {
      return { status: 401, json: { ok: false, error: 'not an active DRep' } };
    }
    grantedRoles.push('drep');
  } else {
    stakeAddr = stakeAddressFromPubKey(pubKey, network);
    const resolution = await resolveProposer(koios, stakeAddr);
    modRole = getModeratorRole(stakeAddr);
    if (!resolution.isProposer && !modRole) {
      return { status: 401, json: { ok: false, error: 'not a proposer or moderator' } };
    }
    if (resolution.isProposer) grantedRoles.push('proposer');
  }

  return finishLogin(input, {
    ...(drepId !== undefined ? { drepId } : {}),
    ...(stakeAddr !== undefined ? { stakeAddr } : {}),
    grantedRoles,
    modRole,
  });
}

/** SPO (Calidus) / CC member login: raw Ed25519 signature pasted by the user. */
async function verifyRawEd25519(
  role: 'spo' | 'cc',
  input: VerifyInput,
  deps?: VerifyDeps,
): Promise<VerifyResult> {
  const { body, nonceStore, koios, now, stage } = input;
  const consumeNonceFn = deps?.consumeNonce ?? consumeNonce;

  if (
    typeof body.publicKeyHex !== 'string' ||
    !isHexExact(body.signatureHex, RAW_SIG_HEX_LEN) ||
    !isHexExact(body.publicKeyHex, RAW_PUBKEY_HEX_LEN)
  ) {
    return { status: 400, json: { ok: false, error: 'invalid request' } };
  }

  const nonceValid = await consumeNonceFn(nonceStore, body.payload, {
    ...(now !== undefined ? { now } : {}),
    expectedStage: stage,
  });
  if (!nonceValid) {
    return { status: 401, json: { ok: false, error: 'invalid or expired nonce' } };
  }

  const pubKey = hexToBytes(body.publicKeyHex);
  const sig = hexToBytes(body.signatureHex);
  const msg = new TextEncoder().encode(body.payload);
  const sigResult = await verifyEd25519(sig, msg, pubKey);
  if (!sigResult.ok) {
    return { status: 401, json: { ok: false, error: 'signature verification failed' } };
  }

  const grantedRoles: AuthRole[] = [];
  let poolId: string | undefined;
  let ccCred: string | undefined;

  if (role === 'spo') {
    const resolution = await resolveSpo(koios, body.publicKeyHex.toLowerCase());
    if (!resolution.isSpo) {
      return { status: 401, json: { ok: false, error: 'not an active SPO' } };
    }
    grantedRoles.push('spo');
    poolId = resolution.poolId;
  } else {
    const hotKeyHashHex = ccHotKeyHashHex(pubKey);
    const resolution = await resolveCc(koios, hotKeyHashHex);
    if (!resolution.isCc) {
      return { status: 401, json: { ok: false, error: 'not an authorized CC member' } };
    }
    grantedRoles.push('cc');
    ccCred = resolution.ccColdId ?? resolution.ccHotId;
  }

  return finishLogin(input, {
    ...(poolId !== undefined ? { poolId } : {}),
    ...(ccCred !== undefined ? { ccCred } : {}),
    grantedRoles,
    modRole: null,
  });
}

/**
 * Shared login tail: upsert the user with the credentials and on-chain roles
 * proven this login, then mint a session. The moderator role is re-evaluated
 * from the allowlist on every login and is not persisted on the user row.
 */
async function finishLogin(
  input: VerifyInput,
  args: {
    drepId?: string;
    stakeAddr?: string;
    poolId?: string;
    ccCred?: string;
    grantedRoles: AuthRole[];
    modRole: ModeratorRole | null;
  },
): Promise<VerifyResult> {
  const { userStore, sessionStore, now, secure } = input;
  const { drepId, stakeAddr, poolId, ccCred, grantedRoles, modRole } = args;

  const user = await userStore.upsertUserFromAuth({
    ...(drepId !== undefined ? { drepId } : {}),
    ...(stakeAddr !== undefined ? { stakeAddr } : {}),
    ...(poolId !== undefined ? { poolId } : {}),
    ...(ccCred !== undefined ? { ccCred } : {}),
    roles: grantedRoles,
    now: Math.floor(now ?? Date.now() / 1000),
  });

  const roles: string[] = [];
  if (user.is_drep) roles.push('drep');
  if (user.is_proposer) roles.push('proposer');
  if (user.is_spo) roles.push('spo');
  if (user.is_cc) roles.push('cc');
  if (modRole) roles.push(modRole);
  if (roles.length === 0) roles.push('member');

  const token = await createSession(
    sessionStore,
    { id: user.id, roles },
    ...(now !== undefined ? [{ now }] : []),
  );
  const setCookie = buildSessionCookie(
    token,
    ...(secure !== undefined ? [{ secure }] : []),
  );

  return {
    status: 200,
    json: { ok: true, user: { id: user.id, roles } },
    setCookie,
  };
}

// ---------------------------------------------------------------------------
// Logout handler
// ---------------------------------------------------------------------------

export interface LogoutInput {
  sessionStore: SessionStore;
  cookieHeader: string | null;
}

export interface LogoutResult {
  status: number;
  json: unknown;
  setCookie: string;
}

/**
 * Revokes the session from the cookie, returns a cleared cookie.
 * Never throws; silently ignores missing or invalid tokens.
 */
export async function handleLogout(input: LogoutInput): Promise<LogoutResult> {
  const { sessionStore, cookieHeader } = input;
  const token = parseSessionToken(cookieHeader);
  if (token) {
    try {
      await revokeSession(sessionStore, token);
    } catch {
      // Ignore errors: the session is gone either way.
    }
  }
  return {
    status: 200,
    json: { ok: true },
    setCookie: clearSessionCookie(),
  };
}
