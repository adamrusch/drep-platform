/**
 * One-shot backfill: seed the `comment_voters` registry from every
 * distinct `(stakeAddress)` already present in `comment_votes`
 * (Batch REVAL, 2026-05-29).
 *
 * # Why this script exists
 *
 * The `comment_voters` registry is the O(voters) enumeration target for
 * the 3-hourly stake re-validation sweep. The live vote-write paths
 * upsert into it on every cast / change / seed-author-upvote, but the
 * platform already has historical votes from before this PR ships —
 * those wallets need to be seeded into the registry so the sweep
 * picks them up on its first run.
 *
 * Today on prod the comment-voting feature has zero historical votes
 * (per the plan note), so this script is a no-op. It's still part of
 * the deploy contract because: (a) dev has test votes that need
 * seeding, (b) the future-prod scenario where this PR ships AFTER live
 * voting has happened is handled correctly, (c) the deploy ordering
 * in the plan explicitly calls for "registry backfill BEFORE ApiStack"
 * so the very first vote-write doesn't race the registry being empty.
 *
 * # Idempotency
 *
 * Per-wallet UpdateItem with `ADD voteCount :one` is the same atomic
 * op the live vote handler uses — running this backfill twice
 * double-counts `voteCount` for every wallet. To stay idempotent we
 * instead use a conditional `PutItem` with `attribute_not_exists` on
 * `stakeAddress` — the first run writes a fresh registry row with
 * voteCount = total votes counted from the scan; a re-run hits the
 * condition and skips, leaving the registry entry exactly as the live
 * write path left it. This is safe because the live write paths
 * NEVER call PutItem on the registry (they only call UpdateItem with
 * ADD), so a live update during the backfill window doesn't get
 * clobbered by the conditional Put — at worst we skip a wallet whose
 * registry was created by a live vote between scan and Put.
 *
 * # Walk shape
 *
 * `Scan(comment_votes)` accumulates a per-wallet rollup in memory:
 *   - voteCount = how many votes this wallet has
 *   - lastKnownStake = the MAX votedAt's `lovelace` (BigInt-compare
 *     by votedAt timestamp; if no `votedAt` use the last seen row's
 *     value as a fallback).
 *
 * Then one PutItem per wallet with `attribute_not_exists(stakeAddress)`.
 *
 * # Dry-run flag
 *
 * `--dry-run` walks the votes table and prints the rollup but issues
 * no writes. Useful for sanity-checking the per-wallet vote counts
 * before flipping it on.
 */

import { scanItems, putItem, tableNames } from './dynamodb';
import type { CommentVoteItem } from './types';

export interface BackfillVotersCounters {
  voteRowsScanned: number;
  distinctVoters: number;
  registryWritten: number;
  registrySkipped: number;
  errors: number;
}

export function freshBackfillVotersCounters(): BackfillVotersCounters {
  return {
    voteRowsScanned: 0,
    distinctVoters: 0,
    registryWritten: 0,
    registrySkipped: 0,
    errors: 0,
  };
}

/**
 * Walk every row of `comment_votes` accumulating a per-wallet rollup.
 * Pure data-loading step — no writes. Exported for testability so the
 * idempotency test can inject a mocked scan and inspect the rollup
 * without going through the write path.
 *
 * The rollup tracks the LATEST vote per (stakeAddress, votedAt) — the
 * latest `lovelace` snapshot best approximates "what the live vote
 * write would have set the registry to," so the very first sweep
 * after the backfill compares against the most-recent state.
 */
export interface VoterRollup {
  stakeAddress: string;
  voteCount: number;
  /** Stringified BigInt lovelace from the LATEST vote row by `votedAt`. */
  lastKnownStake: string;
  /** ISO-8601 — the `votedAt` of the latest vote row. */
  latestVotedAt: string;
}

export function buildVoterRollup(
  voteRows: ReadonlyArray<CommentVoteItem>,
): Map<string, VoterRollup> {
  const out = new Map<string, VoterRollup>();
  for (const row of voteRows) {
    if (typeof row.stakeAddress !== 'string' || row.stakeAddress.length === 0) {
      continue;
    }
    const existing = out.get(row.stakeAddress);
    const votedAt = typeof row.votedAt === 'string' ? row.votedAt : '';
    const lovelace = typeof row.lovelace === 'string' ? row.lovelace : '0';
    if (existing === undefined) {
      out.set(row.stakeAddress, {
        stakeAddress: row.stakeAddress,
        voteCount: 1,
        lastKnownStake: lovelace,
        latestVotedAt: votedAt,
      });
      continue;
    }
    existing.voteCount += 1;
    // Latest `votedAt` wins for the snapshot — string-compare is OK
    // because ISO-8601 UTC sorts lexicographically as chronological.
    if (votedAt > existing.latestVotedAt) {
      existing.latestVotedAt = votedAt;
      existing.lastKnownStake = lovelace;
    }
  }
  return out;
}

/**
 * Run the full backfill. Scans `comment_votes`, builds the per-wallet
 * rollup, then conditionally Puts each rollup into `comment_voters`
 * (skipping wallets whose registry row already exists from the live
 * write path).
 *
 * `dryRun=true` walks + accumulates the rollup but skips all writes;
 * useful for previewing the impact before running for real. Counters
 * still surface `registryWritten` (number of rows that WOULD have been
 * written) so the operator can sanity-check.
 *
 * Logs progress every 100 rollup entries processed.
 */
export async function runBackfillCommentVoters(
  options: { dryRun?: boolean } = {},
): Promise<BackfillVotersCounters> {
  const { dryRun = false } = options;
  const counters = freshBackfillVotersCounters();

  console.log(
    `backfill-comment-voters: target = ${tableNames.commentVoters} (source = ${tableNames.commentVotes})` +
      (dryRun ? ' DRY-RUN' : ''),
  );

  // Step 1: scan every vote row.
  const voteRows: CommentVoteItem[] = [];
  let cursor: Record<string, unknown> | undefined;
  let page = 0;
  do {
    page += 1;
    const result = await scanItems<CommentVoteItem>(
      tableNames.commentVotes,
      cursor ? { exclusiveStartKey: cursor } : {},
    );
    counters.voteRowsScanned += result.count;
    voteRows.push(...result.items);
    console.log(
      `backfill-comment-voters: page ${page} — scanned ${result.count} vote row(s), running total ${voteRows.length}`,
    );
    cursor = result.lastEvaluatedKey;
  } while (cursor);

  // Step 2: build the per-wallet rollup.
  const rollup = buildVoterRollup(voteRows);
  counters.distinctVoters = rollup.size;
  console.log(
    `backfill-comment-voters: rollup has ${rollup.size} distinct wallet(s)`,
  );

  // Step 3: conditionally write each rollup entry.
  let processed = 0;
  for (const entry of rollup.values()) {
    if (!dryRun) {
      const outcome = await writeVoterIfAbsent(entry);
      if (outcome === 'written') counters.registryWritten += 1;
      else if (outcome === 'skipped') counters.registrySkipped += 1;
      else counters.errors += 1;
    } else {
      // Dry-run: surface what WOULD be written so the operator can
      // sanity-check without inspecting CloudWatch.
      counters.registryWritten += 1;
    }
    processed += 1;
    if (processed % 100 === 0) {
      console.log(
        `backfill-comment-voters: ${processed}/${rollup.size} written=${counters.registryWritten} skipped=${counters.registrySkipped} errored=${counters.errors}`,
      );
    }
  }

  return counters;
}

/**
 * Conditional put of one registry row. Exported so the idempotency
 * tests can mock `putItem` and inspect the call shape directly.
 *
 * Returns:
 *   - `'written'` — fresh registry row created.
 *   - `'skipped'` — registry row already existed (live write path or
 *     a prior backfill run).
 *   - `'errored'` — any other failure.
 */
export async function writeVoterIfAbsent(
  entry: VoterRollup,
): Promise<'written' | 'skipped' | 'errored'> {
  const now = new Date().toISOString();
  const item = {
    stakeAddress: entry.stakeAddress,
    lastKnownStake: entry.lastKnownStake,
    lastCheckedAt: now,
    voteCount: entry.voteCount,
  };
  try {
    await putItem(tableNames.commentVoters, item, 'attribute_not_exists(#pk)', {
      '#pk': 'stakeAddress',
    });
    return 'written';
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return 'skipped';
    }
    console.error(
      `backfill-comment-voters: putItem failed for ${entry.stakeAddress}:`,
      err,
    );
    return 'errored';
  }
}
