import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { putItem, tableNames } from '../../lib/dynamodb';
import type { RationaleMode, VotingConfigItem } from '../../lib/types';
import { extractAuthContext } from '../../middleware/role-guard';
import { writeAuditEvent } from '../../lib/audit';
import { committeeMessages } from '../../lib/committeeMessages';
import { ok, badRequest, unauthorized, notFound, handleError } from '../_response';
import {
  assertCommitteeLead,
  countOpenProposals,
  getStage,
  loadCommittee,
  loadVotingConfig,
  verifyCommitteeResign,
  DEFAULT_QUORUM,
} from './_committee';

interface UpdateVotingConfigBody {
  thresholdPct: number;
  rationaleMode: RationaleMode;
  assignedEditor?: string;
  mutationNonce: string;
  mutationSignature: string;
  mutationKey: string;
}

const VALID_MODES: RationaleMode[] = ['lead', 'assigned', 'collaborative'];

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const authCtx = extractAuthContext(event);
    const drepId = event.pathParameters?.['drepId'];
    if (!drepId) return badRequest('drepId path parameter is required');
    if (!event.body) return badRequest('Request body is required');

    let body: UpdateVotingConfigBody;
    try {
      body = JSON.parse(event.body) as UpdateVotingConfigBody;
    } catch {
      return badRequest('Invalid JSON body');
    }

    // thresholdPct must be an integer in [51, 100] — 51 is the simple-majority
    // floor (never settable below). The resolver assumes this is validated here.
    if (
      typeof body.thresholdPct !== 'number' ||
      !Number.isInteger(body.thresholdPct) ||
      body.thresholdPct < 51 ||
      body.thresholdPct > 100
    ) {
      return badRequest('thresholdPct must be an integer between 51 and 100 (never below simple majority)');
    }
    if (!VALID_MODES.includes(body.rationaleMode)) {
      return badRequest(`rationaleMode must be one of: ${VALID_MODES.join(', ')}`);
    }

    const committee = await loadCommittee(drepId);
    if (!committee) return notFound('Committee');
    assertCommitteeLead(authCtx, committee);

    if (body.rationaleMode === 'assigned') {
      if (!body.assignedEditor) {
        return badRequest('assignedEditor is required when rationaleMode is "assigned"');
      }
      const isMember =
        committee.leadWallet === body.assignedEditor ||
        committee.members?.some((m) => m.walletAddress === body.assignedEditor);
      if (!isMember) {
        return badRequest('assignedEditor must be a member of this committee');
      }
    }

    const message = committeeMessages.votingConfig(
      getStage(),
      drepId,
      body.thresholdPct,
      body.rationaleMode,
      body.mutationNonce,
      authCtx.walletAddress,
    );
    const reason = await verifyCommitteeResign(authCtx.walletAddress, body, message);
    if (reason) return unauthorized(reason);

    const now = new Date().toISOString();
    const prior = await loadVotingConfig(drepId);
    const history = prior.item?.history ?? [];

    const item: VotingConfigItem = {
      drepId,
      SK: 'VOTING_CONFIG',
      thresholdPct: body.thresholdPct,
      quorum: prior.item?.quorum ?? DEFAULT_QUORUM,
      rationaleMode: body.rationaleMode,
      ...(body.rationaleMode === 'assigned' ? { assignedEditor: body.assignedEditor } : {}),
      setBy: authCtx.walletAddress,
      setAt: now,
      history: [
        ...history,
        { thresholdPct: body.thresholdPct, rationaleMode: body.rationaleMode, wallet: authCtx.walletAddress, at: now },
      ].slice(-50),
    };
    await putItem(tableNames.drepCommittees, item as unknown as Record<string, unknown>);

    await writeAuditEvent({
      entityType: 'drep_committee',
      entityId: drepId,
      eventType: 'committee.config.updated',
      actorWallet: authCtx.walletAddress,
      metadata: {
        thresholdPct: body.thresholdPct,
        rationaleMode: body.rationaleMode,
        priorThresholdPct: prior.thresholdPct,
      },
    });

    // Snapshotted threshold means open proposals keep their original bar — warn
    // the lead so the mid-vote change isn't silently confusing.
    const openCount = await countOpenProposals(drepId);
    const warning =
      openCount > 0
        ? `${openCount} open proposal(s) will continue at their original threshold; this change applies to new proposals only.`
        : undefined;

    return ok({ config: item, ...(warning ? { warning } : {}) });
  } catch (err) {
    console.error('committee/updateVotingConfig error:', err);
    return handleError(err);
  }
};
