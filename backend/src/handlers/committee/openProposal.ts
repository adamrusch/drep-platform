import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { putItem, tableNames } from '../../lib/dynamodb';
import type { CommitteePosition, CommitteeVoteProposalItem } from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { writeAuditEvent } from '../../lib/audit';
import { getCurrentEpochInfo } from '../../lib/koios';
import { created, badRequest, notFound, conflict, handleError } from '../_response';
import {
  assertCommitteeMember,
  currentApprovalRule,
  loadCommittee,
  loadGovernanceAction,
  loadProposal,
  voteScopeOf,
} from './_committee';

/**
 * Opening a proposal is intentionally a LOW-CEREMONY action: it just queues a
 * governance action for the committee to deliberate and vote on. As of
 * 2026-06 it requires only a valid session (JWT) + committee membership — NO
 * wallet re-signature. The binding actions downstream (casting a vote,
 * closing/passing, and the on-chain submission) DO still re-sign, so a leaked
 * cookie can at worst queue a proposal the group then has to actually vote
 * through. This matches the product decision that a lead shouldn't have to
 * sign just to "make a proposal ready for the group to review."
 */
interface OpenProposalBody {
  actionId: string;
  proposedPosition: CommitteePosition;
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

    // The live "X of N" rule. Snapshotted onto the proposal so a later
    // membership/threshold change can't move this proposal's bar.
    const rule = currentApprovalRule(committee);
    if (rule.approvalThreshold < 1) {
      return badRequest(
        'This committee has no valid approval rule (X of N). Set the consensus rule before opening a proposal.',
      );
    }
    // Decision B guard: a proposal can only open when ENOUGH members have
    // accepted to make reaching the Chair's intended X actually achievable
    // against the frozen eligible-voter set. X does NOT shrink to fit
    // pending invitations — invite acceptances must catch up.
    if (rule.memberCount < rule.approvalThreshold) {
      return badRequest(
        `Not enough members have accepted yet to open a proposal — X of N needs at least ${rule.approvalThreshold} accepted members (currently ${rule.memberCount}).`,
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

    const now = new Date().toISOString();
    const proposal: CommitteeVoteProposalItem = {
      voteScope,
      itemKey: 'PROPOSAL',
      drepId,
      actionId,
      proposedPosition: body.proposedPosition,
      proposerWallet: authCtx.walletAddress,
      status: 'open',
      approvalThreshold: rule.approvalThreshold,
      memberCount: rule.memberCount,
      // Freeze WHO may vote, not just how many — a member added after open
      // cannot vote on this proposal (see castVote).
      memberSnapshot: (committee.members ?? []).map((m) => m.walletAddress),
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
        approvalThreshold: rule.approvalThreshold,
        memberCount: rule.memberCount,
      },
    });

    return created(proposal);
  } catch (err) {
    console.error('committee/openProposal error:', err);
    return handleError(err);
  }
};
