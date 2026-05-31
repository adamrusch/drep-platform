import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { extractAuthContext } from '../../middleware/role-guard';
import { writeAuditEvent } from '../../lib/audit';
import { committeeMessages } from '../../lib/committeeMessages';
import { hasStoredIpfsKey, storeIpfsKey } from '../../lib/ipfs';
import { ok, badRequest, unauthorized, notFound, handleError } from '../_response';
import { assertCommitteeLead, getStage, loadCommittee, verifyCommitteeResign } from './_committee';

interface PutIpfsKeyBody {
  ipfsProjectId: string;
  mutationNonce: string;
  mutationSignature: string;
  mutationKey: string;
}

/**
 * Store (PUT) or check (GET) the committee's IPFS pinning key. Stored encrypted
 * in Secrets Manager; the value is never returned. Lead only.
 */
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    const drepId = event.pathParameters?.['drepId'];
    if (!drepId) return badRequest('drepId path parameter is required');

    const committee = await loadCommittee(drepId);
    if (!committee) return notFound('Committee');
    assertCommitteeLead(authCtx, committee);

    const stage = getStage();

    if (event.requestContext.http.method === 'GET') {
      return ok({ stored: await hasStoredIpfsKey(stage, drepId) });
    }

    if (!event.body) return badRequest('Request body is required');
    let body: PutIpfsKeyBody;
    try {
      body = JSON.parse(event.body) as PutIpfsKeyBody;
    } catch {
      return badRequest('Invalid JSON body');
    }
    if (!body.ipfsProjectId || body.ipfsProjectId.trim().length === 0) {
      return badRequest('ipfsProjectId is required');
    }

    // Storing a long-lived pinning secret is privileged — require a fresh
    // CIP-30 re-sign, not just the session cookie.
    const message = committeeMessages.ipfsKey(stage, drepId, body.mutationNonce, authCtx.walletAddress);
    const reason = await verifyCommitteeResign(authCtx.walletAddress, body, message);
    if (reason) return unauthorized(reason);

    await storeIpfsKey(stage, drepId, body.ipfsProjectId.trim());

    await writeAuditEvent({
      entityType: 'drep_committee',
      entityId: drepId,
      eventType: 'committee.ipfs_key.stored',
      actorWallet: authCtx.walletAddress,
      metadata: { drepId },
    });

    return ok({ stored: true });
  } catch (err) {
    console.error('committee/ipfsKey error:', err);
    return handleError(err);
  }
};
