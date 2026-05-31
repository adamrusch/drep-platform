import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { deleteItem, tableNames } from '../../lib/dynamodb';
import { extractAuthContext } from '../../middleware/role-guard';
import { noContent, badRequest, handleError } from '../_response';
import { loadRationaleLock, voteScopeOf } from './_committee';

/** Release the caller's edit lock (POST .../rationale/lock/release). Idempotent:
 *  a no-op if the caller doesn't hold it (someone else took over, or it
 *  expired). */
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
    const lock = await loadRationaleLock(voteScope);
    if (lock && lock.editorWallet === authCtx.walletAddress) {
      await deleteItem(tableNames.committeeVotes, { voteScope, itemKey: 'RATIONALE#LOCK' });
    }
    return noContent();
  } catch (err) {
    console.error('committee/releaseRationale error:', err);
    return handleError(err);
  }
};
