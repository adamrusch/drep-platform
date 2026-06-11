/**
 * POST /auth/onchain/link/verify
 *
 * Decision #3 (2026-06-10) — credential-linking flow, verify step.
 *
 * Maps a freshly-verified ADDITIONAL on-chain credential to the
 * caller's existing canonical `personId`. The caller is already
 * signed in via the on-chain login flow; this endpoint proves
 * control of a SECOND credential and writes the link.
 *
 * # Verification rigor — the load-bearing security contract
 *
 * The new credential MUST be cryptographically proved. We reuse the
 * EXACT same verifier paths the login handler does
 * (`onchainVerify.ts`):
 *
 *   - `drep` / `proposer` — CIP-8 COSE_Sign1 via `verifyCip8`
 *     (signature verify + optional protected-header address bind).
 *   - `spo` / `cc` — raw Ed25519 signature over the nonce, verified
 *     with `verifyEd25519`. The pubkey then resolves through Koios to
 *     confirm the role (registered SPO / authorized CC member).
 *
 * Never link without a valid cryptographic proof. The signature must
 * be over the same stage-bound nonce the `linkChallenge` issued; the
 * nonce store atomically consumes it before we even start the heavy
 * checks (so a bogus signature can't re-burn a victim's fresh nonce
 * — same protection the login path has).
 *
 * # Safety contract (the "no merge" guarantee)
 *
 * After the signature verifies and Koios confirms the role, the
 * derived credentialId is the input to `linkCredentialToPerson`. The
 * three branches:
 *
 *   1. Already linked to the SAME personId → idempotent 200 success.
 *   2. Already linked to a DIFFERENT personId → 409 Conflict, error
 *      message "This credential is already linked to another
 *      account." Account-merge is a future product decision; we
 *      never silently collapse two persons.
 *   3. Unlinked → write the row with `verifiedVia='link'` and 200
 *      success.
 *
 * Branch 2 is the SAFETY guarantee Decision #3 hinges on.
 *
 * # Why we don't extend the JWT after linking
 *
 * The caller's existing session is already authenticated as their
 * personId. The new credential gives them an additional `onChainRole`,
 * but that requires a fresh login under that role to extend the
 * `onChainRoles[]` claim cryptographically. So this endpoint returns
 * the LINK confirmation but does NOT re-mint the JWT — the user can
 * sign in again under the new credential to pick up the role claim,
 * and the `/auth/onchain/me` aggregation surfaces every linked
 * credential regardless of which one the current session is on.
 *
 * # Forward-compat note (Decision #2)
 *
 * When Decision #2 cuts the legacy CIP-30 wallet login over to the
 * identity module, a wallet user logging in WITHOUT explicitly
 * linking will automatically publish a `stake:<addr>` credential
 * into this system. Until then, a wallet user can use this endpoint
 * to manually link their stake address by signing the link challenge
 * with their CIP-30 wallet (CIP-8 path, same as the proposer role).
 */
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { extractAuthContext } from '../../middleware/role-guard';
import { consumeNonce } from '../../lib/identity/auth/nonce';
import { verifyCip8 } from '../../lib/identity/auth/cose';
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
import {
  AlreadyLinkedError,
  credentialTypeForRole,
  identityKeyFor,
  getIdentityLink,
  linkCredentialToPerson,
  resolveOrProvisionPerson,
} from '../../lib/identityPerson';
import type { OnChainRole } from '../../lib/types';
import { ok, badRequest, unauthorized, conflict, internalError } from '../_response';

interface LinkVerifyBody {
  payload: string;
  signatureHex: string;
  keyHex?: string;
  publicKeyHex?: string;
  role: string;
}

const REWARD_ADDR_PREPROD = 0xe0;
const REWARD_ADDR_MAINNET = 0xe1;

type Network = 'mainnet' | 'preprod';

function readNetwork(): Network {
  const raw = (process.env['CARDANO_NETWORK'] ?? 'mainnet').toLowerCase();
  return raw === 'preprod' ? 'preprod' : 'mainnet';
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);

    if (!event.body) {
      return badRequest('Request body is required');
    }
    let body: LinkVerifyBody;
    try {
      body = JSON.parse(event.body) as LinkVerifyBody;
    } catch {
      return badRequest('Invalid JSON body');
    }
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

    // ---- Signature verification — IDENTICAL contract to onchainVerify ----
    if (role === 'drep' || role === 'proposer') {
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

      if (role === 'proposer') {
        if (addressBound !== false) {
          if (!addressBytes || addressBytes.length === 0) {
            return unauthorized('Invalid address in signature');
          }
          const expectedHeader = network === 'mainnet' ? REWARD_ADDR_MAINNET : REWARD_ADDR_PREPROD;
          if (addressBytes[0] !== expectedHeader) {
            return unauthorized('Address type mismatch for proposer role');
          }
        }
        const stakeAddr = stakeAddressFromPubKey(pubKey, network);
        const resolution = await resolveProposer(koios, stakeAddr);
        if (!resolution.isProposer) {
          return unauthorized('Not a proposer');
        }
        credentialId = stakeAddr;
        onChainRole = 'proposer';
      } else {
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
      return internalError('Verification produced no identity');
    }

    // ---- Resolve the caller's personId ----
    //
    // Prefer the JWT claim (set on tokens minted post-Decision-3). For
    // pre-Decision-3 on-chain tokens that omit the claim, fall back to
    // a credential→person re-resolve: the token's `sub` is one of the
    // caller's verified credentials. We look up its identity_links row
    // and, if absent, auto-provision a new person + link (the user's
    // first credential just hasn't been registered yet because they
    // signed in before this code shipped).
    let callerPersonId = authCtx.personId;
    if (!callerPersonId) {
      const carriedRoles = authCtx.onChainRoles ?? [];
      const carriedRole = carriedRoles[0]; // the on-chain login mints one role per session
      if (!carriedRole) {
        return unauthorized(
          'Linking requires an on-chain session. Sign in via /auth/onchain/verify first.',
        );
      }
      const carriedType = credentialTypeForRole(carriedRole);
      const carriedKey = identityKeyFor(carriedType, authCtx.walletAddress);
      const carriedLink = await getIdentityLink(carriedKey);
      if (carriedLink) {
        callerPersonId = carriedLink.personId;
      } else {
        const provisioned = await resolveOrProvisionPerson(
          carriedType,
          authCtx.walletAddress,
          'login',
        );
        callerPersonId = provisioned.personId;
      }
    }

    // ---- Link the new credential ----
    //
    // SAFETY: `linkCredentialToPerson` raises `AlreadyLinkedError` if
    // the credential is mapped to a DIFFERENT personId. We surface
    // that as a 409 with an actionable error message; we DO NOT
    // silently merge two persons. Account-merge is deferred — out of
    // scope for Decision #3.
    const newType = credentialTypeForRole(onChainRole);
    try {
      const linkResult = await linkCredentialToPerson({
        credentialType: newType,
        credentialId,
        personId: callerPersonId,
        linkedFromRole: (authCtx.onChainRoles ?? [])[0],
      });
      return ok({
        personId: callerPersonId,
        linked: {
          identityKey: identityKeyFor(newType, credentialId),
          credentialType: newType,
          credentialId,
          role: onChainRole,
        },
        alreadyLinked: linkResult.alreadyLinked,
      });
    } catch (err) {
      if (err instanceof AlreadyLinkedError) {
        return conflict(
          'This credential is already linked to another account. ' +
            'Account merge is not supported — sign in with the original account ' +
            'or contact support.',
        );
      }
      throw err;
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AuthorizationError') {
      return unauthorized(err.message);
    }
    console.error('linkVerify handler error:', err);
    return internalError('Failed to link credential');
  }
};
