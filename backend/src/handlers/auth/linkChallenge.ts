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
 * This handler reuses the SAME nonce machinery as the login flow
 * (`identity/auth/handlers.ts` → `handleChallenge`) — same stage
 * binding, same single-use semantics, same TTL. The user then signs
 * the returned payload with the NEW credential's key; the
 * `linkVerify` counterpart consumes the nonce and runs the same
 * signature-verification rigor as the login path (CIP-8 COSE for
 * drep/proposer/stake-wallet, raw Ed25519 for spo/cc).
 *
 * # Why the message is opaque (no role / personId embed)
 *
 * Unlike the legacy `/drep/link/challenge` flow (which embeds the
 * wallet + drepId in the signed message so swapping victims is
 * detected at signature-payload-equality), this flow doesn't need
 * the embed because the link/verify call carries:
 *   - The session's `personId` (from the JWT context — server-side,
 *     not in the signed bytes).
 *   - The new credential's identifier (derived from the verified
 *     signature, not from a request body field).
 *
 * The credentialId is DERIVED from the verified pubkey on verify —
 * it cannot be swapped in by an attacker. The personId is bound to
 * the session, not the message. So the message only needs to be a
 * fresh, stage-bound, single-use nonce — exactly what the identity
 * module's challenge issuer produces.
 */
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { extractAuthContext } from '../../middleware/role-guard';
import { handleChallenge } from '../../lib/identity/auth/handlers';
import { DynamoDbNonceStore } from '../../lib/identity/stores/nonceStore.dynamodb';
import { ok, internalError, unauthorized } from '../_response';

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    // Pull auth context to confirm there's a session; we do not
    // require a personId on the JWT (pre-Decision-3 tokens may omit
    // it). The verify counterpart resolves the personId at that
    // step, falling back to a credential→person re-resolve when the
    // JWT lacks it.
    const authCtx = extractAuthContext(event);
    if (!authCtx.walletAddress) {
      return unauthorized('A session is required to link a credential.');
    }

    const stage = process.env['STAGE'] ?? 'dev';
    // Reuse the same domain the login challenge uses so the user sees
    // a familiar `dreptalk:<stage>:drep.tools:...` prefix in the
    // wallet signing dialog. The stage binding (not the domain) is
    // the load-bearing replay defence.
    const domain = process.env['ONCHAIN_LOGIN_DOMAIN'] ?? 'drep.tools';
    const nonceStore = new DynamoDbNonceStore();

    const result = await handleChallenge({ nonceStore, domain, stage });
    return ok({ payload: result.payload });
  } catch (err) {
    if (err instanceof Error && err.name === 'AuthorizationError') {
      return unauthorized(err.message);
    }
    console.error('linkChallenge handler error:', err);
    return internalError('Failed to issue link challenge');
  }
};
