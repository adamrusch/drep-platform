/**
 * Helpers for the `comment_voters` registry table (Batch REVAL,
 * 2026-05-29).
 *
 * # What this module does
 *
 * Single chokepoint for the vote-write paths to upsert their voter into
 * the `comment_voters` registry. The registry is the O(voters)
 * enumeration target for the 3-hourly stake re-validation sweep
 * (`backend/src/sync/revalidate-comment-stake.ts`): without it, the
 * sweep would have to walk the entire `comment_votes` table (which
 * grows linearly in (comments × voters)) to find the distinct voter
 * set.
 *
 * # Best-effort contract — IMMOVABLE INVARIANT
 *
 * `upsertCommentVoter` MUST NEVER throw. A registry-upsert failure MUST
 * NEVER fail the underlying vote mutation. Same contract as
 * `writeAuditEvent` in `lib/audit.ts` and for the same reason: if the
 * registry write can take down the vote path, an attacker who can
 * throttle the registry table can take down public-comment voting.
 *
 * Implementation: the entire UpdateItem is wrapped in `try/catch`. Any
 * error is logged via `console.warn` (so it surfaces in CloudWatch but
 * doesn't page) and swallowed. The function returns `void`. Callers
 * `await` the call only so the Lambda's invocation lifecycle doesn't
 * tear down before the put completes — they CANNOT branch on this
 * completing.
 *
 * # Why a separate module vs inlining at the call sites
 *
 * Three reasons:
 *   1. Two call sites today (`comments/vote.ts` cast/change path, and
 *      `comments/create.ts` seed upvote). Inlining the same `try/catch`
 *      wrapper + UpdateExpression at both is error-prone.
 *   2. The atomic-ADD pattern needs to stay in sync with how the sweep
 *      reads the same row — colocating "write" + "type" + "update
 *      expression shape" in one file makes that contract visible.
 *   3. The test surface is one focused file (`comment-voters.test.ts`)
 *      that locks in the best-effort + atomic-add semantics without
 *      having to weave through the heavier vote-handler test fixtures.
 *
 * # Atomic-ADD semantics
 *
 * `ADD voteCount :one` is the DynamoDB primitive for "monotonic counter."
 * Two concurrent vote-writes from different wallets touch different
 * partitions (PK=stakeAddress); same wallet voting on different
 * comments touches the same partition but DDB handles the ADD
 * atomically. `SET lastKnownStake = :s, lastCheckedAt = :now`
 * unconditionally overwrites the snapshot — the vote handler has a
 * fresh `lookupStake` reading in hand at vote-time, so writing it
 * here lets the next sweep cheap-skip this wallet (the registry
 * value matches what the sweep will read from Koios).
 */

import { updateItem, tableNames } from './dynamodb';

export interface UpsertVoterInput {
  /** PK — the voter's bech32 stake address. */
  stakeAddress: string;
  /** Stringified BigInt — the stake the handler just snapshotted onto
   *  the per-vote row. The registry stores it so the sweep's compare
   *  step can early-out when the wallet hasn't moved between sweeps. */
  lovelace: string;
}

/**
 * Upsert one voter row in `comment_voters`. Atomic — the `ADD
 * voteCount :one` counter increment + `SET lastKnownStake/lastCheckedAt`
 * happen in a single UpdateItem. Best-effort: any failure (DDB outage,
 * IAM denial, throttling) is logged and swallowed.
 *
 * Returns `void`. Callers `await` for lifecycle reasons only.
 */
export async function upsertCommentVoter(input: UpsertVoterInput): Promise<void> {
  try {
    const now = new Date().toISOString();
    await updateItem(
      tableNames.commentVoters,
      { stakeAddress: input.stakeAddress },
      'ADD #voteCount :one SET #lastKnownStake = :s, #lastCheckedAt = :now',
      {
        '#voteCount': 'voteCount',
        '#lastKnownStake': 'lastKnownStake',
        '#lastCheckedAt': 'lastCheckedAt',
      },
      {
        ':one': 1,
        ':s': input.lovelace,
        ':now': now,
      },
    );
  } catch (err) {
    // Best-effort: never let a registry-upsert failure propagate. We
    // log at warn level so the failure is visible in CloudWatch
    // without paging — the next sweep will still re-weight this
    // wallet's votes correctly because the per-vote rows are the
    // source of truth for the displayed support level.
    console.warn(
      `comment-voters: failed to upsert stakeAddress=${input.stakeAddress}:`,
      err,
    );
  }
}
