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
  mapKoiosProposalToGovernanceAction,
  mapStatus,
  type AnchorContent,
  type BlockfrostProposal,
} from '../lib/blockfrost';
import { listProposals as listKoiosProposals, KoiosError, type KoiosProposal } from '../lib/koios';
import { getItem, putItem, tableNames } from '../lib/dynamodb';
import {
  findByAnchorUrl as findPillarByAnchorUrl,
  findByOnChainTxHash as findPillarByTxHash,
  type ProposalPillarEntry,
} from '../lib/proposalPillar';
import {
  isBlockfrostCircuitOpen,
  openBlockfrostCircuit,
  isBlockfrostQuotaError,
} from '../lib/circuitBreaker';
import type {
  GovernanceAction,
  GovernanceActionItem,
  GovernanceMetadataSource,
  VoteTally,
} from '../lib/types';

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
 * v3 → v4: `title` is no longer synthesized from the on-chain summary
 * when the anchor is absent — it now reflects ONLY the CIP-108 anchor
 * body title (or undefined). The frontend surfaces the synthesized
 * `summary` as a subtitle. Bumping the version forces all rows to
 * re-enrich so stale "Withdraw …" titles get cleared to undefined.
 * v4 → v5: when the on-chain CIP-108 anchor is missing or has no title,
 * fall back to the gov.tools proposal-discussion forum API to populate
 * `title` / `abstract` / `motivation` / `rationale`, plus the new
 * `proposalPillarUrl` / `proposalPillarId` fields and a `metadataSource`
 * tag indicating where the data came from. On-chain anchor data still
 * wins when both sources exist.
 * v5 → v6: Koios (`/proposal_list`) is now the primary metadata source.
 * One bulk call returns the parsed CIP-108 body (`meta_json`), the on-chain
 * description (`proposal_description`), lifecycle epoch fields, and
 * `meta_is_valid` for every action — replacing 4 Blockfrost calls per
 * action with one shared call. Blockfrost remains the source for vote
 * tallies and as a graceful-fallback path when Koios is unreachable.
 * The proposal-pillar fallback is preserved for actions that have no
 * usable on-chain anchor body in either source.
 */
const ENRICHMENT_VERSION = 6;

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

  // Circuit breaker: if Blockfrost rate-limited us recently, skip the run
  // entirely. Hammering Blockfrost during a quota outage adds rejected calls
  // to the rolling window, preventing recovery. Marker auto-expires via
  // DynamoDB TTL, so the next sync after the window will probe fresh.
  const circuit = await isBlockfrostCircuitOpen();
  if (circuit.open) {
    const minsLeft = Math.ceil(((circuit.expiresAt ?? 0) - Date.now() / 1000) / 60);
    console.log(
      `Governance intake skipped: Blockfrost circuit open for ~${minsLeft} more min`,
    );
    return result;
  }

  let epochInfo;
  try {
    epochInfo = await getLatestEpoch();
  } catch (err) {
    if (isBlockfrostQuotaError(err)) {
      // Open the circuit and skip the rest of the run. Default 6 hours
      // gives the rolling window time to clear without being so long that
      // a transient throttle blocks us all day.
      await openBlockfrostCircuit();
      console.warn('Governance intake: opened Blockfrost circuit due to quota error');
      return result;
    }
    throw err;
  }
  const currentEpoch = epochInfo.epoch;

  // ---- Koios primary fetch (Phase A) ----
  // One bulk call replaces 4 Blockfrost calls per action. We index the
  // result by `tx_hash#cert_index` so the per-item loop can look up its
  // record in O(1). Any failure (network, 5xx, 429, oversize) lands as a
  // null map and the per-item loop falls back to the legacy Blockfrost
  // enrichment path — sync MUST never fail because Koios is down.
  let koiosByActionId: Map<string, KoiosProposal> | null = null;
  try {
    const koiosList = await listKoiosProposals();
    koiosByActionId = new Map(
      koiosList.map((p) => [`${p.proposal_tx_hash}#${p.proposal_index}`, p]),
    );
    console.log(`Governance intake: Koios returned ${koiosList.length} proposals`);
  } catch (err) {
    if (err instanceof KoiosError) {
      console.warn(
        `Governance intake: Koios unavailable (${err.message}); falling back to Blockfrost-only path`,
      );
    } else {
      console.warn('Governance intake: unexpected Koios error:', err);
    }
    koiosByActionId = null;
  }

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

        // Cold path: full enrichment fetch. With Koios as primary we can
        // skip the Blockfrost detail/anchor/tx round-trips when the bulk
        // listing carried enough data. We still fetch votes from Blockfrost
        // (Koios's vote endpoints are paid-tier; Phase A keeps votes on the
        // existing path).
        const koiosRecord = koiosByActionId?.get(actionId) ?? null;
        let votes: VoteTally | undefined;
        let mapped: Omit<GovernanceAction, 'ingestedAt' | 'lastSyncedAt'>;

        if (koiosRecord) {
          // ---- Koios fast path ----
          // Bulk listing already gave us metadata, on-chain description,
          // submittedAt, anchor URL/hash/validity, and lifecycle epochs.
          // Only votes are missing — fetch them from Blockfrost in parallel
          // with the mapping work (which is just CPU).
          const votesResult = await Promise.allSettled([
            getProposalVotes(rawAction.tx_hash, rawAction.cert_index),
          ]);
          const voteRes = votesResult[0]!;
          if (voteRes.status === 'fulfilled') {
            votes = voteRes.value ?? undefined;
          } else {
            console.warn(`votes fetch failed for ${actionId}:`, voteRes.reason);
          }
          mapped = mapKoiosProposalToGovernanceAction(koiosRecord, currentEpoch, { votes });
        } else {
          // ---- Legacy Blockfrost fallback ----
          // Koios was unreachable OR didn't carry this specific action.
          // Run the original 4-call enrichment chain so we degrade gracefully
          // to the pre-Koios behavior.
          let anchor: AnchorContent | null = null;
          let submittedAt: string | undefined;
          let fullProposal: BlockfrostProposal = rawAction;

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

          mapped = mapBlockfrostProposalToGovernanceAction(fullProposal, currentEpoch, {
            anchor,
            submittedAt,
            votes,
          });
        }

        // ---- Proposal-pillar fallback ----
        // If the CIP-108 anchor produced a title, the on-chain source is
        // canonical and we skip the fallback entirely. Otherwise try the
        // gov.tools forum API: first by tx hash (most reliable when the
        // draft was actually submitted), then by anchor URL (handles the
        // case where the anchor exists but is unparseable, or where the
        // forum draft links to the eventual on-chain anchor URL).
        let pillarEntry: ProposalPillarEntry | null = null;
        let metadataSource: GovernanceMetadataSource = 'none';
        if (mapped.title) {
          metadataSource = 'on-chain-anchor';
        } else {
          if (rawAction.tx_hash) {
            pillarEntry = await findPillarByTxHash(rawAction.tx_hash);
          }
          if (!pillarEntry && mapped.anchorUrl) {
            pillarEntry = await findPillarByAnchorUrl(mapped.anchorUrl);
          }
          if (pillarEntry) {
            metadataSource = 'proposal-pillar';
            console.log(
              `proposal-pillar fallback applied: actionId=${actionId} pillarId=${pillarEntry.id}`,
            );
          } else if (mapped.abstract || mapped.motivation || mapped.rationale) {
            // Anchor was present and gave us body text but no title.
            metadataSource = 'on-chain-anchor';
          }
        }
        const item: GovernanceActionItem = {
          actionId,
          SK: 'ACTION',
          actionType: mapped.actionType,
          // `title` precedence: on-chain anchor → pillar fallback.
          title: mapped.title ?? pillarEntry?.prop_name,
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
          // Each body field falls back independently — on-chain anchor data
          // is canonical when present, pillar fills only the gaps.
          abstract: mapped.abstract ?? pillarEntry?.prop_abstract,
          motivation: mapped.motivation ?? pillarEntry?.prop_motivation,
          rationale: mapped.rationale ?? pillarEntry?.prop_rationale,
          references: mapped.references ?? pillarEntry?.references,
          proposalPillarUrl: pillarEntry?.proposalPillarUrl,
          proposalPillarId: pillarEntry?.id,
          metadataSource,
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
 * EventBridge scheduled Lambda handler — cadence is owned by SchedulerStack
 * (Phase A: every 1 minute, with Koios as the primary metadata source so
 * Blockfrost call volume comfortably fits within the Discovery tier budget).
 */
export const handler = async (
  _event: ScheduledEvent,
  _context: Context,
): Promise<IntakeResult> => {
  return runGovernanceIntake();
};
