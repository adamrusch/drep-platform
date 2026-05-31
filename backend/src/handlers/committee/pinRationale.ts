import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { updateItem, tableNames } from '../../lib/dynamodb';
import { extractAuthContext } from '../../middleware/role-guard';
import { writeAuditEvent } from '../../lib/audit';
import { pinJsonToIpfs, getStoredIpfsKey } from '../../lib/ipfs';
import { ok, badRequest, forbidden, notFound, conflict, handleError } from '../_response';
import {
  getStage,
  isProposerOrLead,
  loadCommittee,
  loadProposal,
  loadRationaleFinal,
  voteScopeOf,
} from './_committee';

interface PinBody {
  /** Optional one-shot key (prompt-each-time) — overrides the stored key. */
  ipfsProjectId?: string;
}

/**
 * Pin the finalized rationale's canonical JSON to IPFS and attach the URI to
 * RATIONALE#FINAL. Lead/proposer only. Uses the request's one-shot key if
 * given, else the committee's stored key.
 */
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    const drepId = event.pathParameters?.['drepId'];
    const actionIdRaw = event.pathParameters?.['actionId'];
    if (!drepId || !actionIdRaw) return badRequest('drepId and actionId path parameters are required');
    const actionId = decodeURIComponent(actionIdRaw);

    let body: PinBody = {};
    if (event.body) {
      try {
        body = JSON.parse(event.body) as PinBody;
      } catch {
        return badRequest('Invalid JSON body');
      }
    }

    const committee = await loadCommittee(drepId);
    if (!committee) return notFound('Committee');

    const voteScope = voteScopeOf(drepId, actionId);
    const proposal = await loadProposal(voteScope);
    if (!proposal) return notFound('Proposal');
    if (!isProposerOrLead(authCtx, committee, proposal.proposerWallet)) {
      return forbidden('Only the proposer or the lead DRep can pin the rationale');
    }

    const final = await loadRationaleFinal(voteScope);
    if (!final) return conflict('Finalize the rationale before pinning it');

    const stage = getStage();
    const ipfsKey = body.ipfsProjectId?.trim() || (await getStoredIpfsKey(stage, drepId));
    if (!ipfsKey) {
      return badRequest(
        'No IPFS key available. Provide ipfsProjectId in the request, or store one via PUT /committee/{drepId}/ipfs-key.',
      );
    }

    const { cid, uri } = await pinJsonToIpfs(final.canonicalJson, ipfsKey);

    await updateItem(
      tableNames.committeeVotes,
      { voteScope, itemKey: 'RATIONALE#FINAL' },
      'SET ipfsUri = :uri, ipfsCid = :cid',
      {},
      { ':uri': uri, ':cid': cid },
    );

    await writeAuditEvent({
      entityType: 'committee_vote',
      entityId: voteScope,
      eventType: 'committee.rationale.pinned',
      actorWallet: authCtx.walletAddress,
      metadata: { drepId, actionId, ipfsCid: cid },
    });

    return ok({ ipfsUri: uri, ipfsCid: cid, anchorHash: final.anchorHash });
  } catch (err) {
    console.error('committee/pinRationale error:', err);
    return handleError(err);
  }
};
