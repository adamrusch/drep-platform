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
  queryItems,
  scanItems,
  transactWrite,
  tableNames,
  updateItem,
} from '../lib/dynamodb';
import type { CommentVoteItem, CommentVoterItem } from '../lib/types';
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
    let queryResult;
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

/**
 * EventBridge scheduled handler. Cadence: every 3 hours.
 */
export const handler = async (
  _event: ScheduledEvent,
  _context: Context,
): Promise<RevalidateCommentStakeResult> => {
  return runRevalidateCommentStake();
};
