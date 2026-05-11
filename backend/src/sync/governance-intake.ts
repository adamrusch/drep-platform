import type { ScheduledEvent, Context } from 'aws-lambda';
import {
  listGovernanceActions,
  getGovernanceAction,
  getLatestEpoch,
  getProposalAnchor,
  getTx,
  resolveAnchor,
  mapActionType,
  mapBlockfrostProposalToGovernanceAction,
  mapKoiosProposalToGovernanceAction,
  mapStatus,
  parseCip108Body,
  type AnchorContent,
  type BlockfrostProposal,
} from '../lib/blockfrost';
import { extractIpfsCid, fetchIpfsAnchor } from '../lib/ipfsGateway';
import {
  listProposals as listKoiosProposals,
  listActiveDReps,
  listActivePools,
  listAllVotes,
  groupVotesByProposal,
  getCommitteeMembers,
  getCurrentEpoch,
  getPredefinedDRepPower,
  KoiosError,
  type KoiosProposal,
  type KoiosVote,
} from '../lib/koios';
import {
  tallyVotesWithPower,
  emptyTally as emptyVoteTally,
  applicableRoles,
  koiosVotesToBlockfrostShape,
  DREP_ALWAYS_ABSTAIN,
  DREP_ALWAYS_NO_CONFIDENCE,
  type TallyLookups,
} from '../lib/voteTally';
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
  GovernanceActionType,
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
 * v6 → v7: `votes` shape now includes per-role `notVoted` and `totalActive`
 * slices, computed from global active-voter lookups (Koios `drep_list` +
 * `drep_info`, `pool_list`, `committee_info`). Each slice carries both a
 * voter `count` and a `power` (lovelace, stringified). This lets the UI
 * report "what fraction of total active voting power hasn't yet voted",
 * which is the actual ratification denominator under CIP-1694 — distinct
 * from "fraction of those who voted". Predefined DReps
 * (drep_always_abstain, drep_always_no_confidence) contribute auto-votes
 * to the DRep slices. Sync continues with empty `notVoted` if any active-
 * voter lookup fails this cycle (graceful degradation).
 * v7 → v8: ratification math corrected per CIP-1694. Auto-abstain stake
 * (drep_always_abstain) is now EXCLUDED from `totalActive` (the
 * ratification denominator) — CIP-1694 explicitly says abstain stake is
 * "not part of the active voting stake". The new `totalRegistered` slice
 * carries the bigger informational denominator (includes auto-abstain).
 * The 3-slice identity `yes + no + notVoted == totalActive` now holds
 * exactly. Auto-no-confidence stake direction-flips: Yes on NoConfidence
 * actions, No otherwise. SPO unvoted-on-NoConfidence collapses into
 * abstain (CIP-1694 SPO rule). New informational fields:
 * `autoAbstainPower`, `autoNoConfidencePower` (DRep only). Bumping the
 * version forces all rows to re-tally with the corrected math on the next
 * sync.
 * v8 → v9: two display-driven changes. (a) `votingRoles` (CIP-1694
 * applicability map per action type) is now stored on every action, so
 * the frontend can hide entire role sections for non-applicable roles
 * (e.g. SPOs on Treasury Withdrawals — CIP-1694 §Ratification rows 3 & 6
 * mark them as `-`). (b) DRep `abstain.power` no longer includes
 * auto-abstain stake — the explicit-Abstain footnote in the UI should
 * show ONLY DReps who actively abstained, not the auto-abstain pool. The
 * separate `autoAbstainPower` breakout still carries that figure for
 * analytics; the frontend just stops rendering it. Bumping the version
 * forces all rows to re-tally and re-stamp `votingRoles`.
 * v9 → v10: persist `treasuryWithdrawalLovelace` on TreasuryWithdrawals
 * actions (sum of all withdrawal amounts on the action, stringified
 * BigInt). Surfaced for the new `/governance/stats` aggregation so the
 * "total ADA withdrawn from treasury" tile can sum across enacted rows
 * without re-parsing the on-chain description. Bumping the version
 * forces all rows to re-stamp this field on the next sync.
 * v10 → v11: per-proposal vote tallies now come from Koios's free
 * `/vote_list` endpoint instead of Blockfrost's `governance.proposalVotes`.
 * One bulk Koios call (already cached for the directory sync's
 * lastVotedAt aggregation) replaces ~109 Blockfrost calls per cycle on
 * mainnet today, dropping the sync's Blockfrost volume by ~99% on the
 * vote-tally path. The underlying db-sync data is identical between the
 * two providers — only field-name/casing differs, normalized by
 * `koiosVotesToBlockfrostShape`. Bumping the version forces re-tally on
 * the next sync so any rows still carrying a Blockfrost-derived tally
 * get re-stamped from the Koios source.
 * v11 → v12: multi-gateway IPFS fallback for the ~7 mainnet actions whose
 * on-chain anchor exists but whose `meta_json` came back null from Koios
 * (Koios runs a single internal IPFS gateway, and several broken CIDs
 * aren't routable from that node). When the Koios record has a
 * `meta_url` + `meta_hash` but null `meta_json`, we try a short list of
 * public IPFS gateways (`ipfs.io`, Pinata, dweb.link, …) in series,
 * blake2b-256-verify the response against the on-chain hash, and parse
 * the recovered body through `parseCip108Body`. Recovered rows are
 * stamped with `metadataGateway` (which gateway URL succeeded) and
 * `metadataRecoveredAt` (ISO timestamp). The 24h ENRICHMENT_TTL_MS
 * already gates the retry rate: a permanently-lost CID produces at most
 * 1 attempt per row per day, not 1 per minute. Bumping the version
 * forces all rows to re-run cold enrichment so the recovery pass lands
 * on the next sync.
 */
const ENRICHMENT_VERSION = 12;

/**
 * Deep equality on two governance action rows, ignoring the volatile
 * `lastSyncedAt` field. Returns true when a Put would be a no-op for any
 * downstream reader.
 *
 * This is the gate that prevents the hot path from re-writing all ~109
 * rows on every minute-long cycle. Without it, the previous code wrote
 * the row even when only `lastSyncedAt` differed — that was the source of
 * the ~66k WCU/hour leak on `governance_actions`.
 *
 * `enrichmentVersion` IS compared: a version bump in code MUST force a
 * write even if the data fields are identical, since the bump signals a
 * schema migration. (In practice version bumps land via the cold path,
 * not here — but the safety net is cheap.)
 */
function governanceItemsEqualIgnoringSync(
  a: GovernanceActionItem,
  b: GovernanceActionItem,
): boolean {
  return canonicalizeGovernanceItem(a) === canonicalizeGovernanceItem(b);
}

function canonicalizeGovernanceItem(item: GovernanceActionItem): string {
  return JSON.stringify(item, (key, value) => {
    if (key === 'lastSyncedAt') return undefined;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return value;
  });
}

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
  _tallyMismatchLoggedThisCycle = false;

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

  // Current epoch — Koios `/tip` is the primary source (Phase B). Falls back
  // to Blockfrost `epochsLatest` only when Koios is unreachable. Quota errors
  // on the fallback still trip the circuit breaker; a Koios `/tip` failure
  // simply degrades to Blockfrost (and if Blockfrost is also out, we surface
  // the error to the caller as before).
  let currentEpoch: number;
  try {
    currentEpoch = await getCurrentEpoch();
  } catch (koiosErr) {
    console.warn('Governance intake: Koios /tip unavailable, falling back to Blockfrost:', koiosErr);
    let epochInfo;
    try {
      epochInfo = await getLatestEpoch();
    } catch (err) {
      if (isBlockfrostQuotaError(err)) {
        await openBlockfrostCircuit();
        console.warn('Governance intake: opened Blockfrost circuit due to quota error');
        return result;
      }
      throw err;
    }
    currentEpoch = epochInfo.epoch;
  }

  // ---- Koios primary fetch (Phase A) ----
  // One bulk call replaces 4 Blockfrost calls per action. We index the
  // result by `tx_hash#cert_index` so the per-item loop can look up its
  // record in O(1). Any failure (network, 5xx, 429, oversize) lands as a
  // null map and the per-item loop falls back to the legacy Blockfrost
  // enrichment path — sync MUST never fail because Koios is down.
  //
  // We also build the active-voter lookups (DRep / SPO / CC) in parallel
  // with the proposal listing — they all hit Koios anyway and the per-
  // action loop needs both. Lookup failures are independent (a missing
  // pool list still lets us compute notVoted for DReps + CC, and so on);
  // each failed lookup leaves its bundle slot undefined and the tally
  // builder treats that role's notVoted as zero rather than lying about
  // a denominator we don't know.
  //
  // Phase B: also fetch the global vote_list once per cycle so we can
  // build per-proposal tallies in O(1) per action rather than calling
  // Blockfrost ~109 times. The directory sync already pulls this same
  // data on its own cadence and the module-level cache (5 min) absorbs
  // the overlap when both syncs land in the same warm Lambda.
  const [proposalsRes, lookupsRes, votesRes] = await Promise.allSettled([
    listKoiosProposals(),
    buildVoterLookups(),
    listAllVotes(),
  ]);

  let koiosByActionId: Map<string, KoiosProposal> | null = null;
  if (proposalsRes.status === 'fulfilled') {
    koiosByActionId = new Map(
      proposalsRes.value.map((p) => [`${p.proposal_tx_hash}#${p.proposal_index}`, p]),
    );
    console.log(`Governance intake: Koios returned ${proposalsRes.value.length} proposals`);
  } else {
    const err = proposalsRes.reason;
    if (err instanceof KoiosError) {
      console.warn(
        `Governance intake: Koios unavailable (${err.message}); falling back to Blockfrost-only path`,
      );
    } else {
      console.warn('Governance intake: unexpected Koios error:', err);
    }
  }

  const lookupBundle: VoterLookupBundle =
    lookupsRes.status === 'fulfilled' ? lookupsRes.value : EMPTY_LOOKUPS;
  if (lookupsRes.status === 'rejected') {
    console.warn('Governance intake: voter-lookups build failed:', lookupsRes.reason);
  }

  // Per-proposal vote slices, indexed by `${tx_hash}#${cert_index}`. When
  // the Koios call fails this map is null and the per-action loop falls
  // through to an empty tally — we deliberately do NOT fall back to
  // Blockfrost here because the whole point of Phase B is to remove that
  // hot path. A single failed cycle just freezes the previous tally; the
  // next successful cycle re-computes from scratch.
  let votesByActionId: Map<string, KoiosVote[]> | null = null;
  if (votesRes.status === 'fulfilled') {
    votesByActionId = groupVotesByProposal(votesRes.value);
    console.log(
      `Governance intake: Koios vote_list returned ${votesRes.value.length} votes across ${votesByActionId.size} proposals`,
    );
  } else {
    const err = votesRes.reason;
    if (err instanceof KoiosError) {
      console.warn(`Governance intake: Koios vote_list unavailable (${err.message})`);
    } else {
      console.warn('Governance intake: vote_list fetch failed:', err);
    }
  }

  // ---- Iteration driver ----
  // When Koios returned the bulk proposal listing we use that as the
  // canonical action set — no Blockfrost listing call needed. Falls back
  // to `listGovernanceActions` (paginated Blockfrost) only when Koios
  // is unreachable. Phase B note: with both Koios and the in-memory vote
  // map populated, the entire hot path hits zero Blockfrost endpoints.
  if (koiosByActionId && koiosByActionId.size > 0) {
    const rawActions: BlockfrostProposal[] = [];
    for (const k of koiosByActionId.values()) {
      // `governance_type` flows through `mapActionType` which accepts both
      // PascalCase (Koios) and snake_case (Blockfrost) labels — pass the
      // Koios value through untouched.
      rawActions.push({
        tx_hash: k.proposal_tx_hash,
        cert_index: k.proposal_index,
        governance_type: k.proposal_type,
        ratified_epoch: k.ratified_epoch,
        enacted_epoch: k.enacted_epoch,
        dropped_epoch: k.dropped_epoch,
        expired_epoch: k.expired_epoch,
        expiration: k.expiration,
      });
    }
    await processActions(rawActions);
    return finishIntake();
  }

  let page = 1;
  const pageSize = 100;
  let hasMore = true;

  while (hasMore) {
    let rawActions: BlockfrostProposal[];
    try {
      rawActions = await listGovernanceActions(page, pageSize);
    } catch (err) {
      if (isBlockfrostQuotaError(err)) {
        await openBlockfrostCircuit();
        console.warn('Governance intake: opened Blockfrost circuit due to listing quota error');
        return result;
      }
      throw err;
    }

    if (rawActions.length === 0) {
      hasMore = false;
      break;
    }

    await processActions(rawActions);

    if (rawActions.length < pageSize) {
      hasMore = false;
    } else {
      page++;
    }
  }
  return finishIntake();

  function finishIntake(): IntakeResult {
    console.log(
      `Governance intake complete: written=${result.synced}, enrichmentSkipped=${result.skipped}, errors=${result.errors}; ` +
        `lookups: drep=${lookupBundle.lookups.drepPower?.size ?? 0}/${lookupBundle.totals.totalDrepCount} pools=${lookupBundle.lookups.poolStake?.size ?? 0}/${lookupBundle.totals.totalPoolCount} cc=${lookupBundle.totals.totalCcCount}`,
    );
    return result;
  }

  async function processActions(rawActions: BlockfrostProposal[]): Promise<void> {
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

        // The action type is needed up-front so the vote-tally builder can
        // direction-flip the `drep_always_no_confidence` auto-vote. We
        // prefer the Koios proposal record when available (the listing was
        // fetched once at top of cycle); otherwise the Blockfrost stub
        // already carries `governance_type`.
        const koiosRecord = koiosByActionId?.get(actionId) ?? null;
        const actionType: GovernanceActionType = koiosRecord
          ? mapActionType(koiosRecord.proposal_type)
          : mapActionType(rawAction.governance_type);

        // Hot path: enrichment is recent. We still need the full proposal
        // for status/epochDeadline (those mutate per epoch) AND the vote
        // tally (votes change as voting progresses). Anchor + tx block_time
        // are immutable so we keep them. Re-tally on every cycle so
        // notVoted/totalActive reflect the latest active-voter snapshot.
        if (skipEnrichment && existing) {
          // Vote tally is now derived from the in-memory Koios vote map
          // (Phase B). When the Koios bulk listing carried this action we
          // can also pull lifecycle fields from there and skip Blockfrost
          // entirely — `mapStatus` only consumes ratified/enacted/dropped/
          // expired/expiration epochs and they're all on `KoiosProposal`.
          // This is what eliminates the last per-action Blockfrost call on
          // the hot path. Falls back to `getGovernanceAction` only when
          // Koios is unreachable for this proposal.
          let fullProposal: BlockfrostProposal = rawAction;
          if (koiosRecord) {
            fullProposal = {
              tx_hash: koiosRecord.proposal_tx_hash,
              cert_index: koiosRecord.proposal_index,
              governance_type: rawAction.governance_type,
              ratified_epoch: koiosRecord.ratified_epoch,
              enacted_epoch: koiosRecord.enacted_epoch,
              dropped_epoch: koiosRecord.dropped_epoch,
              expired_epoch: koiosRecord.expired_epoch,
              expiration: koiosRecord.expiration,
            };
          } else {
            try {
              fullProposal = await getGovernanceAction(rawAction.tx_hash, rawAction.cert_index);
            } catch (err) {
              console.warn(`proposal refresh failed for ${actionId}:`, err);
            }
          }
          // If the global vote map is unavailable this cycle, keep the
          // previously-stored tally rather than zeroing it out —
          // stale-but-real beats fresh-but-empty.
          let votes: VoteTally | undefined = existing['votes'] as VoteTally | undefined;
          if (votesByActionId) {
            const koiosVotes = votesByActionId.get(actionId) ?? [];
            const newTally = buildTallyFromKoiosVotes(koiosVotes, lookupBundle, actionType);
            assertTallyMatchesPrevious(actionId, existing['votes'] as VoteTally | undefined, newTally);
            votes = newTally;
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
            // CIP-1694 role-applicability map. Re-stamped on every cycle —
            // it's a pure function of `actionType`, but storing it on the
            // row means the API doesn't need to recompute on every read.
            votingRoles: applicableRoles(actionType),
            lastSyncedAt: now,
            enrichmentVersion: ENRICHMENT_VERSION,
          };
          // Skip the Put when the only difference would be `lastSyncedAt`.
          // On a quiet cycle (no status churn, votes identical) this used
          // to write all ~109 rows every minute = ~66k WCU/hr. Now we only
          // write when something a downstream reader actually cares about
          // changed. `lastSyncedAt` is no longer load-bearing for the
          // enrichment-fresh check on the hot path: the freshness window
          // is governed by `ENRICHMENT_VERSION` matching, and the cold
          // path resets the timestamp the next time it runs anyway.
          if (governanceItemsEqualIgnoringSync(existing as GovernanceActionItem, updated)) {
            result.skipped++;
            return;
          }
          await putItem(tableNames.governanceActions, updated);
          result.skipped++;
          return;
        }

        // Cold path: full enrichment fetch. With Koios as primary we can
        // skip the Blockfrost detail/anchor/tx round-trips when the bulk
        // listing carried enough data. Phase B: vote tallies now also come
        // from Koios — the global vote_list was fetched once at the top of
        // the cycle, so we just look up this proposal's slice in the map.
        let votes: VoteTally | undefined;
        let mapped: Omit<GovernanceAction, 'ingestedAt' | 'lastSyncedAt'>;

        // Build the vote tally from the in-memory Koios slice. When the
        // global fetch failed this cycle, we record an empty tally and
        // the next successful sync re-computes from scratch.
        if (votesByActionId) {
          const koiosVotes = votesByActionId.get(actionId) ?? [];
          votes = buildTallyFromKoiosVotes(koiosVotes, lookupBundle, actionType);
        }

        // Holders for the IPFS-fallback recovery state. Populated only when
        // Koios returned an anchor URL/hash but null `meta_json` and a public
        // gateway successfully served + hash-verified the body.
        let metadataGateway: string | undefined;
        let metadataRecoveredAt: string | undefined;

        if (koiosRecord) {
          // ---- Koios fast path ----
          // Bulk listing already gave us metadata, on-chain description,
          // submittedAt, anchor URL/hash/validity, and lifecycle epochs.
          mapped = mapKoiosProposalToGovernanceAction(koiosRecord, currentEpoch, { votes });

          // ---- IPFS fallback recovery (Phase A2) ----
          // When Koios has the anchor pointer but couldn't fetch/validate the
          // body, try public IPFS gateways ourselves. Only attempt when:
          //   - The mapped body is empty (no title AND no abstract / motivation
          //     / rationale parsed — i.e. Koios returned null `meta_json`).
          //   - The anchor has a URL we can extract a CID from, AND
          //   - The anchor has a hash we can verify against.
          // The 24h enrichment-fresh window means a failed recovery won't
          // re-fire for 24 hours — so a permanently-lost CID costs us
          // ~6 gateway hits per day, not per minute.
          const koiosBodyMissing =
            !mapped.title &&
            !mapped.abstract &&
            !mapped.motivation &&
            !mapped.rationale;
          if (
            koiosBodyMissing &&
            typeof koiosRecord.meta_url === 'string' &&
            typeof koiosRecord.meta_hash === 'string'
          ) {
            const cid = extractIpfsCid(koiosRecord.meta_url);
            if (cid) {
              const recovered = await fetchIpfsAnchor(cid, koiosRecord.meta_hash);
              if (recovered) {
                let parsedJson: Record<string, unknown> | null = null;
                try {
                  const candidate = JSON.parse(recovered.body) as unknown;
                  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
                    parsedJson = candidate as Record<string, unknown>;
                  }
                } catch {
                  // Body wasn't JSON — treat as recoverable-but-not-CIP-108.
                  // No body fields to populate; just record the gateway that
                  // served it so a future debug pass can inspect.
                }
                if (parsedJson) {
                  const cip108 = parseCip108Body(parsedJson);
                  // Overlay recovered CIP-108 fields onto the mapped record.
                  // Only fill fields the on-chain anchor body is the canonical
                  // source for; description (which falls back to the on-chain
                  // summary) is re-derived from the recovered body fields.
                  mapped = {
                    ...mapped,
                    title: cip108.title ?? mapped.title,
                    abstract: cip108.abstract ?? mapped.abstract,
                    motivation: cip108.motivation ?? mapped.motivation,
                    rationale: cip108.rationale ?? mapped.rationale,
                    references: cip108.references ?? mapped.references,
                    links: cip108.references?.map((r) => r.uri) ?? mapped.links,
                    // The hash matched — we KNOW this body is the on-chain
                    // anchor verbatim. Surface that to the UI verification pill.
                    anchorVerified: true,
                    description:
                      cip108.abstract ??
                      cip108.motivation ??
                      cip108.rationale ??
                      mapped.description,
                  };
                }
                metadataGateway = recovered.gatewayUsed;
                metadataRecoveredAt = now;
                console.log(
                  `IPFS fallback recovered: actionId=${actionId} cid=${cid} ` +
                    `gateway=${recovered.gatewayUsed} bodyLen=${recovered.body.length}`,
                );
              } else {
                console.log(
                  `IPFS fallback failed: actionId=${actionId} cid=${cid} ` +
                    `(no public gateway returned hash-matching body)`,
                );
              }
            }
          }
        } else {
          // ---- Legacy Blockfrost fallback ----
          // Koios was unreachable OR didn't carry this specific action.
          // Run the legacy enrichment chain so we degrade gracefully to
          // the pre-Koios behavior. Vote tally still comes from the Koios
          // slice computed above (or undefined if vote_list was also down).
          let anchor: AnchorContent | null = null;
          let submittedAt: string | undefined;
          let fullProposal: BlockfrostProposal = rawAction;

          const [proposalResult, txResult, metaResult] = await Promise.allSettled([
            getGovernanceAction(rawAction.tx_hash, rawAction.cert_index),
            getTx(rawAction.tx_hash),
            getProposalAnchor(rawAction.tx_hash, rawAction.cert_index),
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
          // Populated only when the IPFS multi-gateway fallback recovered a
          // body that Koios couldn't fetch. `metadataGateway` is the full
          // gateway URL that served the bytes; `metadataRecoveredAt` is when
          // we succeeded. Both undefined on the happy path (Koios sufficed)
          // and on persistent-failure rows.
          metadataGateway: metadataGateway ?? (existing?.metadataGateway as string | undefined),
          metadataRecoveredAt:
            metadataRecoveredAt ?? (existing?.metadataRecoveredAt as string | undefined),
          summary: mapped.summary,
          details: mapped.details,
          proposerAddress: mapped.proposerAddress,
          treasuryWithdrawalLovelace: mapped.treasuryWithdrawalLovelace,
          votes: mapped.votes,
          // CIP-1694 role-applicability — pure function of actionType but
          // stamped on the row so reads don't recompute.
          votingRoles: applicableRoles(actionType),
          enrichmentVersion: ENRICHMENT_VERSION,
        };

        await putItem(tableNames.governanceActions, item);
        result.synced++;
      } catch (err) {
        console.error(`Failed to sync governance action ${actionId}:`, err);
        result.errors++;
      }
    });
  }
}

// ---- Voter lookup bundle ----
//
// Built once per cycle. Contains:
//   - drepPower / poolStake / committeeIds: the maps the tally builder
//     uses to convert each raw vote into a power contribution.
//   - alwaysAbstainPower / alwaysNoConfidencePower: predefined-DRep
//     auto-vote totals, applied to every action's DRep slice.
//   - totals: the role-level denominators (count + power), used by the
//     tally builder to compute notVoted = totalActive - cast.

interface VoterLookupBundle {
  lookups: TallyLookups;
  totals: {
    totalDrepCount: number;
    totalDrepPower: bigint;
    totalPoolCount: number;
    totalPoolPower: bigint;
    totalCcCount: number;
    totalCcPower: bigint;
  };
}

const EMPTY_LOOKUPS: VoterLookupBundle = {
  lookups: {},
  totals: {
    totalDrepCount: 0,
    totalDrepPower: 0n,
    totalPoolCount: 0,
    totalPoolPower: 0n,
    totalCcCount: 0,
    totalCcPower: 0n,
  },
};

/**
 * Build the active-voter lookup bundle for one sync cycle. Each role's
 * lookup is independent — if `pool_list` 5xxs we still get DRep + CC, and
 * the resulting tally just reports zero notVoted for SPOs. The user sees
 * partial-but-honest data rather than a stale or fabricated denominator.
 *
 * Predefined-DRep auto-votes are fetched separately because they're not
 * in `drep_list`. If that call fails we treat them as zero — the basic
 * notVoted math is the headline; predefined-DRep accounting is a
 * refinement and can be backfilled in the next cycle.
 */
async function buildVoterLookups(): Promise<VoterLookupBundle> {
  const [drepRes, poolRes, ccRes, predefRes] = await Promise.allSettled([
    listActiveDReps(),
    listActivePools(),
    getCommitteeMembers(),
    getPredefinedDRepPower([DREP_ALWAYS_ABSTAIN, DREP_ALWAYS_NO_CONFIDENCE]),
  ]);

  const lookups: TallyLookups = {};
  const totals = {
    totalDrepCount: 0,
    totalDrepPower: 0n,
    totalPoolCount: 0,
    totalPoolPower: 0n,
    totalCcCount: 0,
    totalCcPower: 0n,
  };

  if (drepRes.status === 'fulfilled') {
    const drepPower = new Map<string, bigint>();
    let total = 0n;
    for (const d of drepRes.value) {
      try {
        const amt = BigInt(d.amount);
        drepPower.set(d.drep_id, amt);
        total += amt;
      } catch {
        // Skip malformed amounts rather than throwing — one bad row
        // shouldn't take down the whole bundle.
      }
    }
    lookups.drepPower = drepPower;
    totals.totalDrepCount = drepPower.size;
    totals.totalDrepPower = total;
  } else {
    console.warn('Governance intake: listActiveDReps failed:', drepRes.reason);
  }

  if (poolRes.status === 'fulfilled') {
    const poolStake = new Map<string, bigint>();
    let total = 0n;
    for (const p of poolRes.value) {
      try {
        const amt = BigInt(p.active_stake);
        poolStake.set(p.pool_id_bech32, amt);
        total += amt;
      } catch {
        // Skip malformed stake values.
      }
    }
    lookups.poolStake = poolStake;
    totals.totalPoolCount = poolStake.size;
    totals.totalPoolPower = total;
  } else {
    console.warn('Governance intake: listActivePools failed:', poolRes.reason);
  }

  if (ccRes.status === 'fulfilled') {
    const committeeIds = new Set<string>();
    for (const m of ccRes.value) {
      if (typeof m.cc_hot_id === 'string') committeeIds.add(m.cc_hot_id);
    }
    lookups.committeeIds = committeeIds;
    totals.totalCcCount = committeeIds.size;
    // CC has no per-voter weighting on mainnet today — power == count.
    totals.totalCcPower = BigInt(committeeIds.size);
  } else {
    console.warn('Governance intake: getCommitteeMembers failed:', ccRes.reason);
  }

  if (predefRes.status === 'fulfilled') {
    lookups.alwaysAbstainPower = predefRes.value.get(DREP_ALWAYS_ABSTAIN) ?? 0n;
    lookups.alwaysNoConfidencePower =
      predefRes.value.get(DREP_ALWAYS_NO_CONFIDENCE) ?? 0n;
    // We do NOT pre-fold these into totals.totalDrepPower. The tally
    // builder is responsible for constructing the per-action denominator:
    //   totalActive = registeredDrepPower + autoNoConfidencePower
    //   totalRegistered = totalActive + autoAbstainPower
    // Per CIP-1694, auto-abstain stake is explicitly EXCLUDED from active
    // voting stake (the ratification denominator). Pre-folding both auto-
    // votes here was the bug that made `totalActive` ~8.9B ADA too large
    // and the percentages correspondingly wrong.
    //
    // We also do NOT add predefined DReps to totalDrepCount — they aren't
    // individual "voters" in the headcount sense; they're auto-vote
    // delegations aggregating many delegators. Reporting "1 DRep voted"
    // because of `drep_always_abstain` would be misleading.
  } else {
    console.warn(
      'Governance intake: getPredefinedDRepPower failed; auto-votes treated as zero:',
      predefRes.reason,
    );
  }

  return { lookups, totals };
}

/**
 * Phase B: build a VoteTally from the Koios-shaped vote slice for one
 * proposal. Normalizes the Koios row format to the Blockfrost shape the
 * pure `tallyVotesWithPower` function consumes, then runs the math. The
 * underlying db-sync data is identical between providers — only field
 * names / casing differ.
 *
 * Returns the zero-totals empty tally when there's nothing to compute
 * (no votes AND no lookups), so the API consumer can tell the data is
 * degraded but not stale.
 */
function buildTallyFromKoiosVotes(
  votes: readonly KoiosVote[],
  bundle: VoterLookupBundle,
  actionType: GovernanceActionType,
): VoteTally {
  if (
    bundle.totals.totalDrepCount === 0 &&
    bundle.totals.totalPoolCount === 0 &&
    bundle.totals.totalCcCount === 0 &&
    votes.length === 0
  ) {
    return emptyVoteTally();
  }
  const adapted = koiosVotesToBlockfrostShape(votes);
  return tallyVotesWithPower(adapted, bundle.totals, bundle.lookups, actionType);
}

// Track whether we've already logged a tally-mismatch warning this cycle.
// Once tripped, subsequent assertions stay quiet — one loud warning per
// cycle is enough; we don't want to spam CloudWatch with 109 lines.
let _tallyMismatchLoggedThisCycle = false;

/**
 * Phase B verification helper: compare the new Koios-derived tally against
 * the previously-stored Blockfrost-derived tally for one action and log
 * loudly on disagreement. Both providers source from cardano-db-sync, so
 * after `ENRICHMENT_VERSION` 11 lands the values should match within the
 * narrow window where:
 *   - Koios's vote_list cache (5 min TTL) lags a fresh on-chain vote, OR
 *   - the tally was last computed against a different active-voter
 *     denominator (DReps re-register, pools retire, etc.)
 *
 * Both windows are normal and self-correct on the next cycle. The
 * assertion exists to catch shape-adapter bugs (wrong role label, wrong
 * vote casing) where the math would silently zero out — those would
 * register as a step change in `yes` / `no` / `abstain` power, not a
 * percent-level drift.
 *
 * NEVER throws: a failing assertion logs and continues. The user-visible
 * data is the new tally; the assertion is a diagnostic only.
 */
function assertTallyMatchesPrevious(
  actionId: string,
  prev: VoteTally | undefined,
  next: VoteTally,
): void {
  if (!prev) return;
  if (_tallyMismatchLoggedThisCycle) return;
  // Only check DReps — the role with the largest stake and the most
  // sensitive math. SPO/CC drift is dominated by membership churn, not
  // shape-adapter bugs.
  const prevYes = prev.drep?.yes?.power;
  const nextYes = next.drep?.yes?.power;
  const prevNo = prev.drep?.no?.power;
  const nextNo = next.drep?.no?.power;
  if (prevYes == null || nextYes == null || prevNo == null || nextNo == null) return;
  let prevYesB: bigint;
  let nextYesB: bigint;
  let prevNoB: bigint;
  let nextNoB: bigint;
  try {
    prevYesB = BigInt(prevYes);
    nextYesB = BigInt(nextYes);
    prevNoB = BigInt(prevNo);
    nextNoB = BigInt(nextNo);
  } catch {
    return;
  }
  // Tolerate small drift — totals can shift epoch-to-epoch. 1% threshold
  // is generous; a shape-adapter bug would zero out a slice (100% drift).
  const yesDiff = prevYesB > nextYesB ? prevYesB - nextYesB : nextYesB - prevYesB;
  const noDiff = prevNoB > nextNoB ? prevNoB - nextNoB : nextNoB - prevNoB;
  const yesMax = prevYesB > nextYesB ? prevYesB : nextYesB;
  const noMax = prevNoB > nextNoB ? prevNoB : nextNoB;
  // Avoid divide-by-zero. If both sides are zero, the slice agrees.
  const yesDriftBps = yesMax > 0n ? (yesDiff * 10000n) / yesMax : 0n;
  const noDriftBps = noMax > 0n ? (noDiff * 10000n) / noMax : 0n;
  if (yesDriftBps > 100n || noDriftBps > 100n) {
    _tallyMismatchLoggedThisCycle = true;
    console.warn(
      `Governance intake: tally drift on ${actionId}: ` +
        `drep.yes ${prevYesB} -> ${nextYesB} (${yesDriftBps}bps), ` +
        `drep.no ${prevNoB} -> ${nextNoB} (${noDriftBps}bps). ` +
        `Continuing with new tally; suppressing further mismatch warnings this cycle.`,
    );
  }
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
