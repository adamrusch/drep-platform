/**
 * POST /auth/onchain/verify
 *
 * Sprint 1 — verifies an on-chain proof-of-control signature for one of
 * four roles and mints a session JWT carrying `onChainRoles`.
 *
 *   - `drep`     — CIP-8 / CIP-30 COSE_Sign1 over a wallet's DRep key.
 *                  Verified via the ported `verifyCip8`; the wallet's
 *                  derived `drep1...` id is then checked against Koios.
 *   - `proposer` — Same CIP-8 path, address-binding gated on a reward
 *                  address (mainnet 0xe1 / preprod 0xe0). The wallet
 *                  must have submitted a governance action.
 *   - `spo`      — Raw 64-byte Ed25519 signature + 32-byte public key
 *                  pasted by the user (their pool's Calidus key). Koios
 *                  confirms `pool_calidus_keys.registered === true`.
 *   - `cc`       — Same paste flow as `spo`; the public key's blake2b-224
 *                  must match a `status='authorized'` CC member's hot
 *                  credential hash.
 *
 * All four flows share:
 *   - Stage-bound nonce consumption via the ported `identity` module.
 *   - Fail-closed verification (any rejection returns 401 without
 *     leaking which check failed beyond a brief category).
 *   - Granular revocation: every successful login mints a fresh `jti`
 *     (ULID) which gets indexed for the user so a "log out everywhere"
 *     can enumerate it.
 *
 * This handler is ADDITIVE — the legacy `/auth/verify` (CIP-30 wallet
 * login) is UNTOUCHED. The two flows produce different cookie names
 * (`access_token_onchain[_<stage>]` here vs `access_token[_<stage>]`
 * there) and a wallet may hold both simultaneously.
 *
 * The on-chain login does NOT touch the `users` table — it identifies a
 * caller by the on-chain credential (drepId / stake / poolId / ccCred),
 * not the wallet stake address. The JWT's `sub` carries the credential
 * identifier so handlers can reason about identity without a row read.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ulid } from 'ulid';
import {
  issueJWT,
  buildOnChainSetCookieHeader,
} from '../../lib/auth';
import {
  consumeNonce,
} from '../../lib/identity/auth/nonce';
import {
  verifyCip8,
} from '../../lib/identity/auth/cose';
import { verifyEd25519 } from '../../lib/identity/crypto/ed25519';
import { hexToBytes } from '../../lib/identity/crypto/hex';
import {
  drepIdFromPubKey,
  stakeAddressFromPubKey,
  ccHotKeyHashHex,
  isDrepCredentialAddress,
} from '../../lib/identity/cardano/identity';
import {
  resolveDRep,
  resolveProposer,
  resolveSpo,
  resolveCc,
} from '../../lib/identity/auth/resolveRole';
import { DynamoDbNonceStore } from '../../lib/identity/stores/nonceStore.dynamodb';
import {
  isHex,
  isHexExact,
  MAX_PAYLOAD_LEN,
  MAX_KEY_HEX_LEN,
  MAX_SIG_HEX_LEN,
  RAW_SIG_HEX_LEN,
  RAW_PUBKEY_HEX_LEN,
} from '../../lib/identity/validation/input';
import { buildKoiosAdapter } from '../../lib/identity/auth/koiosAdapter';
import { recordSessionForUser } from '../../lib/sessionRevocation';
import type { OnChainRole, SessionType, UserRole } from '../../lib/types';
import { ok, badRequest, unauthorized, internalError } from '../_response';

interface VerifyRequestBody {
  payload: string;
  signatureHex: string;
  /** CIP-8 COSE_Key (drep / proposer flows). Required for those roles. */
  keyHex?: string;
  /** Raw 32-byte Ed25519 public key (spo / cc flows). Required for those. */
  publicKeyHex?: string;
  role: string;
  rememberMe?: boolean;
}

// CIP-19 reward address header bytes (proposer role binding).
const REWARD_ADDR_PREPROD = 0xe0;
const REWARD_ADDR_MAINNET = 0xe1;

type Network = 'mainnet' | 'preprod';

function readNetwork(): Network {
  const raw = (process.env['CARDANO_NETWORK'] ?? 'mainnet').toLowerCase();
  return raw === 'preprod' ? 'preprod' : 'mainnet';
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  try {
    if (!event.body) {
      return badRequest('Request body is required');
    }

    let body: VerifyRequestBody;
    try {
      body = JSON.parse(event.body) as VerifyRequestBody;
    } catch {
      return badRequest('Invalid JSON body');
    }

    // ---- Common field validation ----
    if (
      !body ||
      typeof body.payload !== 'string' ||
      typeof body.signatureHex !== 'string' ||
      typeof body.role !== 'string'
    ) {
      return badRequest('payload, signatureHex, and role are required');
    }
    const role = body.role;
    if (role !== 'drep' && role !== 'proposer' && role !== 'spo' && role !== 'cc') {
      return badRequest('role must be one of drep, proposer, spo, cc');
    }
    if (body.payload.length > MAX_PAYLOAD_LEN) {
      return badRequest('payload too long');
    }

    const stage = process.env['STAGE'] ?? 'dev';
    const nonceStore = new DynamoDbNonceStore();
    const koios = buildKoiosAdapter();
    const network = readNetwork();

    let credentialId: string | undefined;
    let onChainRole: OnChainRole | undefined;

    if (role === 'drep' || role === 'proposer') {
      // ---- CIP-8 wallet flow ----
      if (
        typeof body.keyHex !== 'string' ||
        !isHex(body.keyHex, MAX_KEY_HEX_LEN) ||
        !isHex(body.signatureHex, MAX_SIG_HEX_LEN)
      ) {
        return badRequest('keyHex and signatureHex must be hex within bounds');
      }

      const nonceValid = await consumeNonce(nonceStore, body.payload, { expectedStage: stage });
      if (!nonceValid) {
        return unauthorized('Invalid or expired nonce');
      }

      const verifyResult = await verifyCip8({
        signatureHex: body.signatureHex,
        keyHex: body.keyHex,
        expectedPayload: body.payload,
      });
      if (!verifyResult.ok || !verifyResult.pubKey || !verifyResult.addressBytes) {
        return unauthorized('Signature verification failed');
      }
      const { pubKey, addressBytes } = verifyResult;
      if (addressBytes.length === 0) {
        return unauthorized('Invalid address in signature');
      }

      if (role === 'proposer') {
        const expectedHeader = network === 'mainnet' ? REWARD_ADDR_MAINNET : REWARD_ADDR_PREPROD;
        if (addressBytes[0] !== expectedHeader) {
          return unauthorized('Address type mismatch for proposer role');
        }
        const stakeAddr = stakeAddressFromPubKey(pubKey, network);
        const resolution = await resolveProposer(koios, stakeAddr);
        if (!resolution.isProposer) {
          return unauthorized('Not a proposer');
        }
        credentialId = stakeAddr;
        onChainRole = 'proposer';
      } else {
        if (!isDrepCredentialAddress(addressBytes)) {
          return unauthorized('Address type mismatch for DRep role');
        }
        const drepId = drepIdFromPubKey(pubKey);
        const resolution = await resolveDRep(koios, drepId);
        if (!resolution.isDrep) {
          return unauthorized('Not an active DRep');
        }
        credentialId = drepId;
        onChainRole = 'drep';
      }
    } else {
      // ---- Raw Ed25519 paste flow (spo / cc) ----
      if (
        typeof body.publicKeyHex !== 'string' ||
        !isHexExact(body.signatureHex, RAW_SIG_HEX_LEN) ||
        !isHexExact(body.publicKeyHex, RAW_PUBKEY_HEX_LEN)
      ) {
        return badRequest(
          `signatureHex must be ${RAW_SIG_HEX_LEN} hex chars and publicKeyHex must be ${RAW_PUBKEY_HEX_LEN}`,
        );
      }

      const nonceValid = await consumeNonce(nonceStore, body.payload, { expectedStage: stage });
      if (!nonceValid) {
        return unauthorized('Invalid or expired nonce');
      }

      const pubKey = hexToBytes(body.publicKeyHex);
      const sig = hexToBytes(body.signatureHex);
      const msg = new TextEncoder().encode(body.payload);
      const sigResult = await verifyEd25519(sig, msg, pubKey);
      if (!sigResult.ok) {
        return unauthorized('Signature verification failed');
      }

      if (role === 'spo') {
        const resolution = await resolveSpo(koios, body.publicKeyHex.toLowerCase());
        if (!resolution.isSpo || !resolution.poolId) {
          return unauthorized('Not an active SPO');
        }
        credentialId = resolution.poolId;
        onChainRole = 'spo';
      } else {
        const hotKeyHash = ccHotKeyHashHex(pubKey);
        const resolution = await resolveCc(koios, hotKeyHash);
        if (!resolution.isCc) {
          return unauthorized('Not an authorized CC member');
        }
        credentialId = resolution.ccColdId ?? resolution.ccHotId;
        if (!credentialId) {
          return unauthorized('CC member has no credential identifier');
        }
        onChainRole = 'cc';
      }
    }

    if (!credentialId || !onChainRole) {
      // Defensive — the branches above should always set both. If we reach
      // here something is wrong; fail closed.
      return internalError('Verification produced no identity');
    }

    // ---- Mint JWT ----
    //
    // On-chain login does NOT touch the legacy `users` table — the wallet
    // identity for legacy CIP-30 login is the stake address; the on-chain
    // identity is the credential (drepId / stake / poolId / ccCred). The
    // legacy `roles` field of the JWT defaults to `['guest']` so existing
    // role-gate machinery doesn't trip on an empty array. Handlers that
    // care about on-chain identity inspect `onChainRoles` via the
    // authorizer context.
    const sessionType: SessionType = body.rememberMe ? 'remember_me' : 'normal';
    const jti = ulid();
    const baseRoles: UserRole[] = ['guest'];

    const { token, expiresAt } = await issueJWT(
      credentialId,
      baseRoles,
      sessionType,
      undefined, // registeredDrepId — N/A for on-chain login
      0,
      { onChainRoles: [onChainRole], jti },
    );

    // Index the session for revoke-all-for-user. Best-effort — never
    // blocks the response.
    try {
      await recordSessionForUser(credentialId, jti);
    } catch (err) {
      console.warn('onchainVerify: recordSessionForUser failed (non-fatal):', err);
    }

    const cookieHeader = buildOnChainSetCookieHeader(token, sessionType);

    return ok(
      {
        identity: credentialId,
        onChainRoles: [onChainRole],
        sessionType,
        expiresAt,
        jti,
      },
      [cookieHeader],
    );
  } catch (err) {
    console.error('onchainVerify handler error:', err);
    return internalError('On-chain authentication failed');
  }
};
