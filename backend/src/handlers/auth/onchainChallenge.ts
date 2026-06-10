/**
 * POST /auth/onchain/challenge
 *
 * Sprint 1 — issues a stage-bound nonce payload the client signs to prove
 * on-chain control of a DRep / Proposer (CIP-8 / CIP-30 COSE) OR SPO /
 * CC role (raw Ed25519 paste). The verify counterpart is
 * `onchainVerify.ts`.
 *
 * This is a PARALLEL surface to the legacy `/auth/challenge` — the latter
 * still owns CIP-30 wallet login for the existing user base and is
 * UNTOUCHED by this sprint. The two flows produce different cookie
 * names (`access_token` vs `access_token_onchain`), different message
 * formats (legacy: human-readable "drep-platform wants you to sign in";
 * onchain: machine-readable `dreptalk:stage:domain:nonce:ts`), and
 * different JWT shapes (legacy `roles`-only; onchain `roles` +
 * `onChainRoles`).
 *
 * The handler is public — the nonce alone is harmless without a signature.
 *
 * Uses the ported `identity/auth/handlers.ts` so the nonce shape, store
 * semantics, and stage binding stay in lock-step with the verify handler.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { handleChallenge } from '../../lib/identity/auth/handlers';
import { DynamoDbNonceStore } from '../../lib/identity/stores/nonceStore.dynamodb';
import { ok, internalError } from '../_response';

export const handler = async (
  _event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const stage = process.env['STAGE'] ?? 'dev';
    // The domain identifies the issuer in the signed payload — kept stable
    // across stages so a signature can be reasoned about offline (the
    // user sees `dreptalk:test:drep.tools:...` in their wallet's signing
    // dialog and knows what they're authorising). The stage binding is
    // the load-bearing replay defense, not the domain.
    const domain = process.env['ONCHAIN_LOGIN_DOMAIN'] ?? 'drep.tools';
    const nonceStore = new DynamoDbNonceStore();

    const result = await handleChallenge({ nonceStore, domain, stage });

    return ok({ payload: result.payload });
  } catch (err) {
    console.error('onchainChallenge handler error:', err);
    return internalError('Failed to issue on-chain challenge');
  }
};
