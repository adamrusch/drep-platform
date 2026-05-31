import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getItem, putItem, tableNames } from '../../lib/dynamodb';
import type { CommitteeCastVote, CommitteeVoteCastItem } from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { writeAuditEvent } from '../../lib/audit';
import { committeeMessages } from '../../lib/committeeMessages';
import { ok, badRequest, unauthorized, notFound, conflict, handleError } from '../_response';
import {
  assertCommitteeMember,
  getStage,
  loadCommittee,
  loadProposal,
  signatureSnapshot,
  verifyCommitteeResign,
  voteScopeOf,
} from './_committee';

interface CastVoteBody {
  vote: CommitteeCastVote;
  mutationNonce: string;
  mutationSignature: string;
  mutationKey: string;
}

const VOTES: CommitteeCastVote[] = ['Agree', 'Disagree', 'Abstain'];

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

    let body: CastVoteBody;
    try {
      body = JSON.parse(event.body) as CastVoteBody;
    } catch {
      return badRequest('Invalid JSON body');
    }
    if (!VOTES.includes(body.vote)) {
      return badRequest(`vote must be one of: ${VOTES.join(', ')}`);
    }

    const committee = await loadCommittee(drepId);
    if (!committee) return notFound('Committee');
    assertCommitteeMember(authCtx, committee);

    const voteScope = voteScopeOf(drepId, actionId);
    const proposal = await loadProposal(voteScope);
    if (!proposal) return notFound('Proposal');
    if (proposal.status !== 'open') {
      return conflict('This proposal is closed; votes can no longer be cast');
    }

    const message = committeeMessages.cast(
      getStage(), drepId, actionId, body.vote, body.mutationNonce, authCtx.walletAddress,
    );
    const reason = await verifyCommitteeResign(authCtx.walletAddress, body, message);
    if (reason) return unauthorized(reason);

    const itemKey = `CAST#${authCtx.walletAddress}`;
    const prior = await getItem<CommitteeVoteCastItem>(tableNames.committeeVotes, {
      voteScope, itemKey,
    });
    const now = new Date().toISOString();

    const cast: CommitteeVoteCastItem = {
      voteScope,
      itemKey,
      drepId,
      actionId,
      voterWallet: authCtx.walletAddress,
      vote: body.vote,
      votedAt: now,
      changeCount: prior ? prior.changeCount + 1 : 0,
      signature: signatureSnapshot(body, message),
    };
    await putItem(tableNames.committeeVotes, cast as unknown as Record<string, unknown>);

    // Committee votes are low-volume + high audit value, so (unlike comment
    // votes) we persist the signature in the audit metadata too — the CAST row
    // is overwritten on re-vote, but the change history must survive.
    await writeAuditEvent({
      entityType: 'committee_vote',
      entityId: voteScope,
      eventType: 'committee.vote.cast',
      actorWallet: authCtx.walletAddress,
      metadata: {
        drepId,
        actionId,
        vote: body.vote,
        priorVote: prior?.vote ?? null,
        changeCount: cast.changeCount,
        mutationSignature: body.mutationSignature,
        mutationKey: body.mutationKey,
        signedMessage: message,
      },
    });

    return ok(cast);
  } catch (err) {
    console.error('committee/castVote error:', err);
    return handleError(err);
  }
};
