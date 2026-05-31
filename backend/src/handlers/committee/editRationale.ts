import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { putItem, deleteItem, tableNames } from '../../lib/dynamodb';
import type { CommitteeRationaleDraftItem } from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { writeAuditEvent } from '../../lib/audit';
import { ok, badRequest, forbidden, notFound, conflict, handleError } from '../_response';
import {
  checkRationaleEditAuth,
  loadCommittee,
  loadRationaleDraft,
  loadRationaleLock,
  loadVotingConfig,
  voteScopeOf,
} from './_committee';

interface EditRationaleBody {
  rationaleStatement: string;
  summary?: string;
  precedentDiscussion?: string;
  counterargumentDiscussion?: string;
  conclusion?: string;
  internalVote?: CommitteeRationaleDraftItem['internalVote'];
  references?: CommitteeRationaleDraftItem['references'];
  authors?: CommitteeRationaleDraftItem['authors'];
  /** Optimistic-concurrency token — the updatedAt the client last read. */
  expectedUpdatedAt?: string;
}

const MAX_BYTES = 60 * 1024; // matches the sync's anchor-body truncation

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    const drepId = event.pathParameters?.['drepId'];
    const actionIdRaw = event.pathParameters?.['actionId'];
    if (!drepId || !actionIdRaw) return badRequest('drepId and actionId path parameters are required');
    const actionId = decodeURIComponent(actionIdRaw);
    if (!event.body) return badRequest('Request body is required');

    let body: EditRationaleBody;
    try {
      body = JSON.parse(event.body) as EditRationaleBody;
    } catch {
      return badRequest('Invalid JSON body');
    }
    if (!body.rationaleStatement || body.rationaleStatement.trim().length === 0) {
      return badRequest('rationaleStatement is required');
    }
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_BYTES) {
      return badRequest('Rationale exceeds the 60 KB limit');
    }

    const committee = await loadCommittee(drepId);
    if (!committee) return notFound('Committee');

    const config = await loadVotingConfig(drepId);
    const mode = config.item?.rationaleMode ?? 'lead';
    const voteScope = voteScopeOf(drepId, actionId);
    const nowSec = Math.floor(Date.now() / 1000);
    const lock = mode === 'collaborative' ? await loadRationaleLock(voteScope) : undefined;

    const denial = checkRationaleEditAuth(
      authCtx.walletAddress, committee, mode, config.item?.assignedEditor, lock, nowSec,
    );
    if (denial) {
      return denial.code === 403 ? forbidden(denial.message) : conflict(denial.message);
    }

    const existing = await loadRationaleDraft(voteScope);
    // Optimistic concurrency: reject a stale write so simultaneous editors
    // don't silently clobber each other.
    if (existing && body.expectedUpdatedAt !== undefined && body.expectedUpdatedAt !== existing.updatedAt) {
      return conflict(
        JSON.stringify({
          message: 'This rationale was edited since you loaded it. Reload to see the latest.',
          currentUpdatedAt: existing.updatedAt,
        }),
      );
    }

    const now = new Date().toISOString();
    const timeline = (existing?.editorTimeline ?? []).concat({ wallet: authCtx.walletAddress, editedAt: now }).slice(-100);

    const draft: CommitteeRationaleDraftItem = {
      voteScope,
      itemKey: 'RATIONALE#DRAFT',
      drepId,
      actionId,
      rationaleStatement: body.rationaleStatement,
      ...(body.summary ? { summary: body.summary } : {}),
      ...(body.precedentDiscussion ? { precedentDiscussion: body.precedentDiscussion } : {}),
      ...(body.counterargumentDiscussion ? { counterargumentDiscussion: body.counterargumentDiscussion } : {}),
      ...(body.conclusion ? { conclusion: body.conclusion } : {}),
      ...(body.internalVote ? { internalVote: body.internalVote } : {}),
      ...(body.references ? { references: body.references } : {}),
      ...(body.authors ? { authors: body.authors } : {}),
      updatedAt: now,
      editorTimeline: timeline,
    };
    await putItem(tableNames.committeeVotes, draft as unknown as Record<string, unknown>);

    // Collaborative: saving closes the edit session — release the lock.
    if (mode === 'collaborative' && lock?.editorWallet === authCtx.walletAddress) {
      await deleteItem(tableNames.committeeVotes, { voteScope, itemKey: 'RATIONALE#LOCK' });
    }

    await writeAuditEvent({
      entityType: 'committee_vote',
      entityId: voteScope,
      eventType: 'committee.rationale.edited',
      actorWallet: authCtx.walletAddress,
      metadata: { drepId, actionId, mode },
    });

    return ok(draft);
  } catch (err) {
    console.error('committee/editRationale error:', err);
    return handleError(err);
  }
};
