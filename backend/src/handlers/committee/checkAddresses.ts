import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { batchGetItems, tableNames } from '../../lib/dynamodb';
import type { UserItem } from '../../lib/types';
import { normalizeToStakeAddress } from '../../lib/cardanoAddress';
import { ok, badRequest, handleError } from '../_response';

interface CheckBody {
  addresses: string[];
}

const MAX = 50;

interface AddressStatus {
  input: string;
  /** Whether the input parsed to a stake identity. */
  valid: boolean;
  /** Canonical stake address (the platform identity), when valid. */
  stakeAddress?: string;
  /** True when that stake address has ever logged into the platform. */
  active: boolean;
  displayName?: string;
}

/**
 * POST /committee/check-members — for the committee-formation wizard. Given a
 * list of Cardano addresses (payment or stake form), return each one's platform
 * status: valid?, its canonical stake identity, and whether it has ever logged
 * in (active). Inactive addresses are allowed as members — they just need to be
 * invited to sign in. Auth-gated (any signed-in user) but reveals only
 * existence + public display name.
 */
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    if (!event.body) return badRequest('Request body is required');
    let body: CheckBody;
    try {
      body = JSON.parse(event.body) as CheckBody;
    } catch {
      return badRequest('Invalid JSON body');
    }
    const inputs = Array.isArray(body.addresses) ? body.addresses : [];
    if (inputs.length > MAX) return badRequest(`At most ${MAX} addresses per request.`);

    // Normalise each input to its stake identity.
    const normalized = inputs.map((raw) => {
      const input = (raw ?? '').trim();
      return { input, stake: input ? normalizeToStakeAddress(input) : null };
    });

    // One batched read for all the valid stake addresses.
    const stakes = [...new Set(normalized.map((n) => n.stake).filter((s): s is string => Boolean(s)))];
    const rows =
      stakes.length > 0
        ? await batchGetItems<UserItem>(
            tableNames.users,
            stakes.map((s) => ({ walletAddress: s, SK: 'PROFILE' })),
          )
        : [];
    const byStake = new Map(rows.map((r) => [r.walletAddress, r]));

    const results: AddressStatus[] = normalized.map(({ input, stake }) => {
      if (!stake) return { input, valid: false, active: false };
      const user = byStake.get(stake);
      return {
        input,
        valid: true,
        stakeAddress: stake,
        active: Boolean(user),
        ...(user?.displayName ? { displayName: user.displayName as string } : {}),
      };
    });

    return ok({ results });
  } catch (err) {
    console.error('committee/checkAddresses error:', err);
    return handleError(err);
  }
};
