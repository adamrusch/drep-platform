import type { ScheduledEvent, Context } from 'aws-lambda';
import {
  listGovernanceActions,
  getGovernanceAction,
  getLatestEpoch,
  getProposalAnchor,
  getProposalVotes,
  getTx,
  resolveAnchor,
  mapBlockfrostProposalToGovernanceAction,
  mapStatus,
  type AnchorContent,
  type BlockfrostProposal,
} from '../lib/blockfrost';
import { getItem, putItem, tableNames } from '../lib/dynamodb';
import type { GovernanceActionItem, VoteTally } from '../lib/types';

export interface IntakeResult {
  synced: number;
  skipped: number;
  errors: number;
}

/**
 * Don't re-fetch immutable enrichments (tx block_time, anchor metadata) more
 * often than this. Status is the only field that mutates per epoch and we
 * still re-stamp it from the cheap proposal listing on every cycle.
 */
const ENRICHMENT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Max concurrent per-item enrichment passes. The Blockfrost SDK already
 * uses Bottleneck for client-side rate limiting, so we don't need huge
 * fan-out here — 4 lanes × 2 cold calls is enough to keep the SDK queue
 * primed without spamming retries.
 */
const ITEM_CONCURRENCY = 4;

/**
 * Bump this whenever the enrichment shape changes — older rows missing
 * the bump will be re-enriched on the next sync, even if they look
 * superficially complete.
 *
 * v1 → v2: hot path no longer re-runs the mapper against the listing
 * stub (which was clobbering correct enrichment with empty values).
 * v2 → v3: cold path now fetches and stores `votes` (DRep / SPO / CC tally)
 * via `getProposalVotes`. Hot path also refreshes votes — they mutate as
 * voting progresses, so a 24h enrichment-fresh skip would freeze tallies.
 */
const ENRICHMENT_VERSION = 3;

function isEnrichmentFresh(existing: GovernanceActionItem | undefined, now: number): boolean {
  if (!existing) return false;
  // Require an explicit version stamp — older rows have no `enrichmentVersion`
  // and so always re-enrich. This makes schema migrations safe.
  if ((existing['enrichmentVersion'] as number | undefined) !== ENRICHMENT_VERSION) return false;
  const lastSync = existing.lastSyncedAt
    ? new Date(existing.lastSyncedAt as string).getTime()
    : 0;
  return now - lastSync < ENRICHMENT_TTL_MS;
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

    await processWithConcurrency(rawActions, ITEM_CONCURRENCY, async (rawAction) => {
      const actionId = `${rawAction.tx_hash}#${rawAction.cert_index}`;
      try {
        const existing = await getItem<GovernanceActionItem>(tableNames.governanceActions, {
          actionId,
          SK: 'ACTION',
        });

        const nowMs = Date.now();
        const now = new Date(nowMs).toISOString();
        const skipEnrichment = isEnrichmentFresh(existing, nowMs);

        // Hot path: enrichment is recent. We still need the full proposal
        // for status/epochDeadline (those mutate per epoch) AND the vote
        // tally (votes change as voting progresses). Anchor + tx block_time
        // are immutable so we keep them. Run the two refreshes in parallel.
        if (skipEnrichment && existing) {
          const [proposalResult, votesResult] = await Promise.allSettled([
            getGovernanceAction(rawAction.tx_hash, rawAction.cert_index),
            getProposalVotes(rawAction.tx_hash, rawAction.cert_index),
          ]);
          const fullProposal: BlockfrostProposal =
            proposalResult.status === 'fulfilled' ? proposalResult.value : rawAction;
          if (proposalResult.status === 'rejected') {
            console.warn(`proposal refresh failed for ${actionId}:`, proposalResult.reason);
          }
          let votes: VoteTally | undefined = existing['votes'] as VoteTally | undefined;
          if (votesResult.status === 'fulfilled') {
            votes = votesResult.value ?? votes;
          } else {
            console.warn(`votes refresh failed for ${actionId}:`, votesResult.reason);
          }
          const updated: GovernanceActionItem = {
            ...(existing as GovernanceActionItem),
            // Refresh status/deadline/votes — the only fields that mutate.
            status: mapStatus(fullProposal, currentEpoch),
            epochDeadline:
              typeof fullProposal.expiration === 'number'
                ? fullProposal.expiration
                : (existing.epochDeadline as number) ?? 0,
            votes,
            lastSyncedAt: now,
            enrichmentVersion: ENRICHMENT_VERSION,
          };
          await putItem(tableNames.governanceActions, updated);
          result.skipped++;
          return;
        }

        // Cold path: full enrichment fetch.
        let anchor: AnchorContent | null = null;
        let submittedAt: string | undefined;
        let fullProposal: BlockfrostProposal = rawAction;
        let votes: VoteTally | undefined;

        // The list response omits `governance_description` — we need the
        // full proposal to render an on-chain summary. Fetch all four in
        // parallel to keep the per-item latency low.
        const [proposalResult, txResult, metaResult, votesResult] = await Promise.allSettled([
          getGovernanceAction(rawAction.tx_hash, rawAction.cert_index),
          getTx(rawAction.tx_hash),
          getProposalAnchor(rawAction.tx_hash, rawAction.cert_index),
          getProposalVotes(rawAction.tx_hash, rawAction.cert_index),
        ]);
        if (proposalResult.status === 'fulfilled') {
          fullProposal = proposalResult.value;
        } else {
          console.warn(`proposal fetch failed for ${actionId}:`, proposalResult.reason);
        }
        if (txResult.status === 'fulfilled' && typeof txResult.value.block_time === 'number') {
          submittedAt = new Date(txResult.value.block_time * 1000).toISOString();
        } else if (txResult.status === 'rejected') {
          console.warn(`tx fetch failed for ${actionId}:`, txResult.reason);
        }
        if (metaResult.status === 'fulfilled') {
          try {
            anchor = await resolveAnchor(metaResult.value);
          } catch (err) {
            console.warn(`anchor resolve failed for ${actionId}:`, err);
          }
        } else {
          console.warn(`anchor fetch failed for ${actionId}:`, metaResult.reason);
        }
        if (votesResult.status === 'fulfilled') {
          votes = votesResult.value ?? undefined;
        } else {
          console.warn(`votes fetch failed for ${actionId}:`, votesResult.reason);
        }

        const mapped = mapBlockfrostProposalToGovernanceAction(fullProposal, currentEpoch, {
          anchor,
          submittedAt,
          votes,
        });

        const item: GovernanceActionItem = {
          actionId,
          SK: 'ACTION',
          actionType: mapped.actionType,
          title: mapped.title,
          description: mapped.description,
          submittedAt:
            mapped.submittedAt && !mapped.submittedAt.startsWith('1970-01-01')
              ? mapped.submittedAt
              : existing?.submittedAt &&
                  !(existing.submittedAt as string).startsWith('1970-01-01')
                ? (existing.submittedAt as string)
                : now,
          epochDeadline: mapped.epochDeadline,
          status: mapped.status,
          sourceMetadata: mapped.sourceMetadata,
          links: mapped.links,
          ingestedAt: (existing?.ingestedAt as string) ?? now,
          lastSyncedAt: now,
          adminOverrideLabel: existing?.adminOverrideLabel as string | undefined,
          editLog: existing?.editLog as GovernanceActionItem['editLog'],
          anchorUrl: mapped.anchorUrl,
          anchorHash: mapped.anchorHash,
          anchorVerified: mapped.anchorVerified,
          abstract: mapped.abstract,
          motivation: mapped.motivation,
          rationale: mapped.rationale,
          references: mapped.references,
          summary: mapped.summary,
          details: mapped.details,
          proposerAddress: mapped.proposerAddress,
          votes: mapped.votes,
          enrichmentVersion: ENRICHMENT_VERSION,
        };

        await putItem(tableNames.governanceActions, item);
        result.synced++;
      } catch (err) {
        console.error(`Failed to sync governance action ${actionId}:`, err);
        result.errors++;
      }
    });

    if (rawActions.length < pageSize) {
      hasMore = false;
    } else {
      page++;
    }
  }

  console.log(
    `Governance intake complete: written=${result.synced}, enrichmentSkipped=${result.skipped}, errors=${result.errors}`,
  );
  return result;
}

/**
 * Run `worker(item)` for every entry in `items` with at most `concurrency`
 * tasks in flight. Resolves once every task has settled. Errors thrown by
 * the worker are caught and logged; they do not abort the pool.
 *
 * Implementation: spawn N "lane" loops that each pull from a shared cursor
 * until exhausted. Avoids the bookkeeping pitfalls of Promise.race-based
 * pools (already-resolved promises causing tight spins).
 */
async function processWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  const cap = Math.max(1, Math.min(concurrency, items.length));
  const lane = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        await worker(items[i]!);
      } catch (err) {
        // Worker is responsible for its own logging; this is a final safety net.
        console.error('processWithConcurrency worker threw:', err);
      }
    }
  };
  await Promise.all(Array.from({ length: cap }, () => lane()));
}

/**
 * EventBridge scheduled Lambda handler — fires every 2 minutes via SchedulerStack.
 */
export const handler = async (
  _event: ScheduledEvent,
  _context: Context,
): Promise<IntakeResult> => {
  return runGovernanceIntake();
};
