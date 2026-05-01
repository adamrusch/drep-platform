import type { ScheduledEvent, Context } from 'aws-lambda';
import {
  listGovernanceActions,
  getLatestEpoch,
  mapBlockfrostProposalToGovernanceAction,
} from '../lib/blockfrost';
import { getItem, putItem, tableNames } from '../lib/dynamodb';
import type { GovernanceActionItem } from '../lib/types';

export interface IntakeResult {
  synced: number;
  skipped: number;
  errors: number;
}

export async function runGovernanceIntake(): Promise<IntakeResult> {
  const result: IntakeResult = { synced: 0, skipped: 0, errors: 0 };

  const epochInfo = await getLatestEpoch();
  const currentEpoch = epochInfo.epoch;

  let page = 1;
  const pageSize = 100;
  let hasMore = true;

  while (hasMore) {
    const rawActions = await listGovernanceActions(page, pageSize);

    if (rawActions.length === 0) {
      hasMore = false;
      break;
    }

    for (const rawAction of rawActions) {
      try {
        const actionId = `${rawAction.tx_hash}#${rawAction.cert_index}`;

        const existing = await getItem<GovernanceActionItem>(tableNames.governanceActions, {
          actionId,
          SK: 'ACTION',
        });

        const mapped = mapBlockfrostProposalToGovernanceAction(
          rawAction,
          currentEpoch,
          existing?.title as string | undefined,
          existing?.description as string | undefined,
        );

        const now = new Date().toISOString();
        const item: GovernanceActionItem = {
          actionId,
          SK: 'ACTION',
          actionType: mapped.actionType,
          title: mapped.title,
          description: mapped.description,
          submittedAt: existing?.submittedAt as string ?? now,
          epochDeadline: mapped.epochDeadline,
          status: mapped.status,
          sourceMetadata: mapped.sourceMetadata,
          links: mapped.links,
          ingestedAt: existing?.ingestedAt as string ?? now,
          lastSyncedAt: now,
          adminOverrideLabel: existing?.adminOverrideLabel as string | undefined,
          editLog: existing?.editLog as GovernanceActionItem['editLog'],
        };

        await putItem(tableNames.governanceActions, item);
        result.synced++;
      } catch (err) {
        console.error(`Failed to sync governance action ${rawAction.tx_hash}:`, err);
        result.errors++;
      }
    }

    if (rawActions.length < pageSize) {
      hasMore = false;
    } else {
      page++;
    }
  }

  console.log(
    `Governance intake complete: synced=${result.synced}, skipped=${result.skipped}, errors=${result.errors}`,
  );
  return result;
}

/**
 * EventBridge scheduled Lambda handler — fires every 5 minutes via SchedulerStack.
 */
export const handler = async (
  _event: ScheduledEvent,
  _context: Context,
): Promise<IntakeResult> => {
  return runGovernanceIntake();
};
