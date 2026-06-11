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
import {
  emitIdentityMetric,
  METRIC_IDENTITY_COSE_MISSING_ADDRESS_HEADER,
  METRIC_IDENTITY_PROPOSER_ADDRESS_UNBOUND,
} from '../../lib/metrics';
import type { OnChainRole, SessionType, UserRole } from '../../lib/types';
import {
  credentialTypeForRole,
  resolveOrProvisionPerson,
} from '../../lib/identityPerson';
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
    // M5 fix (2026-06-10 security review) — capture the SPO's verified
    // Calidus pubkey at login so we can persist it on the session row
    // and the daily cron can detect rotation. Empty for every other
    // role; the cron's SPO branch keys off the presence of this field.
    let spoCalidusPubKeyHex: string | undefined;

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
      if (!verifyResult.ok || !verifyResult.pubKey) {
        return unauthorized('Signature verification failed');
      }
      const { pubKey, addressBytes, addressBound } = verifyResult;

      // Decision #4 (2026-06-10) — relaxed COSE address-header.
      //
      // Per `cose.ts` (post-relax): the Ed25519 signature is verified
      // unconditionally; the protected-header `address` field is bound
      // when present (`addressBound===true`) and silently skipped when
      // absent (`addressBound===false`). When absent, we still emit the
      // `IdentityCoseMissingAddressHeader` metric so the affected-wallet
      // population stays quantifiable in CloudWatch — the prior strict
      // behavior counted on rejection; this counts on the now-successful
      // address-absent path. Net population is the SAME (every wallet
      // that omits the header still hits the metric exactly once per
      // login attempt). The wire response is unchanged in either mode.
      //
      // Identity derivation BRANCHES on `addressBound`:
      //   - bound   → bind step already enforced pubkey↔address.
      //               Address-type-for-role gate is meaningful (we have
      //               header bytes); derive identity from pubkey
      //               regardless (the bind guarantees they agree).
      //   - unbound → there is no claimed address. Skip the
      //               address-type-for-role gate (no header bytes to
      //               check) and derive identity directly from the
      //               verified pubkey. Koios resolution downstream is
      //               the authoritative role check — a wallet that
      //               omits the header but ISN'T a registered DRep /
      //               proposer still fails at the Koios gate.
      if (addressBound === false) {
        emitIdentityMetric(METRIC_IDENTITY_COSE_MISSING_ADDRESS_HEADER, 1, { Role: role });
      }

      if (role === 'proposer') {
        // When address-bound, gate on the reward-address header byte as a
        // cheap pre-filter before the Koios call. When unbound, fall
        // through directly to the Koios resolution — Koios is the
        // authoritative "is this stake address a proposer" check.
        if (addressBound !== false) {
          if (!addressBytes || addressBytes.length === 0) {
            return unauthorized('Invalid address in signature');
          }
          const expectedHeader = network === 'mainnet' ? REWARD_ADDR_MAINNET : REWARD_ADDR_PREPROD;
          if (addressBytes[0] !== expectedHeader) {
            return unauthorized('Address type mismatch for proposer role');
          }
        } else {
          // S4 hardening (2026-06-10 security review) — emit a metric
          // on the proposer-unbound-address path so operations can
          // monitor for anomalies. The login proceeds normally; the
          // Koios resolution downstream is the authoritative
          // proposer check.
          emitIdentityMetric(METRIC_IDENTITY_PROPOSER_ADDRESS_UNBOUND, 1);
        }
        const stakeAddr = stakeAddressFromPubKey(pubKey, network);
        const resolution = await resolveProposer(koios, stakeAddr);
        if (!resolution.isProposer) {
          return unauthorized('Not a proposer');
        }
        credentialId = stakeAddr;
        onChainRole = 'proposer';
      } else {
        // DRep role — same shape. The address-type gate
        // (`isDrepCredentialAddress`) is a pre-filter that only makes
        // sense when we have header bytes. When unbound, skip it; the
        // Koios resolution downstream confirms the derived drep id is
        // registered.
        if (addressBound !== false) {
          if (!addressBytes || addressBytes.length === 0) {
            return unauthorized('Invalid address in signature');
          }
          if (!isDrepCredentialAddress(addressBytes)) {
            return unauthorized('Address type mismatch for DRep role');
          }
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
        // M5 — record the verified Calidus pubkey so the cron's SPO
        // branch can detect rotation. Stored lowercase to match how
        // Koios returns it on the per-pool lookup path; case-folding
        // here keeps the eventual equality check trivial.
        spoCalidusPubKeyHex = body.publicKeyHex.toLowerCase();
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

    // ---- Decision #3 — reconcile to a canonical personId ----
    //
    // We now have a verified on-chain credential (drepId / poolId /
    // ccCred / stakeAddr). Decision #3 introduces the `personId` layer
    // so the same individual is recognised across MULTIPLE on-chain
    // credentials. The reconciliation:
    //   - If this credential is already mapped (in `identity_links`) →
    //     load that personId (returning user).
    //   - Otherwise → auto-provision a fresh person + link with
    //     `verifiedVia='login'`.
    //
    // Best-effort: a hard failure here logs + falls back to "no
    // personId on this token." That keeps login WORKING while the
    // person layer matures — the legacy on-chain login surface (JWT
    // carries credential identity directly) still works without a
    // personId claim, and the `me`/link handlers fall back to a
    // credential→person re-resolve.
    let personId: string | undefined;
    try {
      const credentialType = credentialTypeForRole(onChainRole);
      const reconciled = await resolveOrProvisionPerson(
        credentialType,
        credentialId,
        'login',
      );
      personId = reconciled.personId;
    } catch (err) {
      console.warn(
        'onchainVerify: person reconciliation failed (non-fatal):',
        err instanceof Error ? err.message : err,
      );
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
    //
    // Decision #3 — when reconciliation produced a personId, ride it as
    // a parallel JWT claim. Pre-Decision-3 tokens omit it; downstream
    // handlers (me/link/profile) fall back to a credential→person
    // re-resolve in that case.
    const sessionType: SessionType = body.rememberMe ? 'remember_me' : 'normal';
    const jti = ulid();
    const baseRoles: UserRole[] = ['guest'];

    const { token, expiresAt } = await issueJWT(
      credentialId,
      baseRoles,
      sessionType,
      undefined, // registeredDrepId — N/A for on-chain login
      0,
      { onChainRoles: [onChainRole], jti, ...(personId ? { personId } : {}) },
    );

    // Index the session for revoke-all-for-user. Best-effort — never
    // blocks the response. Sprint 3 — pass the on-chain role through so
    // the daily role-revalidation cron knows which `resolveRole` variant
    // to re-run for this identity on its 24h cadence.
    //
    // M5 (2026-06-10 security review) — pass the verified Calidus pubkey
    // for SPO sessions so the cron can compare against the pool's
    // CURRENT registered key and revoke on rotation. The extras param
    // is optional; non-SPO roles pass an empty object and the field
    // stays unset on the persisted row.
    try {
      await recordSessionForUser(
        credentialId,
        jti,
        onChainRole,
        undefined,
        spoCalidusPubKeyHex ? { spoCalidusPubKeyHex } : {},
      );
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
        // Decision #3 — surface the personId when reconciliation
        // succeeded so the SPA can route to the on-chain profile UI
        // immediately. Absent on the rare reconciliation-failure path
        // (best-effort — login still succeeded).
        ...(personId ? { personId } : {}),
      },
      [cookieHeader],
    );
  } catch (err) {
    console.error('onchainVerify handler error:', err);
    return internalError('On-chain authentication failed');
  }
};
