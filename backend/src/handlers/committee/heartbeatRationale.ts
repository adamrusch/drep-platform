import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { updateItem, tableNames } from '../../lib/dynamodb';
import { nowISO, nowSec } from '../../lib/time';
import { extractAuthContext } from '../../middleware/role-guard';
import { ok, badRequest, conflict, handleError } from '../_response';
import { RATIONALE_LOCK_TTL_SEC, voteScopeOf } from './_committee';

/** Extend the caller's edit lock (POST .../rationale/lock/heartbeat). */
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    const drepId = event.pathParameters?.['drepId'];
    const actionIdRaw = event.pathParameters?.['actionId'];
    if (!drepId || !actionIdRaw) return badRequest('drepId and actionId path parameters are required');
    const actionId = decodeURIComponent(actionIdRaw);

    const voteScope = voteScopeOf(drepId, actionId);
    const now = nowSec();
    const expiresAt = now + RATIONALE_LOCK_TTL_SEC;

    try {
      // Only the current, unexpired holder can extend.
      await updateItem(
        tableNames.committeeVotes,
        { voteScope, itemKey: 'RATIONALE#LOCK' },
        'SET lastHeartbeat = :now, #exp = :exp',
        { '#exp': 'expiresAt' },
        { ':now': nowISO(), ':exp': expiresAt, ':me': authCtx.walletAddress, ':nowSec': now },
        'attribute_exists(itemKey) AND editorWallet = :me AND #exp >= :nowSec',
      );
    } catch (err) {
      if (err && typeof err === 'object' && (err as { name?: string }).name === 'ConditionalCheckFailedException') {
        return conflict('Your edit lock has expired or was taken over. Re-acquire it to continue.');
      }
      throw err;
    }

    return ok({ expiresAt });
  } catch (err) {
    console.error('committee/heartbeatRationale error:', err);
    return handleError(err);
  }
};
