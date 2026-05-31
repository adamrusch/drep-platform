import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { updateItem, tableNames } from '../../lib/dynamodb';
import type { CommitteeRationaleLockItem } from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { ok, badRequest, notFound, conflict, forbidden, handleError } from '../_response';
import {
  assertCommitteeMember,
  loadCommittee,
  loadRationaleLock,
  loadVotingConfig,
  RATIONALE_LOCK_TTL_SEC,
  voteScopeOf,
} from './_committee';

/** Acquire the collaborative edit lock (POST .../rationale/lock). */
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    const drepId = event.pathParameters?.['drepId'];
    const actionIdRaw = event.pathParameters?.['actionId'];
    if (!drepId || !actionIdRaw) return badRequest('drepId and actionId path parameters are required');
    const actionId = decodeURIComponent(actionIdRaw);

    const committee = await loadCommittee(drepId);
    if (!committee) return notFound('Committee');
    assertCommitteeMember(authCtx, committee);

    const config = await loadVotingConfig(drepId);
    if (config.item?.rationaleMode !== 'collaborative') {
      return forbidden('The edit lock only applies in collaborative rationale mode');
    }

    const voteScope = voteScopeOf(drepId, actionId);
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const nowIso = new Date(nowMs).toISOString();
    const expiresAt = nowSec + RATIONALE_LOCK_TTL_SEC;

    try {
      // Upsert the lock only if it's free, expired, or already ours.
      await updateItem(
        tableNames.committeeVotes,
        { voteScope, itemKey: 'RATIONALE#LOCK' },
        'SET editorWallet = :me, acquiredAt = :now, lastHeartbeat = :now, #exp = :exp',
        { '#exp': 'expiresAt' },
        { ':me': authCtx.walletAddress, ':now': nowIso, ':exp': expiresAt, ':nowSec': nowSec },
        'attribute_not_exists(itemKey) OR #exp < :nowSec OR editorWallet = :me',
      );
    } catch (err) {
      if (err && typeof err === 'object' && (err as { name?: string }).name === 'ConditionalCheckFailedException') {
        const held = await loadRationaleLock(voteScope);
        return conflict(
          held
            ? `${held.editorWallet} is currently editing this rationale. Try again when they're done.`
            : 'Could not acquire the edit lock; please retry.',
        );
      }
      throw err;
    }

    const lock: CommitteeRationaleLockItem = {
      voteScope,
      itemKey: 'RATIONALE#LOCK',
      editorWallet: authCtx.walletAddress,
      acquiredAt: nowIso,
      lastHeartbeat: nowIso,
      expiresAt,
    };
    return ok(lock);
  } catch (err) {
    console.error('committee/lockRationale error:', err);
    return handleError(err);
  }
};
