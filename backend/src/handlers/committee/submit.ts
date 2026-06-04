import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { CommitteePosition } from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { ok, badRequest, notFound, conflict, handleError } from '../_response';
import { canBroadcastGovernanceVote } from '../../lib/stage';
import {
  assertCommitteeLead,
  getStage,
  loadCommittee,
  loadProposal,
  loadRationaleFinal,
  voteScopeOf,
} from './_committee';
import { getItem, tableNames } from '../../lib/dynamodb';

interface SubmitBody {
  /** Proceed without a finalized rationale (after the warn-and-confirm). */
  override?: boolean;
}

/** CIP-1694 VoteKind: No=0, Yes=1, Abstain=2. */
function positionToVoteKind(p: CommitteePosition): number {
  return p === 'Yes' ? 1 : p === 'No' ? 0 : 2;
}

/**
 * Build the on-chain submission payload for a passed proposal and decide
 * whether broadcast is allowed. The broadcast decision is delegated to
 * `canBroadcastGovernanceVote(authCtx)`:
 *   - prod  → any lead may broadcast (the lead check is its own gate).
 *   - test  → restricted to `platform_admin`, because the test environment
 *             is wired to MAINNET and a successful broadcast casts a real,
 *             irrevocable DRep vote that costs real ADA. Non-admin leads on
 *             test see a "not yet available for your account" message; the
 *             payload still assembles (so the UI can show the readiness
 *             card) but the wallet build/sign/broadcast flow stays hidden.
 *   - other → never (dev / unset stages have no production data to vote on).
 * Lead only — `assertCommitteeLead` continues to gate THIS committee's lead.
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

    let body: SubmitBody = {};
    if (event.body) {
      try {
        body = JSON.parse(event.body) as SubmitBody;
      } catch {
        return badRequest('Invalid JSON body');
      }
    }

    const committee = await loadCommittee(drepId);
    if (!committee) return notFound('Committee');
    assertCommitteeLead(authCtx, committee);

    const voteScope = voteScopeOf(drepId, actionId);
    const proposal = await loadProposal(voteScope);
    if (!proposal) return notFound('Proposal');
    if (proposal.status !== 'passed') {
      return conflict('Only a passed proposal can be submitted on-chain');
    }

    // Already submitted?
    const existing = await getItem(tableNames.committeeVotes, { voteScope, itemKey: 'SUBMISSION' });
    if (existing) return conflict('This vote has already been submitted on-chain');

    // Rationale: required by default, but the lead may override after a warning.
    const final = await loadRationaleFinal(voteScope);
    if (!final && !body.override) {
      return conflict(
        JSON.stringify({
          requiresRationaleOverride: true,
          message: 'No finalized rationale. Submitting without one is discouraged; resend with override=true to proceed.',
        }),
      );
    }

    const stage = getStage();
    const broadcastAllowed = canBroadcastGovernanceVote(authCtx);

    // Messaging:
    //   - prod + allowed: business as usual.
    //   - test + non-admin lead: "not yet available for your account" — we
    //     deliberately do NOT say "this works on prod", because there is no
    //     separate prod copy of this committee's vote: prod and test point
    //     at the same mainnet governance action, so a "switch to prod"
    //     instruction would be misleading.
    //   - dev / unset: fall back to the historical "submit from production"
    //     message — these stages have no governance data to cast against.
    const message = broadcastAllowed
      ? 'Ready to submit. Sign the vote transaction with your wallet.'
      : stage === 'test'
        ? 'On-chain submission on the test environment is restricted to platform admins (test casts REAL mainnet votes). This feature is not yet available for your account.'
        : 'This vote is assembled and ready — but it must be submitted from the production environment.';

    return ok({
      ready: true,
      broadcastAllowed,
      stage,
      rationaleOverridden: !final,
      payload: {
        drepId,
        actionId,
        position: proposal.proposedPosition,
        voteKind: positionToVoteKind(proposal.proposedPosition),
        anchorUrl: final?.ipfsUri ?? null,
        anchorHash: final?.anchorHash ?? null,
      },
      message,
    });
  } catch (err) {
    console.error('committee/submit error:', err);
    return handleError(err);
  }
};
