import { queryItems, updateItem, tableNames } from '../lib/dynamodb';
import { getCurrentEpochInfo } from '../lib/koios';
import { resolveCommitteeVote } from '../lib/committeeVoteResolver';
import { writeAuditEvent } from '../lib/audit';
import type {
  CommitteeVoteProposalItem,
  CommitteeVoteCastItem,
  CommitteeTallySnapshot,
  GovernanceActionItem,
} from '../lib/types';

/** GA statuses that mean voting is over even before the epoch deadline. */
const TERMINAL_GA_STATUSES = new Set(['expired', 'enacted', 'dropped']);

/**
 * Hourly sweep that hard-finalizes open committee proposals whose governance
 * action's voting window has closed — either the epoch deadline passed or the
 * action transitioned to a terminal on-chain status. The proposal finalizes at
 * whatever state it's in (no automatic pass/fail); the UI renders "epoch
 * deadline reached; final position = proposed position".
 *
 * Race-safe: every finalize is conditional on status='open', so a member's
 * manual close racing this sweep cleanly wins (the loser no-ops).
 */
export const handler = async (): Promise<{ scanned: number; finalized: number }> => {
  const epochInfo = await getCurrentEpochInfo();
  const currentEpoch = epochInfo.epoch_no;

  // All currently-open proposals (sparse GSI — only open proposals are present).
  const open = await queryItems<CommitteeVoteProposalItem>(tableNames.committeeVotes, {
    indexName: 'open-epochDeadline-index',
    keyConditionExpression: 'statusPartition = :open',
    expressionAttributeValues: { ':open': 'OPEN' },
  });

  let finalized = 0;
  for (const proposal of open.items) {
    const deadlinePassed =
      typeof proposal.epochDeadline === 'number' && proposal.epochDeadline < currentEpoch;

    let gaTerminal = false;
    if (!deadlinePassed) {
      // Only pay for the GA read when the deadline alone doesn't decide it.
      const action = await getItemSafe(proposal.actionId);
      gaTerminal = action ? TERMINAL_GA_STATUSES.has(action.status) : false;
    }
    if (!deadlinePassed && !gaTerminal) continue;

    const finalTally = await computeFinalTally(proposal);

    try {
      await updateItem(
        tableNames.committeeVotes,
        { voteScope: proposal.voteScope, itemKey: 'PROPOSAL' },
        'SET #status = :status, closedAt = :now, closedReason = :reason, finalTally = :tally REMOVE statusPartition',
        { '#status': 'status' },
        {
          ':status': 'epoch_finalized',
          ':now': new Date().toISOString(),
          ':reason': 'epoch_deadline',
          ':tally': finalTally,
          ':open': 'open',
        },
        '#status = :open',
      );
    } catch (err) {
      if (err && typeof err === 'object' && (err as { name?: string }).name === 'ConditionalCheckFailedException') {
        // Someone closed it manually between the query and now — fine.
        continue;
      }
      throw err;
    }

    finalized++;
    await writeAuditEvent({
      entityType: 'committee_vote',
      entityId: proposal.voteScope,
      eventType: 'committee.vote.epoch_finalized',
      actorWallet: 'system',
      metadata: {
        drepId: proposal.drepId,
        actionId: proposal.actionId,
        reason: deadlinePassed ? 'epoch_deadline' : 'ga_terminal',
        ...finalTally,
      },
    });
  }

  console.log(`committee-epoch-sweep: scanned ${open.items.length}, finalized ${finalized}`);
  return { scanned: open.items.length, finalized };
};

async function getItemSafe(actionId: string): Promise<GovernanceActionItem | undefined> {
  const res = await queryItems<GovernanceActionItem>(tableNames.governanceActions, {
    keyConditionExpression: 'actionId = :a AND SK = :sk',
    expressionAttributeValues: { ':a': actionId, ':sk': 'ACTION' },
    limit: 1,
  });
  return res.items[0];
}

async function computeFinalTally(
  proposal: CommitteeVoteProposalItem,
): Promise<CommitteeTallySnapshot> {
  const items = await queryItems<CommitteeVoteCastItem>(tableNames.committeeVotes, {
    keyConditionExpression: 'voteScope = :vs AND begins_with(itemKey, :cast)',
    expressionAttributeValues: { ':vs': proposal.voteScope, ':cast': 'CAST#' },
  });
  const tally = resolveCommitteeVote({
    casts: items.items.map((c) => ({ voterWallet: c.voterWallet, vote: c.vote })),
    thresholdPct: proposal.thresholdPct,
    quorum: proposal.quorum,
  });
  return {
    agreeCount: tally.agreeCount,
    disagreeCount: tally.disagreeCount,
    abstainCount: tally.abstainCount,
    activePool: tally.activePool,
    agreePct: tally.agreePct,
  };
}
