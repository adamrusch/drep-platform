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

    const challenge = generateChallenge(body.walletAddress);

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
