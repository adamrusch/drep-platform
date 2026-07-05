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
  type BlockfrostEpoch,
  type BlockfrostProposal,
} from '../lib/blockfrost';
import {
  extractIpfsCid,
  fetchIpfsAnchor,
  fetchGithubHistoricalAnchor,
} from '../lib/ipfsGateway';
import {
  listProposals as listKoiosProposals,
  listActiveDReps,
  listActivePools,
  listAllVotes,
  groupVotesByProposal,
  getCommitteeMembers,
  getCurrentTip,
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
import { batchGetItems, getItem, putItem, putItemIfAbsent, queryItems, tableNames } from '../lib/dynamodb';
import { nowISO, nowSec } from '../lib/time';
import {
  fanoutAutoPosts,
  selectCompletionSweepCandidates,
  selectFanoutCandidates,
  unpinAutoPostsForAction,
} from './clubhouseAutoPosts';
import type { DRepDirectoryItem } from '../lib/types';
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
  /** Auto-post fan-out stats — number of newly-detected GAs that
   *  triggered a fan-out, total post writes across all of them, and
   *  the sweep counts for any GAs that completed this cycle.
   *  Optional on the result shape so existing callers don't need a
   *  matching update. */
  autoPosts?: {
    fannedOutForActions: number;
    postsWritten: number;
    postsSkipped: number;
    postsErrored: number;
    completionSweepActions: number;
    completionSweepUnpinned: number;
  };
  /** Koios db-sync lag this cycle, in seconds (`Math.max(0, wallClock -
   *  tip.block_time)`). Set when the cycle was able to read `/tip`
   *  successfully; absent when we fell back to Blockfrost or the
   *  `/tip` call failed entirely. The structured `[Koios tip lag]`
   *  warning is emitted inside `getCurrentTip` itself when the lag
   *  exceeds the threshold; this field gives forensic visibility into
   *  the same value from the sync's per-cycle log. */
  koiosTipLagSec?: number;
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
 * v12 → v13: two extra fallback techniques for the last 2 mainnet
 * holdouts whose body Koios couldn't fetch and whose IPFS multi-gateway
 * walk failed in v12.
 *   (a) IPFS hash-mismatch surfacing. When every reachable public gateway
 *       returns the same body and that body does NOT hash-match the on-
 *       chain anchor hash, we now still surface the content with
 *       `anchorVerified: false` and a new `anchorHashMismatch: true` flag.
 *       Rationale: some proposers (joke proposals, copy-paste errors)
 *       publish mismatched content. CIP-1694 doesn't require us to hide
 *       it; it just means we can't attest to chain integrity. The UI
 *       renders a prominent "Hash mismatch" warning. Recovers the HOSKY
 *       Hard Fork proposal from governance day 1.
 *   (b) `raw.githubusercontent.com` historical-commit walk. When the
 *       anchor URL is a branch-ref github raw URL (e.g. `…/refs/heads/main/
 *       path/to/file`) and the current bytes don't hash-match (or 404),
 *       we walk that file's commit history via the GitHub Commits API
 *       and return the first commit whose blob hash-matches the on-chain
 *       anchor. Hash IS verified on the historical bytes, so
 *       `anchorVerified` stays true. Rows recovered this way carry
 *       `anchorRecoveredFromCommit` (short SHA) and
 *       `anchorRecoveredFromCommitDate`. Recovers the ICC PPU October
 *       2024 action whose file was moved by commit `c221c0f6f6` ("change
 *       path for existing action to break rendering") but whose parent
 *       `cd7bccf0e4` still has the right bytes.
 * Bumping the version forces all rows to re-run cold enrichment so the
 * new recovery paths land on the next sync.
 *
 * v13 → v14: anchorless-row self-heal. A row whose FIRST cold enrichment
 *       missed the on-chain anchor pointer (Koios down that cycle, or it
 *       returned a transient null `meta_url`) was locked into
 *       `metadataSource='none'` forever: active proposals get frequent
 *       warm-path vote updates that bump `lastSyncedAt`, so the 24h
 *       freshness window never elapsed and the cold path never re-ran.
 *       The UI then shows "(No off-chain metadata)" for a GA that DOES have
 *       an anchor on-chain. Fix: `isEnrichmentFresh` now forces re-enrichment
 *       of anchorless ACTIVE proposals on a short (1h) cadence until the
 *       anchor resolves. The version bump also backfills every existing row
 *       once on the next sync.
 */
const ENRICHMENT_VERSION = 14;

/**
 * Shorter re-enrichment cadence for ACTIVE proposals that still have no
 * off-chain anchor captured. Lets a row that missed its anchor on the first
 * (or a transiently-degraded) cold pass keep retrying until Koios serves the
 * `meta_url`, instead of being frozen by the 24h window that warm-path vote
 * updates keep alive. Bounded to anchorless active rows, so genuinely
 * anchor-free or completed proposals don't churn.
 */
const ENRICHMENT_ANCHORLESS_RETRY_MS = 60 * 60 * 1000; // 1 hour

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

  // Anchorless ACTIVE proposals: an earlier cold pass failed to capture the
  // off-chain anchor pointer (no anchorUrl AND metadataSource 'none'). Because
  // active proposals get frequent warm-path vote updates that refresh
  // `lastSyncedAt`, the normal 24h window would never elapse and the row would
  // stay "(No off-chain metadata)" permanently even though the anchor is on
  // chain. Retry these on a short cadence until the anchor resolves. Scoped to
  // active rows so genuinely anchor-free or completed proposals don't churn.
  const metadataSource = (existing['metadataSource'] as string | undefined) ?? 'none';
  const anchorMissing = metadataSource === 'none' && !existing['anchorUrl'];
  if (anchorMissing && existing['status'] === 'active') {
    return now - lastSync < ENRICHMENT_ANCHORLESS_RETRY_MS;
  }

  return now - lastSync < ENRICHMENT_TTL_MS;
}

export async function runGovernanceIntake(): Promise<IntakeResult> {
  const result: IntakeResult = { synced: 0, skipped: 0, errors: 0 };
  _tallyMismatchLoggedThisCycle = false;

  // ---- Auto-post bookkeeping ----
  //
  // For Batch B (GA auto-post feature, 2026-05-26) we need to:
  //   - detect newly-INSERTED GA rows (no existing row before this cycle)
  //     and fan out one `auto_ga` clubhouse post per currently-active DRep
  //   - detect GA rows that TRANSITIONED into a completed status (`expired`
  //     / `enacted` / `dropped`) this cycle and unpin all their linked
  //     auto-posts
  //
  // We collect (previous, next) pairs during the per-action loop and
  // process them once after the loop completes — keeping the per-action
  // path side-effect-free with respect to the clubhouse_posts table.
  const newGAItems: GovernanceActionItem[] = [];
  const transitionPairs: { actionId: string; previous: GovernanceActionItem | undefined; next: GovernanceActionItem }[] = [];

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
  //
  // The Koios `/tip` call also feeds the db-sync staleness check — when it
  // succeeds we thread `lagSec` onto the result so the per-cycle log
  // surfaces it inline, and `getCurrentTip` itself emits a structured
  // `[Koios tip lag]` warning when the lag exceeds the threshold. On
  // Blockfrost fallback we leave `koiosTipLagSec` absent (we have no
  // analogous staleness signal for Blockfrost).
  let currentEpoch: number;
  try {
    const tip = await getCurrentTip();
    currentEpoch = tip.epochNo;
    result.koiosTipLagSec = tip.lagSec;
  } catch (koiosErr) {
    console.warn('Governance intake: Koios /tip unavailable, falling back to Blockfrost:', koiosErr);
    let epochInfo: BlockfrostEpoch;
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
    // ---- Phase C: persist per-vote events ----
    // Append-only write of every vote into `governance_votes`. Bounded by
    // a persistent high-water-mark to keep the per-cycle DynamoDB cost
    // bounded — without it every 1-min sync would re-attempt 24k
    // conditional Puts (~24k WCU/cycle = 34M WCU/day, ~$43/mo).
    //
    // Failures in this pass are non-fatal: vote events are an additive
    // enrichment, and a failed cycle just means the next cycle picks up
    // the missed window via the watermark.
    try {
      const written = await persistVoteEvents(votesRes.value);
      console.log(
        `Governance intake: governance_votes wrote=${written.written} skipped=${written.skipped} errored=${written.errored} watermark=${written.newWatermark}`,
      );
    } catch (err) {
      console.warn('Governance intake: persistVoteEvents failed (non-fatal):', err);
    }
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

  async function finishIntakeAsync(): Promise<IntakeResult> {
    // Process auto-post fan-out + completion sweep before logging the
    // summary. Failures here are non-fatal and are surfaced on the
    // `result.autoPosts` block.
    try {
      await processAutoPostFanout(result, newGAItems, transitionPairs);
    } catch (err) {
      console.warn('Governance intake: auto-post fan-out threw (non-fatal):', err);
    }
    console.log(
      `Governance intake complete: written=${result.synced}, enrichmentSkipped=${result.skipped}, errors=${result.errors}; ` +
        `lookups: drep=${lookupBundle.lookups.drepPower?.size ?? 0}/${lookupBundle.totals.totalDrepCount} pools=${lookupBundle.lookups.poolStake?.size ?? 0}/${lookupBundle.totals.totalPoolCount} cc=${lookupBundle.totals.totalCcCount}` +
        (result.koiosTipLagSec !== undefined
          ? `; koiosTipLagSec=${result.koiosTipLagSec}`
          : '') +
        (result.autoPosts
          ? `; autoPosts: fannedOutForActions=${result.autoPosts.fannedOutForActions} ` +
            `postsWritten=${result.autoPosts.postsWritten} ` +
            `postsSkipped=${result.autoPosts.postsSkipped} ` +
            `postsErrored=${result.autoPosts.postsErrored} ` +
            `completionSweepActions=${result.autoPosts.completionSweepActions} ` +
            `completionSweepUnpinned=${result.autoPosts.completionSweepUnpinned}`
          : ''),
    );
    return result;
  }

  // Keep the legacy sync-shaped `finishIntake` for the two return
  // points above (page loop, fast path). They both early-return out of
  // the closure, so we forward through an `await` here.
  function finishIntake(): Promise<IntakeResult> {
    return finishIntakeAsync();
  }

  async function processActions(rawActions: BlockfrostProposal[]): Promise<void> {
    // Cost-fix (2026-07-04 code review): warm the existing-row lookup via a
    // single BatchGet before entering the per-action worker loop. Previously
    // every action fired its own GetItem inside the worker (109 sequential
    // reads on mainnet, ~54.5 RCU/cycle, ~78k RCU/day at 1-min cadence).
    // BatchGet caps at 100 keys per call; `batchGetItems` handles chunking
    // + `UnprocessedKeys` retries. On the current ~109-action mainnet this
    // is 2 calls; on quiet cycles it stays at 1.
    //
    // The map's presence-is-hit semantic matches the prior null-on-miss
    // shape — a row that isn't in the map goes straight into the cold path,
    // same as when the per-action GetItem returned undefined.
    const keys = rawActions.map((a) => ({
      actionId: `${a.tx_hash}#${a.cert_index}`,
      SK: 'ACTION',
    }));
    const preloaded = await batchGetItems<GovernanceActionItem>(
      tableNames.governanceActions,
      keys,
    );
    const existingByActionId = new Map<string, GovernanceActionItem>(
      preloaded.map((row) => [row.actionId, row]),
    );

    await processWithConcurrency(rawActions, ITEM_CONCURRENCY, async (rawAction) => {
      const actionId = `${rawAction.tx_hash}#${rawAction.cert_index}`;
      try {
        const existing = existingByActionId.get(actionId);

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
          // changed.
          //
          // NOTE: `lastSyncedAt` IS load-bearing for `isEnrichmentFresh` (it
          // gates the 24h window). When votes/status DO change, the Put below
          // bumps `lastSyncedAt`, which keeps an active proposal's freshness
          // window alive indefinitely — so a row that was cold-enriched once
          // with a missing anchor never re-enriches on the normal path. The
          // anchorless-active short-retry branch in `isEnrichmentFresh` is the
          // escape hatch that lets those rows self-heal.
          if (governanceItemsEqualIgnoringSync(existing as GovernanceActionItem, updated)) {
            result.skipped++;
            // Record the transition pair even on no-op cycles — if the
            // GA was already completed last cycle the sweep filter will
            // ignore it, but if it JUST completed (rare on the hot path
            // since the status field changing forces a Put) we still
            // want the unpin sweep to run.
            transitionPairs.push({
              actionId,
              previous: existing as GovernanceActionItem,
              next: updated,
            });
            return;
          }
          await putItem(tableNames.governanceActions, updated);
          transitionPairs.push({
            actionId,
            previous: existing as GovernanceActionItem,
            next: updated,
          });
          // Bug fix: the hot path used to increment `skipped` even when
          // it issued a Put, which made the cycle log line read
          // `written=0` indefinitely even though DynamoDB was logging
          // ~30–80 Puts/hr. The metric is the only operator-visible
          // signal of the actual write rate, so it has to count the
          // genuine writes the same as the cold path on line ~882.
          result.synced++;
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

        // Holders for the fallback-recovery audit fields. Populated only when
        // a fallback technique successfully (or, for hash-mismatch, partially)
        // recovered the off-chain body that Koios couldn't fetch. See the
        // v12 / v13 ENRICHMENT_VERSION notes above for the per-field meaning.
        let metadataGateway: string | undefined;
        let metadataRecoveredAt: string | undefined;
        let anchorHashMismatch: boolean | undefined;
        let anchorRecoveredFromCommit: string | undefined;
        let anchorRecoveredFromCommitDate: string | undefined;

        if (koiosRecord) {
          // ---- Koios fast path ----
          // Bulk listing already gave us metadata, on-chain description,
          // submittedAt, anchor URL/hash/validity, and lifecycle epochs.
          mapped = mapKoiosProposalToGovernanceAction(koiosRecord, currentEpoch, { votes });

          // ---- Anchor-fallback chain (Koios body was missing) ----
          //
          // When Koios has the anchor pointer but couldn't fetch/validate the
          // body, we run a layered fallback chain. Each technique covers a
          // different failure mode of the off-chain transport:
          //   1. IPFS hash-match — Koios couldn't route the CID but a public
          //      gateway can. Body bytes hash-verify against the on-chain
          //      anchor hash. Canonical, anchorVerified=true.
          //   2. IPFS hash-mismatch — every reachable gateway returned the
          //      SAME body whose hash differs from the on-chain hash. The
          //      proposer published mismatched content (joke proposal,
          //      copy-paste error). Surface it with anchorVerified=false and
          //      anchorHashMismatch=true so the UI renders a clear warning.
          //   3. GitHub commit-walk — anchor URL is on raw.githubusercontent.com
          //      with a branch ref. The file was edited after submission; we
          //      walk the file's commit history and return the first commit
          //      whose blob hash-matches. anchorVerified=true (the historical
          //      bytes hashed correctly).
          //
          // Only attempt when:
          //   - The mapped body is empty (no title AND no abstract/motivation/
          //     rationale parsed — i.e. Koios returned null `meta_json`), AND
          //   - The anchor has a URL we can route, AND
          //   - The anchor has a hash we can verify against.
          // The 24h enrichment-fresh window means a failed recovery won't
          // re-fire for 24 hours — so a permanently-lost anchor costs us
          // at most one walk per row per day, not one per minute.
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
            const metaUrl = koiosRecord.meta_url;
            const metaHash = koiosRecord.meta_hash;

            // ---- Technique 1+2: IPFS gateway walk ----
            // Returns null only if no gateway is reachable AT ALL. A
            // non-null result carries `hashMatch: true|false` so we branch
            // here. The function itself handles the multi-gateway walk +
            // mismatch surfacing logic.
            const cid = extractIpfsCid(metaUrl);
            const recovered: { applied: boolean } = { applied: false };
            if (cid) {
              const ipfsRes = await fetchIpfsAnchor(cid, metaHash);
              if (ipfsRes) {
                let parsedJson: Record<string, unknown> | null = null;
                try {
                  const candidate = JSON.parse(ipfsRes.body) as unknown;
                  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
                    parsedJson = candidate as Record<string, unknown>;
                  }
                } catch {
                  // Body wasn't JSON — treat as recoverable-but-not-CIP-108.
                  // No body fields to populate; the gateway audit fields
                  // still get stamped so a future debug pass can inspect.
                }
                if (parsedJson) {
                  // parseCip108Body itself swallows malformed-shape errors
                  // (returns {}), but wrap defensively per the holdout
                  // rationale: the HOSKY body is well-formed but exotic
                  // proposals might not be.
                  let cip108: ReturnType<typeof parseCip108Body>;
                  try {
                    cip108 = parseCip108Body(parsedJson);
                  } catch (err) {
                    console.warn(
                      `parseCip108Body threw on recovered body for ${actionId}:`,
                      err,
                    );
                    cip108 = {} as ReturnType<typeof parseCip108Body>;
                  }
                  mapped = {
                    ...mapped,
                    title: cip108.title ?? mapped.title,
                    abstract: cip108.abstract ?? mapped.abstract,
                    motivation: cip108.motivation ?? mapped.motivation,
                    rationale: cip108.rationale ?? mapped.rationale,
                    references: cip108.references ?? mapped.references,
                    links: cip108.references?.map((r) => r.uri) ?? mapped.links,
                    // When the hash matched we know the bytes are the
                    // on-chain anchor verbatim — verified=true. When it
                    // didn't match we surface the content but FORCE
                    // verified=false so the UI's verification pill is
                    // honest. anchorHashMismatch is the more specific flag.
                    anchorVerified: ipfsRes.hashMatch,
                    description:
                      cip108.abstract ??
                      cip108.motivation ??
                      cip108.rationale ??
                      mapped.description,
                  };
                }
                metadataGateway = ipfsRes.gatewayUsed;
                metadataRecoveredAt = now;
                if (!ipfsRes.hashMatch) {
                  anchorHashMismatch = true;
                }
                recovered.applied = true;
                console.log(
                  `IPFS fallback ${ipfsRes.hashMatch ? 'recovered' : 'recovered (HASH MISMATCH)'}: ` +
                    `actionId=${actionId} cid=${cid} gateway=${ipfsRes.gatewayUsed} ` +
                    `bodyLen=${ipfsRes.body.length} computedHash=${ipfsRes.computedHash}`,
                );
              } else {
                console.log(
                  `IPFS fallback failed: actionId=${actionId} cid=${cid} ` +
                    `(no public gateway reachable)`,
                );
              }
            }

            // ---- Technique 3: GitHub historical-commit walk ----
            // Only attempt when the IPFS path didn't surface anything (no
            // body parsed). If IPFS got us a body — even a hash-mismatched
            // one — we keep that result; running the GitHub walk on top
            // would mostly be wasted requests for non-github URLs.
            if (
              !recovered.applied &&
              /^https?:\/\/raw\.githubusercontent\.com\//i.test(metaUrl)
            ) {
              const gh = await fetchGithubHistoricalAnchor(metaUrl, metaHash);
              if (gh) {
                let parsedJson: Record<string, unknown> | null = null;
                try {
                  const candidate = JSON.parse(gh.body) as unknown;
                  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
                    parsedJson = candidate as Record<string, unknown>;
                  }
                } catch {
                  // Same defensive note as the IPFS branch.
                }
                if (parsedJson) {
                  let cip108: ReturnType<typeof parseCip108Body>;
                  try {
                    cip108 = parseCip108Body(parsedJson);
                  } catch (err) {
                    console.warn(
                      `parseCip108Body threw on GitHub-historical body for ${actionId}:`,
                      err,
                    );
                    cip108 = {} as ReturnType<typeof parseCip108Body>;
                  }
                  mapped = {
                    ...mapped,
                    title: cip108.title ?? mapped.title,
                    abstract: cip108.abstract ?? mapped.abstract,
                    motivation: cip108.motivation ?? mapped.motivation,
                    rationale: cip108.rationale ?? mapped.rationale,
                    references: cip108.references ?? mapped.references,
                    links: cip108.references?.map((r) => r.uri) ?? mapped.links,
                    // The HISTORICAL bytes hash-matched, so anchor IS
                    // verified — we attest the bytes the user reads are
                    // the bytes the on-chain hash committed to.
                    anchorVerified: true,
                    description:
                      cip108.abstract ??
                      cip108.motivation ??
                      cip108.rationale ??
                      mapped.description,
                  };
                }
                anchorRecoveredFromCommit = gh.commitSha.slice(0, 10);
                anchorRecoveredFromCommitDate = gh.commitDate;
                metadataRecoveredAt = now;
                recovered.applied = true;
                console.log(
                  `GitHub history fallback recovered: actionId=${actionId} ` +
                    `commit=${gh.commitSha.slice(0, 10)} commitDate=${gh.commitDate} ` +
                    `bodyLen=${gh.body.length}`,
                );
              } else {
                console.log(
                  `GitHub history fallback failed: actionId=${actionId} url=${metaUrl}`,
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
          // v13 fallback-audit fields. `anchorHashMismatch` is true ONLY on
          // rows where the IPFS body was reachable but the bytes' hash
          // disagreed with the on-chain anchor (proposer published mismatched
          // content). `anchorRecoveredFromCommit` (+ date) is set ONLY on
          // rows recovered via the GitHub historical-commit walk. All three
          // are preserved from the existing row on cycles where the cold
          // path didn't re-fire (so once recovered, the row keeps the audit
          // trail until something invalidates it).
          anchorHashMismatch:
            anchorHashMismatch ?? (existing?.anchorHashMismatch as boolean | undefined),
          anchorRecoveredFromCommit:
            anchorRecoveredFromCommit ??
            (existing?.anchorRecoveredFromCommit as string | undefined),
          anchorRecoveredFromCommitDate:
            anchorRecoveredFromCommitDate ??
            (existing?.anchorRecoveredFromCommitDate as string | undefined),
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
        // Track this write for the post-loop auto-post fan-out.
        // - "new GA" = no existing row before this cycle. These trigger
        //   the per-active-DRep fan-out (one auto_ga row per drepId).
        // - All cold-path writes are also transition candidates: the
        //   cold path re-runs on a row that JUST transitioned into a
        //   completed state (status changed since last successful
        //   sync). The completion-sweep filter only fires the unpin
        //   sweep when the transition is INTO a completed state, so
        //   recording the pair unconditionally is safe.
        if (!existing) {
          newGAItems.push(item);
        }
        transitionPairs.push({
          actionId,
          previous: existing,
          next: item,
        });
      } catch (err) {
        console.error(`Failed to sync governance action ${actionId}:`, err);
        result.errors++;
      }
    });
  }
}

/**
 * Read the currently-active DRep IDs from the directory. Used by the
 * auto-post fan-out path — we only fan out into clubhouses for DReps
 * that are currently active.
 *
 * Uses the sparse `entityType-votingPower-index` GSI added in PR #2,
 * which returns every PROFILE row in 2-3 Query round-trips. Falls back
 * to an empty list on Query failure — the next cycle will retry. We
 * deliberately do NOT fall through to a Scan: the table contains ~100k
 * POWER history rows and a Scan-with-filter would be expensive.
 *
 * Excludes retired DReps. Includes the two predefined DReps
 * (`drep_always_abstain`, `drep_always_no_confidence`) since those
 * have `isActive=true` and are real participants in the governance
 * landscape — their delegators should see auto-posts too.
 */
async function loadActiveDRepIds(): Promise<string[]> {
  const out: string[] = [];
  let lastKey: Record<string, unknown> | undefined;
  try {
    do {
      const queryRes = await queryItems<DRepDirectoryItem>(
        tableNames.drepDirectory,
        {
          indexName: 'entityType-votingPower-index',
          keyConditionExpression: '#et = :v',
          expressionAttributeNames: { '#et': 'entityType' },
          expressionAttributeValues: { ':v': 'DREP_PROFILE' },
          ...(lastKey ? { exclusiveStartKey: lastKey } : {}),
        },
      );
      for (const r of queryRes.items) {
        // Skip inactive / retired. Predefined DReps have `isActive=true`
        // already so they're included naturally.
        if (r.isActive === true) out.push(r.drepId);
      }
      lastKey = queryRes.lastEvaluatedKey;
    } while (lastKey);
  } catch (err) {
    console.warn('loadActiveDRepIds: query failed; skipping auto-post fan-out this cycle:', err);
    return [];
  }
  return out;
}

/**
 * After the per-action sync loop completes, fan out auto-posts for any
 * newly-inserted GA rows and run the completion sweep for any GAs
 * that transitioned into a completed status this cycle.
 *
 * Errors are logged and reported on the result; they do NOT throw —
 * a failure to write an auto-post must not poison the governance-
 * action sync.
 */
async function processAutoPostFanout(
  result: IntakeResult,
  newGAItems: readonly GovernanceActionItem[],
  transitionPairs: readonly { actionId: string; previous: GovernanceActionItem | undefined; next: GovernanceActionItem }[],
): Promise<void> {
  if (newGAItems.length === 0 && transitionPairs.length === 0) return;

  const stats = {
    fannedOutForActions: 0,
    postsWritten: 0,
    postsSkipped: 0,
    postsErrored: 0,
    completionSweepActions: 0,
    completionSweepUnpinned: 0,
  };

  // Fan-out for newly-detected GAs. SEC-2 (2026-05-28): a brand-new GA
  // whose status is already `enacted` / `expired` / `dropped` is filtered
  // out — fanning out ~368 pinned posts that the immediate sweep would
  // unpin (and then the new-rows-fan-out + sweep noise in CloudWatch)
  // for an auto-post that's invisible to delegators is ~736 wasted
  // writes per born-completed GA. Active GAs (the common case) pass
  // through unchanged.
  const fanoutCandidates = selectFanoutCandidates(newGAItems);
  if (fanoutCandidates.length > 0) {
    // Only load the DRep list when we have at least one fan-out
    // candidate — on quiet cycles (the common case) we skip the GSI
    // query entirely.
    const drepIds = await loadActiveDRepIds();
    if (drepIds.length === 0) {
      console.warn(
        `auto-post fan-out: 0 active DReps loaded; skipping fan-out for ${fanoutCandidates.length} new GA(s)`,
      );
    } else {
      const bornCompletedSkipped = newGAItems.length - fanoutCandidates.length;
      console.log(
        `auto-post fan-out: ${fanoutCandidates.length} new GA(s) × ${drepIds.length} active DReps` +
          (bornCompletedSkipped > 0
            ? ` (skipped ${bornCompletedSkipped} born-completed GA(s))`
            : ''),
      );
      for (const ga of fanoutCandidates) {
        try {
          // The `now` we pass here is what gets stamped on every row's
          // `abstractFrozenAt` AND `createdAt`. Using a single timestamp
          // per fan-out call makes the "all rows for this GA were created
          // at the same moment" invariant explicit.
          const now = nowISO();
          const fanRes = await fanoutAutoPosts({ action: ga, drepIds, now });
          stats.fannedOutForActions++;
          stats.postsWritten += fanRes.written;
          stats.postsSkipped += fanRes.skipped;
          stats.postsErrored += fanRes.errored;
        } catch (err) {
          console.warn(`auto-post fan-out failed for action ${ga.actionId}:`, err);
          // Don't increment result.errors — the GA sync succeeded; only
          // the auto-post side-effect failed. Surface it on the auto-
          // post stats so it's visible in CloudWatch.
          stats.postsErrored++;
        }
      }
    }
  } else if (newGAItems.length > 0) {
    // All new GAs were born-completed — log the skip explicitly so
    // CloudWatch shows the work was intentionally avoided.
    console.log(
      `auto-post fan-out: skipped all ${newGAItems.length} new GA(s) (born-completed)`,
    );
  }

  // Completion sweep — find GAs that transitioned INTO a completed
  // status this cycle and unpin their auto-posts.
  const sweepCandidates = selectCompletionSweepCandidates(transitionPairs);
  if (sweepCandidates.length > 0) {
    console.log(
      `auto-post completion sweep: ${sweepCandidates.length} GA(s) transitioned to completed state`,
    );
    for (const c of sweepCandidates) {
      try {
        const sweepRes = await unpinAutoPostsForAction(c.actionId);
        stats.completionSweepActions++;
        stats.completionSweepUnpinned += sweepRes.unpinned;
        if (sweepRes.errored > 0) {
          stats.postsErrored += sweepRes.errored;
        }
        console.log(
          `auto-post sweep ${c.actionId}: prevStatus=${c.previousStatus ?? '(none)'} ` +
            `→ ${c.nextStatus}, unpinned=${sweepRes.unpinned}, errored=${sweepRes.errored}`,
        );
      } catch (err) {
        console.warn(`auto-post sweep failed for action ${c.actionId}:`, err);
        stats.postsErrored++;
      }
    }
  }

  result.autoPosts = stats;
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

// ============================================================
// Phase C — per-vote event persistence
// ============================================================
//
// Writes one row per individual on-chain governance vote into the
// `governance_votes` table. The data is already in memory (the
// `vote_list` fetch above) so we're not adding any Koios calls —
// this is pure storage.
//
// **Cost-control via watermark.** On mainnet today there are ~24k votes;
// re-writing all of them every 1-minute sync would burn ~24k WCU/cycle
// (~$43/mo at on-demand rates) for almost no real change — typical
// daily delta is ~50 new votes. We persist a high-water-mark
// (max `block_time` seen) in the `auth_nonces` table and only attempt
// to write votes with `block_time > watermark` on subsequent cycles.
//
// **Idempotency** is double-belted: even past the watermark, every Put
// is conditional on `attribute_not_exists`, so a re-introduced row
// (e.g. after the watermark gets corrupted) silently lands as "skipped"
// rather than overwriting an existing entry.
//
// **Crash safety:** the watermark is bumped only AFTER all writes for a
// cycle complete. A crash mid-cycle leaves the watermark un-bumped, so
// the next cycle re-walks the same window — every duplicate Put becomes
// a skipped conditional check (1 WCU each, bounded). The walk-forward
// is bounded too: we never look further back than `WATERMARK_LOOKBACK_SECONDS`,
// preventing a corrupted watermark from triggering a re-write of 6 months
// of history.

const VOTE_WATERMARK_KEY = '_watermark:governance_votes_block_time';
/** Maximum gap between the stored watermark and the oldest vote we'll
 *  consider writing on this cycle. 24 hours × 3600 s.
 *
 *  Sized as a safety net for "container crash mid-cycle" / "DDB watermark
 *  write failed but cycle wrote rows" / "manual cherry-pick of missed votes."
 *  Wider than that wastes WCU re-attempting old votes the conditional Put
 *  will skip anyway — at ~500 votes/day on mainnet, a 24h window means
 *  ~500 conditional-check WCUs per cycle (~$0.02/day) vs ~33k WCUs for
 *  a 7-day window. The watermark itself is the primary cost-control;
 *  this just bounds the worst-case re-walk if something corrupted it. */
const WATERMARK_LOOKBACK_SECONDS = 24 * 3_600;
/** Concurrent in-flight conditional Puts. DynamoDB on-demand handles ~4k
 *  WPS per partition; this table's PK distribution (`actionId` = ~109
 *  distinct values) sees ~24k votes spread across them, ~220 votes per PK
 *  in the worst case. 16 lanes is conservative and stays well under the
 *  per-partition limits while keeping wall-clock under 30s on a cold
 *  backfill. */
const VOTE_WRITE_CONCURRENCY = 16;

interface VotePersistResult {
  written: number;
  skipped: number;
  errored: number;
  newWatermark: number;
}

async function readVoteWatermark(): Promise<number> {
  try {
    const item = await getItem<{ nonce: string; blockTime?: number }>(
      tableNames.authNonces,
      { nonce: VOTE_WATERMARK_KEY },
    );
    if (item && typeof item.blockTime === 'number' && Number.isFinite(item.blockTime)) {
      return item.blockTime;
    }
  } catch (err) {
    console.warn('readVoteWatermark failed; treating as 0 (full backfill):', err);
  }
  return 0;
}

async function writeVoteWatermark(blockTime: number): Promise<void> {
  // `auth_nonces` has TTL on `expiresAt` but the watermark must NOT
  // expire — write a far-future value (current time + 100 years) so the
  // DynamoDB TTL janitor never reaps it. The watermark is a permanent
  // state, not a session marker.
  const farFuture = nowSec() + 100 * 365 * 86_400;
  await putItem(tableNames.authNonces, {
    nonce: VOTE_WATERMARK_KEY,
    kind: 'watermark',
    walletAddress: '_system',
    blockTime,
    expiresAt: farFuture,
    updatedAt: nowISO(),
  });
}

/**
 * Persist every vote in `votes` to `governance_votes`. Skips rows whose
 * `block_time` is below the stored watermark; re-attempts (conditional)
 * for rows at-or-above. Bounded backfill via `WATERMARK_LOOKBACK_SECONDS`.
 */
async function persistVoteEvents(votes: readonly KoiosVote[]): Promise<VotePersistResult> {
  const watermark = await readVoteWatermark();
  const lookbackFloor = Math.max(0, watermark - WATERMARK_LOOKBACK_SECONDS);

  // Filter to rows we'll consider writing. We pull rows whose block_time
  // is >= the lookback floor (which equals `watermark - 7d`, or 0 on cold
  // start). Past that we rely on the conditional Put to no-op.
  const candidates = votes.filter((v) => {
    if (typeof v.block_time !== 'number' || !Number.isFinite(v.block_time)) return false;
    if (typeof v.proposal_tx_hash !== 'string' || v.proposal_tx_hash.length === 0) return false;
    if (typeof v.voter_id !== 'string' || v.voter_id.length === 0) return false;
    return v.block_time >= lookbackFloor;
  });

  if (candidates.length === 0) {
    return { written: 0, skipped: 0, errored: 0, newWatermark: watermark };
  }

  let written = 0;
  let skipped = 0;
  let errored = 0;
  let maxBlockTime = watermark;

  let cursor = 0;
  const lane = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= candidates.length) return;
      const v = candidates[i]!;
      const actionId = `${v.proposal_tx_hash}#${v.proposal_index}`;
      const voteKey = `${v.voter_role}#${v.voter_id}#${v.vote_tx_hash}`;
      const item = {
        actionId,
        voteKey,
        voterRole: v.voter_role,
        voterId: v.voter_id,
        vote: v.vote,
        votedAt: new Date(v.block_time * 1000).toISOString(),
        blockTime: v.block_time,
        epochNo: v.epoch_no,
        voteTxHash: v.vote_tx_hash,
        ...(v.meta_url ? { metaUrl: v.meta_url } : {}),
        ...(v.meta_hash ? { metaHash: v.meta_hash } : {}),
        ingestedAt: nowISO(),
      };
      const result = await putItemIfAbsent(tableNames.governanceVotes, item, {
        partitionKey: 'actionId',
        sortKey: 'voteKey',
      });
      if (result.outcome === 'written') {
        written++;
      } else if (result.outcome === 'skipped') {
        skipped++;
      } else {
        errored++;
        if (result.error) {
          console.warn(`persistVoteEvents put failed for ${actionId}#${voteKey}:`, result.error);
        }
      }
      if (v.block_time > maxBlockTime) maxBlockTime = v.block_time;
    }
  };
  await Promise.all(Array.from({ length: VOTE_WRITE_CONCURRENCY }, () => lane()));

  // Only advance the watermark when we had zero errored writes; a half-
  // completed cycle should be retried on the next sync rather than
  // skipped because of the bumped watermark. The conditional-Put
  // idempotency guarantees no duplicates on the retry.
  if (errored === 0 && maxBlockTime > watermark) {
    try {
      await writeVoteWatermark(maxBlockTime);
    } catch (err) {
      console.warn('persistVoteEvents: watermark write failed (will retry next cycle):', err);
    }
  }

  return { written, skipped, errored, newWatermark: errored === 0 ? maxBlockTime : watermark };
}

// Re-export for tests / external introspection. The watermark key is
// considered an implementation detail.
export { persistVoteEvents as _persistVoteEvents };

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
