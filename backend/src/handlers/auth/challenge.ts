/**
 * POST /auth/challenge
 *
 * Step 1 of the wallet auth flow. Issues a 32-byte challenge nonce + a
 * human-readable sign-message bound to the requested `walletAddress`.
 * The nonce is persisted to `auth_nonces` with a 5-minute TTL.
 *
 * Public endpoint (no JWT cookie required) — issuing a challenge for an
 * arbitrary address is harmless because it can't be used without a real
 * Ed25519 signature in the follow-up `/auth/verify` call.
 *
 * Validation: the `walletAddress` must start with `addr` (mainnet payment
 * address) or `stake` (stake address). We don't bech32-decode here —
 * malformed addresses surface as a verification failure on `/auth/verify`,
 * where the signature math will reject them.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { generateChallenge } from '../../lib/auth';
import { ok, badRequest, internalError } from '../_response';

interface ChallengeRequestBody {
  walletAddress: string;
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  try {
    if (!event.body) {
      return badRequest('Request body is required');
    }

    let body: ChallengeRequestBody;
    try {
      body = JSON.parse(event.body) as ChallengeRequestBody;
    } catch {
      return badRequest('Invalid JSON body');
    }

    if (!body.walletAddress || typeof body.walletAddress !== 'string') {
      return badRequest('walletAddress is required');
    }

    if (
      !body.walletAddress.startsWith('addr') &&
      !body.walletAddress.startsWith('stake')
    ) {
      return badRequest('Invalid Cardano wallet address format');
    }

    const challenge = await generateChallenge(body.walletAddress);

    return ok({
      nonce: challenge.nonce,
      message: challenge.message,
      expiresAt: challenge.expiresAt,
    });
  } catch (err) {
    console.error('challenge handler error:', err);
    return internalError('Failed to generate challenge');
  }
};
