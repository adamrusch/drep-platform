import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { transactWrite, tableNames } from '../../lib/dynamodb';
import type { CommitteeRationaleFinalItem } from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { writeAuditEvent } from '../../lib/audit';
import { committeeMessages } from '../../lib/committeeMessages';
import { buildRationaleAnchor } from '../../lib/rationaleAnchor';
import { ok, badRequest, unauthorized, forbidden, notFound, conflict, handleError } from '../_response';
import {
  getStage,
  isProposerOrLead,
  loadCommittee,
  loadProposal,
  loadRationaleDraft,
  signatureSnapshot,
  verifyCommitteeResign,
  voteScopeOf,
} from './_committee';

interface FinalizeBody {
  mutationNonce: string;
  mutationSignature: string;
  mutationKey: string;
}

/**
 * Lock the rationale: canonicalize the CIP-100/108 body, compute the
 * blake2b-256 anchor hash over the exact bytes, and write RATIONALE#FINAL.
 * Lead or proposer only, re-signed. The pinned IPFS URI is attached later at
 * submit time (step 9) — the hash is stable from here on.
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
    if (!event.body) return badRequest('Request body (re-sign) is required');

    let body: FinalizeBody;
    try {
      body = JSON.parse(event.body) as FinalizeBody;
    } catch {
      return badRequest('Invalid JSON body');
    }

    const committee = await loadCommittee(drepId);
    if (!committee) return notFound('Committee');

    const voteScope = voteScopeOf(drepId, actionId);
    const proposal = await loadProposal(voteScope);
    if (!proposal) return notFound('Proposal');
    if (!isProposerOrLead(authCtx, committee, proposal.proposerWallet)) {
      return forbidden('Only the proposer or the lead DRep can finalize the rationale');
    }

    const draft = await loadRationaleDraft(voteScope);
    if (!draft || !draft.rationaleStatement?.trim()) {
      return conflict('There is no rationale draft to finalize');
    }

    const message = committeeMessages.rationaleFinalize(
      getStage(), drepId, actionId, body.mutationNonce, authCtx.walletAddress,
    );
    const reason = await verifyCommitteeResign(authCtx.walletAddress, body, message);
    if (reason) return unauthorized(reason);

    const { canonicalJson, anchorHash } = buildRationaleAnchor(draft, {
      drepId, actionId, position: proposal.proposedPosition,
    });

    const now = new Date().toISOString();
    const final: CommitteeRationaleFinalItem = {
      voteScope,
      itemKey: 'RATIONALE#FINAL',
      drepId,
      actionId,
      canonicalJson,
      anchorHash,
      hashAlgorithm: 'blake2b-256',
      finalizedBy: authCtx.walletAddress,
      finalizedAt: now,
    };
    // Finalize is re-runnable BEFORE submission (fix a typo, re-lock) but MUST
    // be frozen once an on-chain SUBMISSION receipt exists — otherwise the FINAL
    // row's canonicalJson/anchorHash could drift away from what mainnet's anchor
    // hash references, producing content that no longer verifies against chain.
    // Atomic: a ConditionCheck that SUBMISSION does not exist, gating the Put.
    try {
      await transactWrite([
        {
          ConditionCheck: {
            TableName: tableNames.committeeVotes,
            Key: { voteScope, itemKey: 'SUBMISSION' },
            ConditionExpression: 'attribute_not_exists(itemKey)',
          },
        },
        {
          Put: {
            TableName: tableNames.committeeVotes,
            Item: final as unknown as Record<string, unknown>,
          },
        },
      ]);
    } catch (err) {
      if (err && typeof err === 'object' && (err as { name?: string }).name === 'TransactionCanceledException') {
        return conflict(
          'This vote has already been submitted on-chain; its rationale is locked and can no longer be re-finalized.',
        );
      }
      throw err;
    }

    await writeAuditEvent({
      entityType: 'committee_vote',
      entityId: voteScope,
      eventType: 'committee.rationale.finalized',
      actorWallet: authCtx.walletAddress,
      metadata: { drepId, actionId, anchorHash, signature: signatureSnapshot(body, message).mutationSignature },
    });

    return ok({ anchorHash, hashAlgorithm: 'blake2b-256', finalizedAt: now, canonicalJson });
  } catch (err) {
    console.error('committee/finalizeRationale error:', err);
    return handleError(err);
  }
};
