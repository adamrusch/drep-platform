import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { extractAuthContext } from '../../middleware/role-guard';
import { ok, badRequest, notFound, handleError } from '../_response';
import {
  assertCommitteeMember,
  isLockActive,
  loadCommittee,
  loadRationaleDraft,
  loadRationaleFinal,
  loadRationaleLock,
  loadVotingConfig,
  voteScopeOf,
} from './_committee';

/** Member-only read of the working draft + lock state + finalized rationale
 *  (drafts are member-only per Q3; the finalized version is public via the
 *  rationales browse surface). */
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
    const voteScope = voteScopeOf(drepId, actionId);
    const nowSec = Math.floor(Date.now() / 1000);

    const [draft, lock, final] = await Promise.all([
      loadRationaleDraft(voteScope),
      loadRationaleLock(voteScope),
      loadRationaleFinal(voteScope),
    ]);

    const activeLock = isLockActive(lock, nowSec) ? lock : undefined;

    return ok({
      mode: config.item?.rationaleMode ?? 'lead',
      assignedEditor: config.item?.assignedEditor,
      draft: draft ?? null,
      lock: activeLock
        ? { editorWallet: activeLock.editorWallet, expiresAt: activeLock.expiresAt, heldByMe: activeLock.editorWallet === authCtx.walletAddress }
        : null,
      final: final
        ? { anchorHash: final.anchorHash, ipfsUri: final.ipfsUri, finalizedBy: final.finalizedBy, finalizedAt: final.finalizedAt }
        : null,
    });
  } catch (err) {
    console.error('committee/getRationale error:', err);
    return handleError(err);
  }
};
