import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { putItem, tableNames } from '../../lib/dynamodb';
import type { CommitteePosition, CommitteeVoteProposalItem } from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { writeAuditEvent } from '../../lib/audit';
import { committeeMessages } from '../../lib/committeeMessages';
import { getCurrentEpochInfo } from '../../lib/koios';
import { created, badRequest, unauthorized, notFound, conflict, handleError } from '../_response';
import {
  assertCommitteeMember,
  getStage,
  loadCommittee,
  loadGovernanceAction,
  loadProposal,
  loadVotingConfig,
  signatureSnapshot,
  verifyCommitteeResign,
  voteScopeOf,
} from './_committee';

interface OpenProposalBody {
  actionId: string;
  proposedPosition: CommitteePosition;
  mutationNonce: string;
  mutationSignature: string;
  mutationKey: string;
}

const POSITIONS: CommitteePosition[] = ['Yes', 'No', 'Abstain'];

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    const drepId = event.pathParameters?.['drepId'];
    if (!drepId) return badRequest('drepId path parameter is required');
    if (!event.body) return badRequest('Request body is required');

    let body: OpenProposalBody;
    try {
      body = JSON.parse(event.body) as OpenProposalBody;
    } catch {
      return badRequest('Invalid JSON body');
    }

    const actionId = body.actionId?.trim();
    if (!actionId) return badRequest('actionId is required');
    if (!POSITIONS.includes(body.proposedPosition)) {
      return badRequest(`proposedPosition must be one of: ${POSITIONS.join(', ')}`);
    }

    const committee = await loadCommittee(drepId);
    if (!committee) return notFound('Committee');
    assertCommitteeMember(authCtx, committee);

    const config = await loadVotingConfig(drepId);
    // A committee that can't reach quorum can't ever resolve — block at open.
    if ((committee.members?.length ?? 0) < config.quorum) {
      return badRequest(
        `This committee has fewer than ${config.quorum} members and cannot reach quorum. Add members first.`,
      );
    }

    const action = await loadGovernanceAction(actionId);
    if (!action) return notFound('Governance action');

    // Reject opening a proposal on an action whose voting window has closed.
    let currentEpoch: number;
    try {
      const epochInfo = await getCurrentEpochInfo();
      currentEpoch = epochInfo.epoch_no;
    } catch (err) {
      console.error('openProposal: epoch lookup failed:', err);
      return handleError(err);
    }
    if (typeof action.epochDeadline === 'number' && action.epochDeadline < currentEpoch) {
      return badRequest('This governance action\'s voting deadline has already passed');
    }

    const voteScope = voteScopeOf(drepId, actionId);
    const existing = await loadProposal(voteScope);
    if (existing) {
      if (existing.status === 'open') {
        return conflict('A proposal is already open for this action');
      }
      if (existing.status !== 'withdrawn') {
        return conflict('This committee has already decided this governance action');
      }
      // withdrawn → fall through and overwrite with a fresh proposal (Q1).
    }

    const message = committeeMessages.proposal(
      getStage(), drepId, actionId, body.proposedPosition, body.mutationNonce, authCtx.walletAddress,
    );
    const reason = await verifyCommitteeResign(authCtx.walletAddress, body, message);
    if (reason) return unauthorized(reason);

    const now = new Date().toISOString();
    const proposal: CommitteeVoteProposalItem = {
      voteScope,
      itemKey: 'PROPOSAL',
      drepId,
      actionId,
      proposedPosition: body.proposedPosition,
      proposerWallet: authCtx.walletAddress,
      proposerSignature: signatureSnapshot(body, message),
      status: 'open',
      thresholdPct: config.thresholdPct,
      quorum: config.quorum,
      epochDeadline: typeof action.epochDeadline === 'number' ? action.epochDeadline : 0,
      statusPartition: 'OPEN',
      openedAt: now,
    };
    // Overwrites only a prior withdrawn proposal; the open/terminal guards above
    // already rejected every other case, so a plain Put is safe here.
    await putItem(tableNames.committeeVotes, proposal as unknown as Record<string, unknown>);

    await writeAuditEvent({
      entityType: 'committee_vote',
      entityId: voteScope,
      eventType: 'committee.proposal.opened',
      actorWallet: authCtx.walletAddress,
      metadata: {
        drepId,
        actionId,
        proposedPosition: body.proposedPosition,
        thresholdPct: config.thresholdPct,
        quorum: config.quorum,
      },
    });

    return created(proposal);
  } catch (err) {
    console.error('committee/openProposal error:', err);
    return handleError(err);
  }
};
