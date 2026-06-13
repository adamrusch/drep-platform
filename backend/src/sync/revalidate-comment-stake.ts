/**
 * Comment-vote stake re-validation sync (Batch REVAL, 2026-05-29).
 *
 * # The Sybil vector this defends against
 *
 * Public-comment voting is stake-weighted: each up/downvote snapshots
 * the voter wallet's stake (lovelace) at vote time onto the
 * `comment_votes` row, and the parent comment row carries a denormalized
 * `supportLovelace` sum (+ `upvoteCount`/`downvoteCount`). The Sybil
 * vector is:
 *
 *   1. Attacker votes from wallet A → snapshot 1M ₳ on the row.
 *   2. Attacker moves the ADA out of A into wallet B.
 *   3. Attacker votes from B → another 1M ₳ snapshot.
 *   4. The comment now shows 2M ₳ of support backed by 1M ₳ of real ADA.
 *
 * Repeatable indefinitely with cheap throwaway wallets.
 *
 * # The fix
 *
 * Every 3 hours, re-check each voting wallet's CURRENT stake via Koios
 * `account_info_cached.total_balance` and re-weight its votes to the
 * current stake. When A's ADA has moved out, A's votes re-weight down
 * to ~0 (or whatever residual A still controls); B keeps its 1M ₳.
 * The double-count collapses to the true 1M ₳.
 *
 * The owner explicitly WANTS this "weight tracks current stake"
 * semantic — sentiment = current conviction; it erodes if ADA is
 * spent. So re-weighting downward is intended, not a bug.
 *
 * # CRITICAL correctness guard: never zero on lookup failure
 *
 * If Koios is down or returns no row for a wallet, we have NO IDEA what
 * that wallet's current stake is. Silently zeroing the votes on that
 * assumption would let a Koios outage wipe legitimate support level —
 * which is worse than the Sybil vector this whole feature is trying to
 * prevent. The sweep ONLY re-weights when it has a CONFIRMED reading
 * (`KoiosAccountInfo` row with a valid `total_balance` string). Any
 * other outcome (Koios threw, missing row in batch response,
 * unparseable `total_balance`) skips the wallet for this pass; the
 * next 3-hour cycle retries.
 *
 * Locked in by an explicit test in
 * `backend/src/sync/revalidate-comment-stake.test.ts` —
 * `"never zeros a wallet's votes when the Koios lookup failed"`.
 *
 * # Re-weight math
 *
 * For each wallet whose `lastKnownStake !== currentStake`:
 *
 *   For each vote row this wallet owns:
 *     oldRowSnapshot   = vote.lovelace          (BigInt, stringified)
 *     newRowSnapshot   = currentStake           (BigInt, from Koios)
 *     signedOldContrib = vote === 'up' ?  oldRowSnapshot : -oldRowSnapshot
 *     signedNewContrib = vote === 'up' ?  newRowSnapshot : -newRowSnapshot
 *     supportDelta     = signedNewContrib - signedOldContrib
 *     // Apply atomically: ADD supportLovelace :supportDelta on the
 *     // comment row + SET lovelace = :new on the vote row.
 *
 * The `ADD :supportDelta` reuses the same DDB `N` BigInt marshalling as
 * the live vote handler (`handlers/comments/vote.ts:357 buildCommentCounterUpdate`),
 * which is the path the 2026-05-28 P0-2 fix flipped from string-typed
 * to bigint-typed.
 *
 * After all votes are re-weighted, the registry row is updated with
 * the new `lastKnownStake` + a fresh `lastCheckedAt`. The whole sweep
 * is idempotent — a second invocation with no stake changes does
 * nothing.
 *
 * # Audit events
 *
 *   - One `comment_vote.reweighted` event per (wallet, comment) pair
 *     whose vote was actually adjusted. Metadata: prior/new stake,
 *     delta, voteCount touched.
 *   - One `comment_vote.reweighted_emptied` event when a wallet's
 *     current stake reads as 0 (i.e. the Sybil signature — wallet
 *     drained between sweeps). Lets an incident-responder grep for
 *     the pattern.
 *   - One `comment_vote.revalidate_pass` summary event at end of run
 *     with totals (wallets checked / changed / re-weight delta sum).
 *
 * All best-effort — audit failures never block the re-weight write.
 *
 * # Schedule
 *
 * EventBridge `rate(3 hours)`. Three hours is the locked product
 * decision: longer windows give Sybils more time to land an inflated
 * vote on a tight governance action; shorter windows pay more for
 * Koios round-trips without materially more protection (a deliberate
 * Sybil who knows the cadence will time the move-and-revote to
 * straddle the window regardless).
 *
 * # Cost ceiling
 *
 * At steady state on mainnet — ~10k voters, ~3h cadence — the cycle
 * issues ~100 Koios batch calls (≤100 wallets/call) per pass, ~8x/day
 * = ~800 Koios calls/day. Within the Koios anonymous free tier.
 * DynamoDB writes are bounded by the changed-wallet count (typically
 * very small per cycle).
 */

import type { ScheduledEvent, Context } from 'aws-lambda';
import {
  fetchAccountInfoBatch,
  KoiosError,
  type KoiosAccountInfo,
} from '../lib/koios';
import {
  getItem,
  queryItems,
  scanItems,
  transactWrite,
  tableNames,
  updateItem,
  type QueryResult,
} from '../lib/dynamodb';
import type {
  CommentVoterItem,
  DRepCommitteeItem,
} from '../lib/types';
import { writeAuditEvent } from '../lib/audit';

/** Koios `account_info_cached` accepts up to 100 stake addresses per
 *  request (matching the documented PostgREST array-arg cap). We chunk
 *  the registry into batches of this size. */
const KOIOS_ACCOUNT_BATCH_SIZE = 100;

/** Slim row projected onto the `stakeAddress-commentId-index` GSI.
 *  Matches the `nonKeyAttributes` set in `database-stack.ts`. The
 *  index signature satisfies `queryItems<T extends Record<string,
 *  unknown>>` — the DDB doc-client returns rows as plain objects with
 *  string-keyed access. */
interface CommentVoteIndexRow {
  commentId: string;
  stakeAddress: string;
  vote: 'up' | 'down';
  lovelace: string;
  actionId: string;
  [key: string]: unknown;
}

export interface RevalidateCommentStakeResult {
  /** Total wallets enumerated from the registry. */
  walletsScanned: number;
  /** Wallets whose Koios reading was attempted (≤ `walletsScanned`
   *  if pagination short-circuited; usually equal). */
  walletsChecked: number;
  /** Wallets where the upstream lookup failed (Koios + Blockfrost
   *  combined; today we only consult Koios here). These wallets are
   *  SKIPPED — their votes are NOT touched. */
  walletsUpstreamFailures: number;
  /** Wallets whose `lastKnownStake` matched the live reading
   *  exactly — no re-weight needed. */
  walletsUnchanged: number;
  /** Wallets whose live stake differs and votes were re-weighted. */
  walletsReweighted: number;
  /** Subset of `walletsReweighted` where the live reading was zero — i.e.
   *  the Sybil signature ("the ADA moved out"). Counted distinctly so
   *  the audit summary surfaces it. */
  walletsEmptied: number;
  /** Per-vote re-weights actually issued. */
  votesReweighted: number;
  /** Sum of signed `supportLovelace` deltas this pass applied across
   *  every comment. Net "the platform's running comment-support total
   *  moved by X" — usually negative when a sweep collapses Sybil
   *  inflation. Stringified BigInt. Informational. */
  netSupportDelta: string;
  /** Per-comment write failures (any DDB error other than
   *  ConditionalCheckFailed). Logged + counted, not retried. */
  reweightErrors: number;
}

function emptyResult(): RevalidateCommentStakeResult {
  return {
    walletsScanned: 0,
    walletsChecked: 0,
    walletsUpstreamFailures: 0,
    walletsUnchanged: 0,
    walletsReweighted: 0,
    walletsEmptied: 0,
    votesReweighted: 0,
    netSupportDelta: '0',
    reweightErrors: 0,
  };
}

function safeBigInt(s: string | number | bigint | undefined | null): bigint {
  if (s === undefined || s === null || s === '') return 0n;
  if (typeof s === 'bigint') return s;
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}

/**
 * Compute the signed `supportLovelace` delta for re-weighting one vote.
 *
 * Pure function — exported for unit-testing the math without going
 * through the DDB mock. Returns the BigInt to ADD onto the parent
 * comment row's `supportLovelace`.
 *
 *   signedOld = vote === 'up' ?  oldSnapshot : -oldSnapshot
 *   signedNew = vote === 'up' ?  newStake    : -newStake
 *   return signedNew - signedOld
 *
 * Worked examples:
 *   - upvote, oldSnapshot=1M, newStake=2M  → +1M (more support)
 *   - upvote, oldSnapshot=1M, newStake=0   → -1M (vote zeroed)
 *   - downvote, oldSnapshot=1M, newStake=2M → -1M (more opposition)
 *   - downvote, oldSnapshot=1M, newStake=0  → +1M (opposition removed)
 *   - upvote, oldSnapshot=newStake          →  0  (no change; idempotent)
 */
export function computeSupportDelta(
  vote: 'up' | 'down',
  oldSnapshot: bigint,
  newStake: bigint,
): bigint {
  const signedOld = vote === 'up' ? oldSnapshot : -oldSnapshot;
  const signedNew = vote === 'up' ? newStake : -newStake;
  return signedNew - signedOld;
}

/**
 * Enumerate every wallet in the `comment_voters` registry.
 *
 * Defensive pagination: PAY_PER_REQUEST tables return up to 1MB per
 * Scan response. The registry is tiny today (~thousands of voters max)
 * so a single page typically covers it, but we loop on
 * `LastEvaluatedKey` so the sweep stays correct as the platform grows.
 */
export async function loadAllVoters(): Promise<CommentVoterItem[]> {
  const all: CommentVoterItem[] = [];
  let cursor: Record<string, unknown> | undefined;
  let pages = 0;
  do {
    pages += 1;
    const result = await scanItems<CommentVoterItem>(
      tableNames.commentVoters,
      cursor ? { exclusiveStartKey: cursor } : {},
    );
    all.push(...result.items);
    cursor = result.lastEvaluatedKey;
  } while (cursor);
  console.log(
    `revalidate-comment-stake: loaded ${all.length} voter(s) from registry in ${pages} page(s)`,
  );
  return all;
}

/**
 * Run the re-validation pass.
 *
 * Steps:
 *   1. Enumerate every wallet in `comment_voters`.
 *   2. For each batch of ≤100 wallets, call `fetchAccountInfoBatch`
 *      (Koios `account_info_cached`).
 *   3. For each wallet with a CONFIRMED reading whose `total_balance`
 *      differs from `lastKnownStake`:
 *        a. Query the `stakeAddress-commentId-index` GSI for every
 *           vote this wallet owns.
 *        b. For each vote, compute the signed `supportLovelace` delta
 *           and apply via `transactWrite` (counter ADD on the comment
 *           row + SET lovelace=newStake on the vote row).
 *        c. After all votes succeed, UpdateItem the registry row's
 *           `lastKnownStake` + `lastCheckedAt`.
 *   4. Wallets that didn't respond (Koios outage, missing from
 *      response, malformed `total_balance`) are SKIPPED — their votes
 *      are NOT touched. Counted under `walletsUpstreamFailures`.
 *   5. Best-effort audit events on per-vote re-weights and pass
 *      summary.
 */
export async function runRevalidateCommentStake(): Promise<RevalidateCommentStakeResult> {
  const result = emptyResult();
  let netSupportDelta = 0n;

  // ---- Step 1: enumerate registry ----
  let voters: CommentVoterItem[];
  try {
    voters = await loadAllVoters();
  } catch (err) {
    console.error('revalidate-comment-stake: registry scan failed:', err);
    return result;
  }
  result.walletsScanned = voters.length;

  // Short-circuit: nothing to do. Today's prod has zero voters, so this
  // is the typical exit path until the backfill runs / live voting
  // starts.
  if (voters.length === 0) {
    console.log('revalidate-comment-stake: registry is empty — nothing to do');
    await writePassSummary(result);
    return result;
  }

  // ---- Step 2: batched Koios lookups ----
  // For each batch, attempt the lookup. If the WHOLE BATCH throws, we
  // skip every wallet in that batch (counted as upstream failures).
  // The batch is the throw-or-succeed unit; per-wallet "missing from
  // response" is treated as upstream failure inside the batch loop.
  for (let i = 0; i < voters.length; i += KOIOS_ACCOUNT_BATCH_SIZE) {
    const batch = voters.slice(i, i + KOIOS_ACCOUNT_BATCH_SIZE);
    const addresses = batch.map((v) => v.stakeAddress);
    let accounts: KoiosAccountInfo[] = [];
    let batchFailed = false;
    try {
      accounts = await fetchAccountInfoBatch(addresses);
    } catch (err) {
      if (err instanceof KoiosError) {
        console.warn(
          `revalidate-comment-stake: Koios batch ${i}-${i + batch.length} failed: ${err.message}`,
        );
      } else {
        console.warn(
          `revalidate-comment-stake: Koios batch ${i}-${i + batch.length} threw unexpected error:`,
          err,
        );
      }
      batchFailed = true;
    }

    if (batchFailed) {
      // SKIP every wallet in this batch. Their votes are NOT touched.
      // This is the load-bearing correctness invariant — a Koios outage
      // must not wipe vote weight.
      result.walletsUpstreamFailures += batch.length;
      continue;
    }

    // Index the Koios response by stakeAddress. Wallets missing from
    // the response are treated as upstream failures (Koios sometimes
    // omits unregistered / never-staked addresses; we DO NOT know
    // their current stake, so we skip).
    const accountByAddress = new Map<string, KoiosAccountInfo>();
    for (const a of accounts) {
      if (typeof a.stake_address === 'string') {
        accountByAddress.set(a.stake_address, a);
      }
    }

    for (const voter of batch) {
      result.walletsChecked += 1;
      const account = accountByAddress.get(voter.stakeAddress);
      if (!account) {
        // Wallet missing from the Koios response. We do NOT know what
        // their current stake is — SKIP this pass.
        result.walletsUpstreamFailures += 1;
        continue;
      }
      // `total_balance` should be a non-empty stringified integer per
      // the Koios spec. Anything else means we couldn't read the value
      // — SKIP rather than synthesize a zero.
      if (typeof account.total_balance !== 'string' || account.total_balance.length === 0) {
        console.warn(
          `revalidate-comment-stake: malformed total_balance for ${voter.stakeAddress}; skipping`,
        );
        result.walletsUpstreamFailures += 1;
        continue;
      }
      let currentStake: bigint;
      try {
        currentStake = BigInt(account.total_balance);
      } catch {
        console.warn(
          `revalidate-comment-stake: unparseable total_balance "${account.total_balance}" for ${voter.stakeAddress}; skipping`,
        );
        result.walletsUpstreamFailures += 1;
        continue;
      }
      const lastKnown = safeBigInt(voter.lastKnownStake);
      if (currentStake === lastKnown) {
        // Cheap-skip: stake unchanged, no re-weight needed. We
        // intentionally do NOT bump `lastCheckedAt` here — keeping it
        // unchanged on no-op cycles makes "when did this wallet's
        // stake last actually move?" recoverable from the registry
        // alone. The next vote-write will overwrite it.
        result.walletsUnchanged += 1;
        continue;
      }

      // ---- Step 3: this wallet changed; re-weight every vote ----
      const reweightOutcome = await reweightWalletVotes(
        voter.stakeAddress,
        currentStake,
      );
      result.votesReweighted += reweightOutcome.votesReweighted;
      result.reweightErrors += reweightOutcome.errors;
      netSupportDelta += reweightOutcome.netDelta;
      if (reweightOutcome.votesReweighted > 0) {
        result.walletsReweighted += 1;
        if (currentStake === 0n) {
          result.walletsEmptied += 1;
          // Distinct audit event when a wallet that previously voted is
          // found at zero stake — the Sybil signature.
          await writeAuditEvent({
            entityType: 'comment_vote',
            entityId: voter.stakeAddress,
            eventType: 'comment_vote.reweighted_emptied',
            actorWallet: '_revalidate-sweep',
            metadata: {
              priorStake: voter.lastKnownStake,
              currentStake: '0',
              votesAffected: reweightOutcome.votesReweighted,
            },
          });
        }
      }

      // ---- Step 3c: bump registry's last-known stake + lastCheckedAt ----
      // Only flip the registry forward AFTER the re-weight succeeded
      // (even partially — if some votes errored, we still bump because
      // the per-vote rows that DID succeed now carry the new snapshot,
      // and we don't want the sweep to re-attempt them next cycle as
      // if they hadn't changed). Failed votes are surfaced via
      // `reweightErrors`; an operator can investigate and the next
      // sweep will pick them up against the new baseline.
      try {
        await updateItem(
          tableNames.commentVoters,
          { stakeAddress: voter.stakeAddress },
          'SET #lastKnownStake = :s, #lastCheckedAt = :now',
          {
            '#lastKnownStake': 'lastKnownStake',
            '#lastCheckedAt': 'lastCheckedAt',
          },
          {
            ':s': currentStake.toString(),
            ':now': new Date().toISOString(),
          },
        );
      } catch (err) {
        console.error(
          `revalidate-comment-stake: registry update failed for ${voter.stakeAddress}:`,
          err,
        );
      }
    }
  }

  result.netSupportDelta = netSupportDelta.toString();
  // ---- Step 5: per-pass audit summary ----
  await writePassSummary(result);

  console.log(
    `revalidate-comment-stake: pass complete — ` +
      `scanned=${result.walletsScanned} checked=${result.walletsChecked} ` +
      `unchanged=${result.walletsUnchanged} reweighted=${result.walletsReweighted} ` +
      `emptied=${result.walletsEmptied} upstreamFailures=${result.walletsUpstreamFailures} ` +
      `votes=${result.votesReweighted} netDelta=${result.netSupportDelta} ` +
      `errors=${result.reweightErrors}`,
  );
  return result;
}

interface ReweightOutcome {
  votesReweighted: number;
  errors: number;
  netDelta: bigint;
}

/**
 * Re-weight every vote belonging to one wallet to the given `currentStake`.
 *
 * Uses the `stakeAddress-commentId-index` GSI to enumerate the wallet's
 * votes in a single-partition Query (paginated defensively). For each
 * vote whose snapshot differs from `currentStake`, issues a
 * `transactWrite` with two items:
 *
 *   - Update on `comments`: `ADD #supportLovelace :delta` where
 *     `:delta` is the signed BigInt computed by `computeSupportDelta`.
 *   - Update on `comment_votes`: `SET lovelace = :s` overwriting the
 *     snapshot with the current stake (as stringified BigInt).
 *
 * The two are NOT a true cross-row-atomic mutation (DDB can't atomically
 * update two rows on different tables outside transactWrite) — we use
 * `transactWrite` so they land together. If the comment row was
 * deleted in the meantime, the Update on `comments` fails with a
 * conditional-check error and the per-vote re-weight is skipped
 * (idempotent on next pass).
 */
async function reweightWalletVotes(
  stakeAddress: string,
  currentStake: bigint,
): Promise<ReweightOutcome> {
  const outcome: ReweightOutcome = { votesReweighted: 0, errors: 0, netDelta: 0n };

  // Query the GSI for this wallet's votes. Paginated — a single voter
  // unlikely to have >1MB of votes today, but defensively loop.
  let cursor: Record<string, unknown> | undefined;
  do {
    let queryResult: QueryResult<CommentVoteIndexRow>;
    try {
      queryResult = await queryItems<CommentVoteIndexRow>(
        tableNames.commentVotes,
        {
          indexName: 'stakeAddress-commentId-index',
          keyConditionExpression: '#sk = :s',
          expressionAttributeNames: { '#sk': 'stakeAddress' },
          expressionAttributeValues: { ':s': stakeAddress },
          ...(cursor ? { exclusiveStartKey: cursor } : {}),
        },
      );
    } catch (err) {
      console.error(
        `revalidate-comment-stake: GSI query failed for ${stakeAddress}:`,
        err,
      );
      outcome.errors += 1;
      return outcome;
    }

    for (const row of queryResult.items) {
      if (row.vote !== 'up' && row.vote !== 'down') {
        // Defensive: skip rows with an unrecognized vote direction.
        console.warn(
          `revalidate-comment-stake: skipping vote with bad direction "${row.vote}" for ${stakeAddress}#${row.commentId}`,
        );
        continue;
      }
      const oldSnapshot = safeBigInt(row.lovelace);
      const delta = computeSupportDelta(row.vote, oldSnapshot, currentStake);
      if (delta === 0n) {
        // Same value — the registry says "changed" but this individual
        // vote row's snapshot already matches the current stake.
        // Possible after a partial re-weight from a prior pass. No
        // mutation needed; treat as already-reweighted.
        continue;
      }

      const newStakeStr = currentStake.toString();
      try {
        await transactWrite([
          {
            Update: {
              TableName: tableNames.comments,
              Key: { actionId: row.actionId, commentId: row.commentId },
              UpdateExpression:
                'ADD #supportLov :delta SET #updatedAt = :now',
              ExpressionAttributeNames: {
                '#supportLov': 'supportLovelace',
                '#updatedAt': 'updatedAt',
              },
              ExpressionAttributeValues: {
                // Pass the raw bigint — the doc-client marshaller emits
                // a real DDB `N` with full precision. Same convention as
                // the live vote handler's `buildCommentCounterUpdate`
                // (post 2026-05-28 P0-2 fix).
                ':delta': delta,
                ':now': new Date().toISOString(),
              },
            },
          },
          {
            Update: {
              TableName: tableNames.commentVotes,
              Key: { commentId: row.commentId, stakeAddress },
              UpdateExpression:
                'SET #lov = :s',
              ExpressionAttributeNames: { '#lov': 'lovelace' },
              ExpressionAttributeValues: { ':s': newStakeStr },
            },
          },
        ]);
        outcome.votesReweighted += 1;
        outcome.netDelta += delta;
        // Best-effort audit per re-weight. Minimal metadata: who, where,
        // what changed. NO comment body.
        await writeAuditEvent({
          entityType: 'comment_vote',
          entityId: row.commentId,
          eventType: 'comment_vote.reweighted',
          actorWallet: '_revalidate-sweep',
          metadata: {
            stakeAddress,
            actionId: row.actionId,
            vote: row.vote,
            priorSnapshot: row.lovelace,
            currentStake: newStakeStr,
            supportDelta: delta.toString(),
          },
        });
      } catch (err) {
        // Common case: the comment row was deleted between the GSI
        // query and the transactWrite. The condition implicit in
        // `ADD` against a non-existent item differs by DDB version,
        // but in practice the transact fails — count as an error and
        // continue. Next sweep will see no vote row (because the GSI
        // also won't list it once the orphan is cleaned up) and skip.
        console.error(
          `revalidate-comment-stake: re-weight failed actionId=${row.actionId} commentId=${row.commentId} stakeAddress=${stakeAddress}:`,
          err,
        );
        outcome.errors += 1;
      }
    }
    cursor = queryResult.lastEvaluatedKey;
  } while (cursor);

  return outcome;
}

/**
 * Best-effort pass-summary audit event. Fires once per sweep,
 * regardless of outcome (including the no-work empty-registry case).
 * Lets an incident-responder reconstruct "did the sweep run at all
 * over the last 7 days, and what did it touch?"
 */
async function writePassSummary(result: RevalidateCommentStakeResult): Promise<void> {
  await writeAuditEvent({
    entityType: 'system',
    entityId: 'revalidate-comment-stake',
    eventType: 'comment_vote.revalidate_pass',
    actorWallet: '_revalidate-sweep',
    metadata: {
      walletsScanned: result.walletsScanned,
      walletsChecked: result.walletsChecked,
      walletsUpstreamFailures: result.walletsUpstreamFailures,
      walletsUnchanged: result.walletsUnchanged,
      walletsReweighted: result.walletsReweighted,
      walletsEmptied: result.walletsEmptied,
      votesReweighted: result.votesReweighted,
      netSupportDelta: result.netSupportDelta,
      reweightErrors: result.reweightErrors,
    },
  });
}

// ============================================================
// Batch CLUBHOUSE-DELEGATION-GATE (2026-05-30)
// Phase 2: revoke poll votes + badge comments for un-delegated wallets.
// ============================================================
//
// # The gap this phase closes
//
// The clubhouse is delegator-scoped. The cast-time membership gate
// (`createPost.ts` / `createComment.ts` / `votePoll.ts` — the last
// added in this same batch) blocks NEW writes from wallets that aren't
// currently delegated. But nothing reaches BACK to participation that
// landed BEFORE the wallet un-delegated:
//
//   - Polls: the wallet's vote stays in `pollVotes`, still counted in
//     the option tally. Looks like an active delegator's voice.
//   - Comments: the wallet's `clubhouse_comments` rows stay visible
//     verbatim — no signal that the author no longer participates in
//     this DRep's clubhouse.
//
// # What this sweep does
//
// Every 3 hours (same cadence + same Lambda as the stake-reweight phase
// above), enumerate every wallet that's currently participating in any
// clubhouse, batch-look-up their current `delegated_drep` via Koios,
// and for each wallet whose CONFIRMED delegation has moved away from
// that clubhouse's DRep (and who isn't a committee role-holder):
//
//   - Revoke their poll votes — atomic
//     `REMOVE pollVotes.#wallet ADD pollOptions[idx].votes :negOne`
//     on each affected post. Idempotent: already-removed = no-op.
//   - Badge their comments — set
//     `authorDelegationActive: false` on each `clubhouse_comments` row.
//     The frontend renders a subtle "no longer delegated" badge; the
//     comment stays visible (flag, not hide — per owner decision).
//
// Re-activation: a previously-badged wallet found delegated again has
// the badge CLEARED (`authorDelegationActive` set back to true). Keeps
// the system self-healing without a separate "unbadge" sweep.
//
// # CRITICAL guard (same as the stake-reweight phase above)
//
// **NEVER revoke or badge on an upstream-read failure or a missing
// account row.** Only act on a CONFIRMED `delegated_drep` reading that
// mismatches. A Koios outage MUST NOT strip everyone's clubhouse
// participation — that's worse than the gap this sweep is trying to
// close. Confirmation comes from a non-throwing batch + a present row
// in the response (Koios omits unregistered/never-staked addresses;
// those count as upstream failures, not as "confirmed undelegated").
//
// Locked in by `revalidate-comment-stake.test.ts` —
// `"clubhouse sweep: SKIPS revoke/badge on Koios batch failure"` and
// `"clubhouse sweep: SKIPS revoke/badge on missing-from-response"`.
//
// # Enumeration strategy
//
// Two populations need enumeration:
//   (a) poll voters — keys of `pollVotes` maps on every poll-typed
//       row in `clubhouse_posts`.
//   (b) comment authors — `authorWallet` on every `clubhouse_comments`
//       row.
//
// At today's scale (~7,360 posts, ~0 comments) a Scan over each table
// projects only the columns we need (drepId + postId + pollVotes for
// posts; postKey + commentId + drepId + authorWallet for comments) and
// completes in a single sub-second pass per table. We add NO GSI — at
// this scale the per-Scan RCU cost is pennies/cycle. Documented as a
// scale-watch comment so a future operator knows when to revisit.
//
// # Audit
//
//   - One `clubhouse.poll.revoked` event per (wallet, post) pair whose
//     vote was actually removed (metadata: drepId, postId, optionIndex,
//     priorDelegatedTo).
//   - One `clubhouse.comment.badged` event per (wallet, comment) pair
//     whose `authorDelegationActive` flipped to false.
//   - One `clubhouse.comment.unbadged` event per pair flipped BACK to
//     true.
//   - One per-pass `clubhouse.delegation_sweep_pass` summary at end.
//
// All best-effort — audit failures never block the underlying revoke /
// badge write.

/** Slim projection used by the clubhouse-posts Scan in the sweep. We
 *  only need `drepId` + `postId` (for the targeted UpdateItem keys) +
 *  `pollVotes` + `pollOptions` (to know which option to decrement for
 *  each revoked vote). Type / authorWallet are NOT needed — the sweep
 *  acts on poll-type posts (filtered post-projection by presence of
 *  `pollVotes`). */
interface PollPostSlim {
  drepId: string;
  postId: string;
  pollVotes?: Record<string, number>;
  /** Present only on poll-typed posts. We use it for length-bounds
   *  defense on the option index we read from `pollVotes`. */
  pollOptions?: Array<{ id: string; label: string; votes: number }>;
  [key: string]: unknown;
}

/** Slim projection used by the clubhouse-comments Scan. */
interface ClubhouseCommentSlim {
  postKey: string;
  commentId: string;
  drepId: string;
  authorWallet: string;
  authorDelegationActive?: boolean;
  [key: string]: unknown;
}

/** Per-(wallet, drepId) participation record. One wallet can participate
 *  in multiple DReps' clubhouses; we lift the (wallet, drepId) pair as
 *  the per-record key so each delegation check applies to the right
 *  scope. */
interface ParticipantRecord {
  walletAddress: string;
  drepId: string;
  /** Poll votes this wallet has cast in THIS DRep's clubhouse. */
  pollVotes: Array<{ postId: string; optionIndex: number }>;
  /** Comment rows authored by this wallet in THIS DRep's clubhouse. */
  comments: Array<{ postKey: string; commentId: string; currentBadgeActive: boolean | undefined }>;
}

export interface RevalidateClubhouseDelegationResult {
  /** Distinct (wallet, drepId) participation pairs enumerated this pass. */
  participantsScanned: number;
  /** Distinct wallets enumerated (a single wallet can participate in
   *  multiple DReps' clubhouses; this counts wallets, not pairs). */
  walletsChecked: number;
  /** Wallets where the upstream lookup failed (Koios batch threw, or the
   *  wallet was missing from the response). SKIPPED — no revoke / badge
   *  applied. Counted distinct-wallet. */
  walletsUpstreamFailures: number;
  /** Wallets whose CONFIRMED `delegated_drep` matched every clubhouse
   *  they participate in — nothing to do for them. */
  walletsAllAligned: number;
  /** (wallet, drepId) pairs where confirmed delegation MISMATCHES and the
   *  wallet is NOT a role-holder of THAT drep — these are the records the
   *  sweep acted on. */
  mismatchedRecords: number;
  /** Poll votes successfully revoked. */
  pollVotesRevoked: number;
  /** Clubhouse comments newly badged `authorDelegationActive: false`. */
  commentsBadged: number;
  /** Clubhouse comments newly UN-badged (flipped back to active) —
   *  re-activation when a previously-mismatched wallet is found
   *  delegated again. */
  commentsUnbadged: number;
  /** Per-write failures (any DDB error other than the expected idempotent
   *  CCFE on already-revoked poll votes). Logged + counted, not retried. */
  writeErrors: number;
}

function emptyClubhouseResult(): RevalidateClubhouseDelegationResult {
  return {
    participantsScanned: 0,
    walletsChecked: 0,
    walletsUpstreamFailures: 0,
    walletsAllAligned: 0,
    mismatchedRecords: 0,
    pollVotesRevoked: 0,
    commentsBadged: 0,
    commentsUnbadged: 0,
    writeErrors: 0,
  };
}

/**
 * Enumerate every poll-vote / comment-author participation in every
 * clubhouse. Returns one `ParticipantRecord` per distinct (wallet, drepId)
 * pair — even a single wallet that participates in three different
 * DReps' clubhouses gets three records, each scoped to one drepId so
 * the delegation check applies to the right target.
 *
 * # Why a Scan (not a GSI) at current scale
 *
 * Two tables in play:
 *   - `clubhouse_posts`: ~7,360 rows steady-state. We need a one-shot
 *     pass to harvest every `pollVotes` map. A Scan projects only
 *     `drepId + postId + pollVotes + pollOptions` and runs sub-second.
 *   - `clubhouse_comments`: ~0 rows in prod today. Trivial.
 * Steady-state growth tracks the platform's active-clubhouse count.
 * When this exceeds the ~100k row tier a Scan-per-3h becomes notable
 * cost, we revisit. Until then a GSI introduces write amplification
 * (every comment write costs +1 GSI write) for no read benefit.
 *
 * # Defensive filtering
 *
 *   - posts: only rows whose `pollVotes` has at least one entry contribute.
 *   - comments: every row's `authorWallet` contributes.
 *   - non-stake addresses (`addr1...` payment-address fallbacks from
 *     `useWalletAuth`) are SKIPPED — Koios `account_info_cached` only
 *     accepts stake addresses, so we cannot resolve their delegation
 *     anyway. Logged so an operator can investigate if the count is
 *     non-zero on a future cycle.
 */
export async function enumerateClubhouseParticipants(): Promise<{
  participants: ParticipantRecord[];
  skippedNonStakeAddresses: number;
}> {
  // (drepId|wallet) → record map for accumulation.
  const byKey = new Map<string, ParticipantRecord>();
  let skippedNonStakeAddresses = 0;

  function getOrCreate(walletAddress: string, drepId: string): ParticipantRecord {
    const k = `${drepId}|${walletAddress}`;
    let rec = byKey.get(k);
    if (!rec) {
      rec = { walletAddress, drepId, pollVotes: [], comments: [] };
      byKey.set(k, rec);
    }
    return rec;
  }

  // ---- Pass 1: clubhouse_posts → poll voters ----
  // Project only the columns we need. The Scan iterates the full table
  // (PAY_PER_REQUEST tables bill on bytes returned, not on full row
  // size, so projection materially reduces cost).
  let cursor: Record<string, unknown> | undefined;
  let pages = 0;
  do {
    pages += 1;
    const postsPage = await scanItems<PollPostSlim>(tableNames.clubhousePosts, {
      projectionExpression: '#d, #p, #pv, #po',
      expressionAttributeNames: {
        '#d': 'drepId',
        '#p': 'postId',
        '#pv': 'pollVotes',
        '#po': 'pollOptions',
      },
      ...(cursor ? { exclusiveStartKey: cursor } : {}),
    });
    for (const row of postsPage.items) {
      if (!row.pollVotes) continue;
      const optionCount = row.pollOptions?.length ?? 0;
      for (const [wallet, optionIdx] of Object.entries(row.pollVotes)) {
        if (typeof optionIdx !== 'number' || !Number.isInteger(optionIdx)) {
          // Defensive: bad data — skip.
          continue;
        }
        if (optionCount > 0 && (optionIdx < 0 || optionIdx >= optionCount)) {
          // Defensive: option-index out of range vs the current
          // pollOptions list. Skip rather than risk corrupting the
          // tally with an invalid `pollOptions[idx]` decrement.
          continue;
        }
        if (!wallet.startsWith('stake')) {
          skippedNonStakeAddresses += 1;
          continue;
        }
        getOrCreate(wallet, row.drepId).pollVotes.push({
          postId: row.postId,
          optionIndex: optionIdx,
        });
      }
    }
    cursor = postsPage.lastEvaluatedKey;
  } while (cursor);
  console.log(
    `revalidate-clubhouse-delegations: scanned clubhouse_posts in ${pages} page(s)`,
  );

  // ---- Pass 2: clubhouse_comments → comment authors ----
  cursor = undefined;
  pages = 0;
  do {
    pages += 1;
    const commentsPage: QueryResult<ClubhouseCommentSlim> = await scanItems<ClubhouseCommentSlim>(
      tableNames.clubhouseComments,
      {
        projectionExpression: '#pk, #cid, #d, #aw, #ada',
        expressionAttributeNames: {
          '#pk': 'postKey',
          '#cid': 'commentId',
          '#d': 'drepId',
          '#aw': 'authorWallet',
          '#ada': 'authorDelegationActive',
        },
        ...(cursor ? { exclusiveStartKey: cursor } : {}),
      },
    );
    for (const row of commentsPage.items) {
      if (!row.authorWallet) continue;
      if (!row.authorWallet.startsWith('stake')) {
        skippedNonStakeAddresses += 1;
        continue;
      }
      getOrCreate(row.authorWallet, row.drepId).comments.push({
        postKey: row.postKey,
        commentId: row.commentId,
        currentBadgeActive: row.authorDelegationActive,
      });
    }
    cursor = commentsPage.lastEvaluatedKey;
  } while (cursor);
  console.log(
    `revalidate-clubhouse-delegations: scanned clubhouse_comments in ${pages} page(s)`,
  );

  return {
    participants: Array.from(byKey.values()),
    skippedNonStakeAddresses,
  };
}

/**
 * Check whether `walletAddress` is a committee role-holder for `drepId`.
 * Single local DDB Get on `drep_committees` — no upstream dependency,
 * cached per-pass via the calling context.
 *
 * Returns `false` on a Get failure (defensive — same posture as
 * `_membership.ts`: a committee-Get failure should NOT promote a caller
 * to role-holder).
 */
async function isCommitteeRoleHolder(
  walletAddress: string,
  drepId: string,
): Promise<boolean> {
  let committee: DRepCommitteeItem | undefined;
  try {
    committee = await getItem<DRepCommitteeItem>(tableNames.drepCommittees, {
      drepId,
      SK: 'COMMITTEE',
    });
  } catch (err) {
    console.warn(
      `revalidate-clubhouse-delegations: committee Get failed for ${drepId}:`,
      err,
    );
    return false;
  }
  if (!committee) return false;
  if (committee.leadWallet === walletAddress) return true;
  if (Array.isArray(committee.members)) {
    return committee.members.some((m) => m.walletAddress === walletAddress);
  }
  return false;
}

/**
 * Revoke a single poll vote atomically. Idempotent: if a concurrent
 * write has already removed the entry (e.g. the wallet logged in and
 * un-voted manually), the conditional `pollVotes.#wallet = :prev` guard
 * fails with CCFE — we swallow the CCFE and treat the revoke as
 * already-done.
 *
 * # Expression structure (mirrors `votePoll.ts` atomic-write pattern)
 *
 *   REMOVE pollVotes.<wallet>
 *   ADD pollOptions[idx].votes :negOne
 *
 * Guard: `attribute_exists(postId) AND pollVotes.<wallet> = :prev`. If
 * the post was deleted between our Scan and this UpdateItem, the
 * `attribute_exists(postId)` half fails; we count as a write error and
 * continue (the next pass won't see the orphan because the post is gone).
 */
async function revokePollVote(opts: {
  drepId: string;
  postId: string;
  walletAddress: string;
  optionIndex: number;
}): Promise<{ revoked: boolean; idempotentNoOp: boolean }> {
  const names: Record<string, string> = {
    '#pv': 'pollVotes',
    '#wallet': opts.walletAddress,
    '#po': 'pollOptions',
    '#v': 'votes',
    '#pk': 'postId',
    '#u': 'updatedAt',
  };
  const values: Record<string, unknown> = {
    ':prev': opts.optionIndex,
    ':negOne': -1,
    ':now': new Date().toISOString(),
  };
  try {
    await updateItem(
      tableNames.clubhousePosts,
      { drepId: opts.drepId, postId: opts.postId },
      `REMOVE #pv.#wallet SET #u = :now ADD #po[${opts.optionIndex}].#v :negOne`,
      names,
      values,
      'attribute_exists(#pk) AND #pv.#wallet = :prev',
    );
    return { revoked: true, idempotentNoOp: false };
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      (err as { name?: string }).name === 'ConditionalCheckFailedException'
    ) {
      // Already revoked OR post deleted — either way, nothing for us
      // to do. Idempotent no-op.
      return { revoked: false, idempotentNoOp: true };
    }
    throw err;
  }
}

/**
 * Set `authorDelegationActive` on a comment row to the given boolean.
 * No guard — idempotent re-runs just re-write the same value. Best-effort
 * — failures bubble up to the caller's error counter.
 */
async function setCommentDelegationActive(opts: {
  postKey: string;
  commentId: string;
  active: boolean;
}): Promise<void> {
  await updateItem(
    tableNames.clubhouseComments,
    { postKey: opts.postKey, commentId: opts.commentId },
    'SET #ada = :v',
    { '#ada': 'authorDelegationActive' },
    { ':v': opts.active },
  );
}

/**
 * Run the clubhouse delegation re-validation pass.
 *
 * Order of operations:
 *   1. Enumerate every (wallet, drepId) clubhouse participation pair.
 *   2. Group by wallet so one Koios batch call per ≤100 wallets covers
 *      every clubhouse they're in.
 *   3. For each wallet with a CONFIRMED reading:
 *        - For each (wallet, drepId) pair where the wallet's confirmed
 *          `delegated_drep` !== drepId AND the wallet is not a role-
 *          holder of THAT drepId: revoke each pollVote + badge each
 *          comment in that scope.
 *        - For each pair where delegation IS aligned: clear the badge
 *          on any comment currently carrying `authorDelegationActive=
 *          false` (re-activation).
 *   4. Wallets that didn't respond (batch threw, missing from response)
 *      are SKIPPED across ALL clubhouses they're in — their participation
 *      is NOT touched. Counted under `walletsUpstreamFailures`.
 */
export async function runRevalidateClubhouseDelegations(): Promise<RevalidateClubhouseDelegationResult> {
  const result = emptyClubhouseResult();

  // ---- Step 1: enumerate ----
  let participants: ParticipantRecord[];
  let skippedNonStakeAddresses: number;
  try {
    const enumeration = await enumerateClubhouseParticipants();
    participants = enumeration.participants;
    skippedNonStakeAddresses = enumeration.skippedNonStakeAddresses;
  } catch (err) {
    console.error('revalidate-clubhouse-delegations: enumeration failed:', err);
    await writeClubhousePassSummary(result);
    return result;
  }
  result.participantsScanned = participants.length;
  if (skippedNonStakeAddresses > 0) {
    console.warn(
      `revalidate-clubhouse-delegations: skipped ${skippedNonStakeAddresses} non-stake address(es) (Koios can't resolve delegation for these)`,
    );
  }

  if (participants.length === 0) {
    console.log(
      'revalidate-clubhouse-delegations: nothing to do (no clubhouse participation)',
    );
    await writeClubhousePassSummary(result);
    return result;
  }

  // ---- Step 2: group by wallet for batch lookups ----
  const byWallet = new Map<string, ParticipantRecord[]>();
  for (const p of participants) {
    let arr = byWallet.get(p.walletAddress);
    if (!arr) {
      arr = [];
      byWallet.set(p.walletAddress, arr);
    }
    arr.push(p);
  }
  const wallets = Array.from(byWallet.keys());
  result.walletsChecked = wallets.length;

  // ---- Step 3: batched Koios lookups ----
  for (let i = 0; i < wallets.length; i += KOIOS_ACCOUNT_BATCH_SIZE) {
    const batchWallets = wallets.slice(i, i + KOIOS_ACCOUNT_BATCH_SIZE);
    let accounts: KoiosAccountInfo[] = [];
    let batchFailed = false;
    try {
      accounts = await fetchAccountInfoBatch(batchWallets);
    } catch (err) {
      if (err instanceof KoiosError) {
        console.warn(
          `revalidate-clubhouse-delegations: Koios batch ${i}-${i + batchWallets.length} failed: ${err.message}`,
        );
      } else {
        console.warn(
          `revalidate-clubhouse-delegations: Koios batch ${i}-${i + batchWallets.length} threw unexpected error:`,
          err,
        );
      }
      batchFailed = true;
    }

    if (batchFailed) {
      // SKIP every wallet in this batch across every clubhouse they're
      // in. This is the load-bearing correctness invariant — a Koios
      // outage MUST NOT strip clubhouse participation.
      result.walletsUpstreamFailures += batchWallets.length;
      continue;
    }

    const accountByAddress = new Map<string, KoiosAccountInfo>();
    for (const a of accounts) {
      if (typeof a.stake_address === 'string') {
        accountByAddress.set(a.stake_address, a);
      }
    }

    for (const wallet of batchWallets) {
      const account = accountByAddress.get(wallet);
      if (!account) {
        // Missing from response — we do NOT know this wallet's current
        // delegation. SKIP across every clubhouse they're in.
        result.walletsUpstreamFailures += 1;
        continue;
      }
      const currentDrep = account.delegated_drep; // string|null per Koios spec

      // For each (wallet, drepId) pair this wallet has, decide aligned
      // vs mismatch vs role-holder-bypass.
      const records = byWallet.get(wallet) ?? [];
      let allAlignedForThisWallet = true;
      for (const rec of records) {
        const aligned = currentDrep === rec.drepId;
        if (aligned) {
          // RE-ACTIVATION: this wallet is currently delegated to THIS
          // DRep. Clear any stale `authorDelegationActive=false` badge
          // on their comments. (Poll votes are not badged — they were
          // either revoked or still present; re-vote needs the user to
          // cast actively, so we don't auto-restore revoked votes.)
          for (const c of rec.comments) {
            if (c.currentBadgeActive === false) {
              try {
                await setCommentDelegationActive({
                  postKey: c.postKey,
                  commentId: c.commentId,
                  active: true,
                });
                result.commentsUnbadged += 1;
                await writeAuditEvent({
                  entityType: 'clubhouse_comment',
                  entityId: c.commentId,
                  eventType: 'clubhouse.comment.unbadged',
                  actorWallet: '_revalidate-clubhouse-sweep',
                  metadata: {
                    drepId: rec.drepId,
                    walletAddress: wallet,
                    reason: 'delegation_re_aligned',
                  },
                });
              } catch (err) {
                console.error(
                  `revalidate-clubhouse-delegations: unbadge failed postKey=${c.postKey} commentId=${c.commentId}:`,
                  err,
                );
                result.writeErrors += 1;
              }
            }
          }
          continue;
        }
        // Misaligned. Before acting, check role-holder bypass — the
        // committee Get is a local DDB read with no upstream dependency,
        // so role-holders are protected even during outage cycles
        // (though we're past the upstream-fail skip by this point).
        const isRoleHolder = await isCommitteeRoleHolder(wallet, rec.drepId);
        if (isRoleHolder) {
          // Bypass — role-holders ALWAYS retain access to clubhouses
          // they manage, irrespective of delegation drift.
          continue;
        }
        // Confirmed mismatch + not a role-holder → act.
        allAlignedForThisWallet = false;
        result.mismatchedRecords += 1;

        // ---- Revoke poll votes ----
        for (const pv of rec.pollVotes) {
          try {
            const outcome = await revokePollVote({
              drepId: rec.drepId,
              postId: pv.postId,
              walletAddress: wallet,
              optionIndex: pv.optionIndex,
            });
            if (outcome.revoked) {
              result.pollVotesRevoked += 1;
              await writeAuditEvent({
                entityType: 'clubhouse_post',
                entityId: pv.postId,
                eventType: 'clubhouse.poll.revoked',
                actorWallet: '_revalidate-clubhouse-sweep',
                metadata: {
                  drepId: rec.drepId,
                  walletAddress: wallet,
                  optionIndex: pv.optionIndex,
                  currentDelegatedTo: currentDrep,
                },
              });
            }
          } catch (err) {
            console.error(
              `revalidate-clubhouse-delegations: revokePollVote failed drepId=${rec.drepId} postId=${pv.postId} wallet=${wallet}:`,
              err,
            );
            result.writeErrors += 1;
          }
        }

        // ---- Badge comments ----
        for (const c of rec.comments) {
          // Idempotent: skip if already badged.
          if (c.currentBadgeActive === false) continue;
          try {
            await setCommentDelegationActive({
              postKey: c.postKey,
              commentId: c.commentId,
              active: false,
            });
            result.commentsBadged += 1;
            await writeAuditEvent({
              entityType: 'clubhouse_comment',
              entityId: c.commentId,
              eventType: 'clubhouse.comment.badged',
              actorWallet: '_revalidate-clubhouse-sweep',
              metadata: {
                drepId: rec.drepId,
                walletAddress: wallet,
                currentDelegatedTo: currentDrep,
              },
            });
          } catch (err) {
            console.error(
              `revalidate-clubhouse-delegations: badge failed postKey=${c.postKey} commentId=${c.commentId}:`,
              err,
            );
            result.writeErrors += 1;
          }
        }
      }
      if (allAlignedForThisWallet) {
        result.walletsAllAligned += 1;
      }
    }
  }

  await writeClubhousePassSummary(result);

  console.log(
    `revalidate-clubhouse-delegations: pass complete — ` +
      `participants=${result.participantsScanned} wallets=${result.walletsChecked} ` +
      `aligned=${result.walletsAllAligned} mismatched=${result.mismatchedRecords} ` +
      `upstreamFailures=${result.walletsUpstreamFailures} ` +
      `revoked=${result.pollVotesRevoked} badged=${result.commentsBadged} ` +
      `unbadged=${result.commentsUnbadged} errors=${result.writeErrors}`,
  );
  return result;
}

async function writeClubhousePassSummary(
  result: RevalidateClubhouseDelegationResult,
): Promise<void> {
  await writeAuditEvent({
    entityType: 'system',
    entityId: 'revalidate-clubhouse-delegations',
    eventType: 'clubhouse.delegation_sweep_pass',
    actorWallet: '_revalidate-clubhouse-sweep',
    metadata: {
      participantsScanned: result.participantsScanned,
      walletsChecked: result.walletsChecked,
      walletsUpstreamFailures: result.walletsUpstreamFailures,
      walletsAllAligned: result.walletsAllAligned,
      mismatchedRecords: result.mismatchedRecords,
      pollVotesRevoked: result.pollVotesRevoked,
      commentsBadged: result.commentsBadged,
      commentsUnbadged: result.commentsUnbadged,
      writeErrors: result.writeErrors,
    },
  });
}

/**
 * EventBridge scheduled handler. Cadence: every 3 hours.
 *
 * Runs BOTH the stake re-weight phase (Batch REVAL, 2026-05-29) and the
 * clubhouse-delegation revoke+badge phase (Batch CLUBHOUSE-DELEGATION-
 * GATE, 2026-05-30) in sequence on the same schedule.
 *
 * Why same Lambda + same schedule:
 *   - Both phases issue batched Koios `/account_info_cached` calls on
 *     overlapping (often the same) wallet sets — colocating amortizes
 *     the cold-start + connection overhead.
 *   - One alarm to manage instead of two.
 *   - Phase isolation: if the clubhouse phase throws, the stake phase
 *     has already completed and committed; if the stake phase throws,
 *     the clubhouse phase still runs (try/catch per phase).
 */
export const handler = async (
  _event: ScheduledEvent,
  _context: Context,
): Promise<{
  stake: RevalidateCommentStakeResult;
  clubhouse: RevalidateClubhouseDelegationResult;
}> => {
  // Each phase isolates its own failures so a hard error in one does
  // not skip the other. Both return "empty result" defaults on the
  // hardest error paths (already covered inside the runners), so the
  // outer try/catch here is belt-and-suspenders.
  let stake: RevalidateCommentStakeResult;
  try {
    stake = await runRevalidateCommentStake();
  } catch (err) {
    console.error(
      'revalidate-comment-stake: hard failure in stake reweight phase:',
      err,
    );
    stake = emptyResult();
  }
  let clubhouse: RevalidateClubhouseDelegationResult;
  try {
    clubhouse = await runRevalidateClubhouseDelegations();
  } catch (err) {
    console.error(
      'revalidate-comment-stake: hard failure in clubhouse-delegation phase:',
      err,
    );
    clubhouse = emptyClubhouseResult();
  }
  return { stake, clubhouse };
};
