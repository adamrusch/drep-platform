import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { extractAuthContext } from '../../middleware/role-guard';
import { drepIdFromDRepKey } from '../../lib/drepId';
import { generateDRepLinkNonce } from '../../lib/auth';
import { ok, badRequest, handleError } from '../_response';

interface ChallengeBody {
  /** CIP-95 DRep public key (hex, 32 bytes). From `cip95.getPubDRepKey()`. */
  drepKey?: string;
}

/**
 * POST /drep/link/challenge
 *
 * Issue a single-use nonce + the exact message the wallet must sign with
 * its CIP-95 DRep key, embedded with the caller's wallet address AND the
 * drep id derived from the supplied `drepKey`. The verify step (POST
 * /drep/link) reconstructs the SAME message from the supplied drepKey and
 * the persisted nonce — so an attacker who steals the message can't reuse
 * it for a different drepKey, and a successful sign-then-verify round
 * trip is a fresh, single-use proof-of-control attestation.
 *
 * # Why we derive the drep id server-side here
 *
 * The frontend will use the SAME drep id in `cip95.signData(<drepId>, ...)`
 * so the signing dialog displays something the user recognises (their
 * DRep). The drep id is derived from `drepKey` by `drepIdFromDRepKey` —
 * deterministic, so we can re-derive it during verify and confirm the
 * caller's drepKey/drepId pair is internally consistent before issuing
 * the message.
 */
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    if (!event.body) return badRequest('Request body is required');

    let body: ChallengeBody;
    try {
      body = JSON.parse(event.body) as ChallengeBody;
    } catch {
      return badRequest('Invalid JSON body');
    }

    const drepKey = body.drepKey?.trim();
    if (!drepKey || !/^[0-9a-fA-F]{64}$/.test(drepKey)) {
      return badRequest('drepKey is required and must be a 32-byte hex Ed25519 public key');
    }

    let drepId: string;
    try {
      drepId = drepIdFromDRepKey(drepKey);
    } catch {
      return badRequest('Invalid CIP-95 DRep key');
    }

    const { nonce, message, expiresAt } = await generateDRepLinkNonce(
      authCtx.walletAddress,
      drepId,
    );

    return ok({ nonce, message, expiresAt, drepId });
  } catch (err) {
    console.error('drep/linkChallenge error:', err);
    return handleError(err);
  }
};
