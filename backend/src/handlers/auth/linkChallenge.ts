/**
 * POST /auth/onchain/link/challenge
 *
 * Decision #3 (2026-06-10) — credential-linking flow, challenge step.
 *
 * The caller MUST already be signed in via the on-chain login flow
 * (the route is auth-gated). They are about to link an ADDITIONAL
 * on-chain credential to their existing canonical `personId` — e.g.
 * a wallet user who logged in as a DRep wants to also link their
 * SPO Calidus key so the SPO surface recognises them as the same
 * person.
 *
 * # M1 fix (2026-06-10 security review) — personId binding
 *
 * The challenge payload binds the CALLER'S personId into the signed
 * bytes via the new `dreptalk-link:<personId>:<stage>:<domain>:...`
 * format (see `LINK_PAYLOAD_PREFIX` in `auth/nonce.ts`). Previously
 * the message was an opaque nonce, allowing an attacker authenticated
 * as person P_A to get a victim (never-logged-in) to sign P_A's
 * link challenge — `linkVerify` would then attach the victim's
 * credential to P_A. With the personId baked into the wire bytes the
 * wallet signs, the verify path can cross-check the embedded
 * personId against the calling session's personId and 4xx when they
 * differ; the victim's wallet is now signing bytes uniquely tied to
 * the attacker's account, and the wallet UI surfaces that personId
 * in its signing dialog so an alert user can spot the mismatch.
 *
 * The credentialId is still DERIVED from the verified pubkey on
 * verify — it cannot be swapped in by an attacker. What changed is
 * that the personId is now bound to the BYTES the user signs, not
 * just to the server-side session.
 *
 * # Verify-side parity
 *
 * The verify counterpart parses the bound personId out of the signed
 * payload, resolves the caller's session personId (JWT claim or
 * credential→person fallback for pre-Decision-3 tokens), and rejects
 * the request when the two don't match. See `linkVerify.ts`.
 */
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { extractAuthContext } from '../../middleware/role-guard';
import {
  issueNonce,
  LINK_PAYLOAD_PREFIX,
} from '../../lib/identity/auth/nonce';
import { DynamoDbNonceStore } from '../../lib/identity/stores/nonceStore.dynamodb';
import {
  credentialTypeForRole,
  getIdentityLink,
  identityKeyFor,
  resolveOrProvisionPerson,
} from '../../lib/identityPerson';
import { ok, internalError, unauthorized } from '../_response';

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    // Pull auth context to confirm there's a session.
    const authCtx = extractAuthContext(event);
    if (!authCtx.walletAddress) {
      return unauthorized('A session is required to link a credential.');
    }
    // S1 fix (2026-06-10 security review) — on-chain endpoints must
    // reject legacy-cookie sessions. Primary signal is the
    // authorizer-forwarded `tokenSource === 'legacy'`. Backstop
    // signal (for in-flight authorizers that pre-date S1) is an
    // empty `onChainRoles[]` array — every legacy session has it
    // empty. The two-pronged check protects both during rollout and
    // after a future authorizer regression.
    if (authCtx.tokenSource === 'legacy') {
      return unauthorized(
        'This endpoint requires an on-chain session. Sign in via /auth/onchain/verify first.',
      );
    }
    if (!authCtx.onChainRoles || authCtx.onChainRoles.length === 0) {
      return unauthorized(
        'This endpoint requires an on-chain session. Sign in via /auth/onchain/verify first.',
      );
    }

    // ---- Resolve the caller's personId (M1 binding) ----
    //
    // Prefer the JWT claim (set on tokens minted post-Decision-3).
    // For pre-Decision-3 on-chain tokens that omit the claim, fall
    // back to a credential→person re-resolve. SAME logic as
    // `linkVerify.ts` — both endpoints must agree on which personId
    // is bound or the verify-side mismatch check would reject every
    // pre-Decision-3 caller.
    let callerPersonId = authCtx.personId;
    if (!callerPersonId) {
      const carriedRoles = authCtx.onChainRoles ?? [];
      const carriedRole = carriedRoles[0];
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

    const stage = process.env['STAGE'] ?? 'dev';
    // Reuse the same domain the login challenge uses so the user sees
    // a familiar `dreptalk-link:<personId>:<stage>:drep.tools:...`
    // prefix in the wallet signing dialog. The stage binding (not the
    // domain) is the load-bearing cross-stage replay defence; the
    // personId binding (this M1 fix) is the cross-account victim
    // defence.
    const domain = process.env['ONCHAIN_LOGIN_DOMAIN'] ?? 'drep.tools';
    const nonceStore = new DynamoDbNonceStore();

    const { payload } = await issueNonce(nonceStore, {
      domain,
      stage,
      prefix: LINK_PAYLOAD_PREFIX,
      boundContext: callerPersonId,
    });

    return ok({ payload });
  } catch (err) {
    if (err instanceof Error && err.name === 'AuthorizationError') {
      return unauthorized(err.message);
    }
    console.error('linkChallenge handler error:', err);
    return internalError('Failed to issue link challenge');
  }
};
