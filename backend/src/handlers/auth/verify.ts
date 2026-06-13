import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  peekChallenge,
  consumeChallenge,
  issueJWT,
  buildSignMessage,
  buildSetCookieHeader,
  hashValue,
} from '../../lib/auth';
import { verifyCip8 } from '../../lib/identity/auth/cose';
import { getItem, putItem, tableNames } from '../../lib/dynamodb';
import {
  normalizeToStakeAddress,
  decodeCardanoAddress,
  publicKeyMatchesAddress,
} from '../../lib/cardanoAddress';
import { _invalidateForStake } from '../../lib/recognition';
import { writeAuditEvent } from '../../lib/audit';
import { resolveOrProvisionPerson } from '../../lib/identityPerson';
import type { UserItem, SessionType, UserRole } from '../../lib/types';
import { isBootstrapAdmin } from '../../lib/platformAdmin';
import { ok, badRequest, unauthorized, internalError } from '../_response';

interface VerifyRequestBody {
  walletAddress: string;
  nonce: string;
  signature: string;
  key: string;
  rememberMe?: boolean;
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
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

    const { walletAddress, nonce, signature, key } = body;

    if (!walletAddress || !nonce || !signature || !key) {
      return badRequest('walletAddress, nonce, signature, and key are required');
    }

    // 1. Peek the nonce — confirm it exists, is unexpired, and matches the
    //    wallet — but DO NOT consume it yet. Consuming before signature
    //    verification would let an attacker burn a victim's freshly-issued
    //    nonce by submitting a bogus signature.
    const peek = await peekChallenge(nonce, walletAddress);
    if (!peek.valid) {
      return unauthorized(peek.reason ?? 'Invalid challenge');
    }

    // 2. Verify the wallet signature against the expected message.
    //
    // The verifier is the PORTED CIP-8 verifier from the identity module —
    // shared with the on-chain login (`onchainVerify.ts`). It returns
    // `{ok, pubKey, addressBytes, addressBound}` where:
    //   - signature math (COSE_Sign1 + Ed25519) is verified unconditionally;
    //   - `addressBound===true` means the wallet supplied an `address` field
    //     in the COSE protected header AND its key-hash credential matched
    //     the pubkey (the verifier already enforced that).
    //   - `addressBound===false` means the header omitted the field — the
    //     signature is still cryptographically valid, but no header address
    //     was bound to the pubkey.
    //
    // CRITICAL — preserving the LEGACY `verifyWalletSignature` contract:
    // the ported verifier binds the pubkey to the HEADER address. The legacy
    // verifier bound the pubkey to the CLAIMED `walletAddress` (the body
    // field) — that's a different surface. A wallet's CIP-30 signature for
    // address A must NOT authenticate a login claiming address B. So after
    // the ported verifier accepts, we re-assert the LEGACY load-bearing
    // binding ourselves:
    //   (i)  pubkey → claimed `walletAddress` credential match
    //        (via `publicKeyMatchesAddress`), and
    //   (ii) when the header carried an address (`addressBound===true`),
    //        a defense-in-depth cross-check that the header's address
    //        bytes equal the claimed-address bytes.
    // These two checks mirror, byte-for-byte, what
    // `verifyWalletSignature(walletAddress, ...)` did before this cutover.
    // The parity test (`verify.parity.test.ts`) proves the
    // accept/reject decisions are identical to the legacy verifier across
    // a corpus of CIP-30 signed messages — including the wrong-claimed-
    // address rejection (the P0-1 exploit guarded by `auth.walletSignature.test.ts`).
    const expectedMessage = buildSignMessage(nonce, walletAddress);
    const cip8 = await verifyCip8({
      signatureHex: signature,
      keyHex: key,
      expectedPayload: expectedMessage,
    });
    if (!cip8.ok || !cip8.pubKey) {
      return unauthorized(cip8.reason ?? 'Invalid signature');
    }

    // ---- (i) pubkey → claimed-address credential binding (LOAD-BEARING) ----
    //
    // Without this step a valid CIP-8 signature signed by key B could be
    // presented with the victim's address (whose credential is hashed
    // from key A) and the verifier above would still accept the signature
    // math. That's the P0-1 auth-bypass; the legacy verifier closed it
    // with `publicKeyMatchesAddress` and we replicate that exact check
    // here. Malformed/unsupported claimed addresses fail closed (the
    // legacy decoder threw on these and the legacy verifier returned
    // `valid:false` — we map both to the same 401 with a parity reason).
    let decodedClaimed: ReturnType<typeof decodeCardanoAddress>;
    try {
      decodedClaimed = decodeCardanoAddress(walletAddress);
    } catch {
      return unauthorized('Claimed wallet address is malformed or unsupported');
    }
    const pubKeyBuf = Buffer.from(cip8.pubKey);
    const matchResult = publicKeyMatchesAddress(pubKeyBuf, decodedClaimed);
    if (matchResult === 'mismatch') {
      return unauthorized('Public key does not match the claimed wallet address');
    }
    if (matchResult === 'script-credential') {
      return unauthorized('Script-credential addresses are not supported for login');
    }

    // ---- (ii) header address vs claimed-address cross-check (defense-in-depth) ----
    //
    // When the COSE protected header carried an `address` field, the
    // ported verifier already bound the pubkey to THAT address. The
    // legacy verifier additionally required that the header address
    // equal the CLAIMED `walletAddress` byte-for-byte — so a wallet
    // can't sign a CIP-30 message addressed to A and then submit it
    // claiming a different valid address B that happens to share the
    // same credential (the base/stake address pair case from the legacy
    // parity test). When the header omitted the field
    // (`addressBound===false`), this check is skipped — exactly as the
    // legacy verifier silently skipped it when the header decode
    // produced no address.
    if (cip8.addressBound === true && cip8.addressBytes) {
      if (!Buffer.from(cip8.addressBytes).equals(decodedClaimed.bytes)) {
        return unauthorized(
          'COSE_Sign1 protected-header address does not match the claimed wallet address',
        );
      }
    }

    // 3. Atomically consume the nonce. If two requests with valid signatures
    //    race for the same nonce, only one wins; the other gets 401.
    const consume = await consumeChallenge(nonce);
    if (!consume.valid) {
      return unauthorized(consume.reason ?? 'Challenge already consumed');
    }

    // ---- Canonical identity ----
    // The wallet may have signed in with a base/payment address (`addr1…`) when
    // it doesn't expose a reward address. The platform identifies users by their
    // STAKE address everywhere (users PK, JWT sub, committee membership), so
    // normalise to the stake form here — at the one boundary where identity is
    // minted. The SIGNATURE was verified against the raw address above (the
    // credential check accepts either form); from here down everything keys off
    // `identity`. Idempotent for stake-address logins; falls back to the raw
    // value only for enterprise addresses (no stake credential — a rare edge).
    const identity = normalizeToStakeAddress(walletAddress) ?? walletAddress;

    // 3. Upsert user record in DynamoDB
    const now = new Date().toISOString();
    const sessionType: SessionType = body.rememberMe ? 'remember_me' : 'normal';

    // Fetch existing user to preserve roles/profile
    const existing = await getItem<UserItem>(tableNames.users, {
      walletAddress: identity,
      SK: 'PROFILE',
    });

    const sessionExpiry = new Date(
      Date.now() + (sessionType === 'remember_me' ? 30 : 7) * 24 * 60 * 60 * 1000,
    ).toISOString();

    // 4. Issue JWT
    const roles = existing?.roles as string[] | undefined;
    const typedRoles: UserRole[] = (roles ?? ['delegator']) as UserRole[];
    // Bootstrap platform admins: seed wallets become platform_admin at login so
    // the role is in the JWT (and thus /auth/me + the FE nav). Persisted on the
    // user row below so it survives even if the wallet later leaves the seed.
    if (isBootstrapAdmin(identity) && !typedRoles.includes('platform_admin')) {
      typedRoles.push('platform_admin');
    }
    // Carry the revocation counter forward so a fresh login does NOT resurrect
    // tokens that a prior logout revoked (the full-row putItem below would
    // otherwise reset tokenVersion to undefined → 0, re-validating old tokens).
    const tokenVersion = typeof existing?.tokenVersion === 'number' ? existing.tokenVersion : 0;

    // ---- Decision #3 — reconcile to a canonical personId ----
    //
    // The legacy CIP-30 login is keyed by the canonical STAKE address (set
    // above as `identity`); that's the same value `onchainVerify` writes for
    // the `proposer` on-chain role (whose credentialType is `'stake'`). So a
    // wallet that logs in via THIS path and the same wallet's later proposer
    // login both resolve into the same `stake:<stakeAddr>` `identity_links`
    // row → same `personId`. Auto-provision the link on a fresh login for an
    // unmapped wallet; on subsequent logins this is an O(1) read that returns
    // the previously-minted personId. Best-effort — `onchainVerify` swallows
    // the same failure mode; if reconciliation here errors, the legacy login
    // MUST still succeed (this is additive, not load-bearing for the existing
    // wallet-login UX).
    let personId: string | undefined;
    try {
      const reconciled = await resolveOrProvisionPerson('stake', identity, 'login');
      personId = reconciled.personId;
    } catch (err) {
      console.warn(
        'verify: person reconciliation failed (non-fatal):',
        err instanceof Error ? err.message : err,
      );
    }

    const { token, expiresAt } = await issueJWT(
      identity,
      typedRoles,
      sessionType,
      existing?.drepId as string | undefined,
      tokenVersion,
      personId ? { personId } : undefined,
    );

    const userItem: UserItem = {
      walletAddress: identity,
      SK: 'PROFILE',
      displayName: existing?.displayName,
      bio: existing?.bio,
      socialLinks: existing?.socialLinks,
      roles: typedRoles,
      // Preserve the registered-DRep link across re-logins. Without this, the
      // full-row putItem below drops drepId and unlinks the user from their
      // committee (FE then shows them as a non-member).
      drepId: existing?.drepId,
      tokenVersion,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      sessionTokenHash: hashValue(token),
      sessionExpiry,
      delegationHistory: existing?.delegationHistory,
    };

    await putItem(tableNames.users, userItem as unknown as Record<string, unknown>);

    // Bust the recognition LRU for this stake (this-container only). A
    // user who re-delegated between two sign-ins would otherwise see the
    // OLD DRep's clubhouse routing for up to 60s. Per-container scope is
    // documented on `_invalidateForStake`; other containers will catch
    // up within their own TTL window. Best-effort — never fail the
    // verify on a cache-eviction error.
    try {
      _invalidateForStake(identity);
    } catch (err) {
      console.warn('verify: recognition cache eviction failed (non-fatal):', err);
    }

    // Best-effort audit AFTER the user-row write succeeds. The actor
    // and entity are both the verified wallet — `auth.login` events
    // colocate per-wallet so `Query(pk='auth#stake1...')` yields a
    // login timeline for incident review.
    await writeAuditEvent({
      entityType: 'auth',
      entityId: identity,
      eventType: 'auth.login',
      actorWallet: identity,
      metadata: {
        sessionType,
        rolesAtIssue: typedRoles,
        isNewUser: existing === undefined,
      },
    });

    const cookieHeader = buildSetCookieHeader(token, sessionType);

    return ok(
      {
        walletAddress: identity,
        roles: typedRoles,
        sessionType,
        expiresAt,
      },
      [cookieHeader],
    );
  } catch (err) {
    console.error('verify handler error:', err);
    return internalError('Authentication failed');
  }
};
