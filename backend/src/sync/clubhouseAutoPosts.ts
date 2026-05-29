/**
 * GA auto-post fan-out helpers.
 *
 * This module owns the writes that create / update / unpin the
 * `type='auto_ga'` rows in `clubhouse_posts`. It is consumed by:
 *
 *   1. `governance-intake.ts` — on new-GA detected, fan out one auto-
 *      post per currently-active DRep. On GA status transition to
 *      `executed`/`expired`, run the completion sweep that flips
 *      `pinned=false` on every linked auto-post.
 *
 *   2. `drep-directory.ts` — on a DRep transitioning from
 *      `isActive=false` to `isActive=true`, backfill auto-posts for
 *      every currently-active GA into that DRep's clubhouse.
 *
 *   3. `scripts/backfill-ga-auto-posts.ts` — one-shot backfill of
 *      currently-active GAs × currently-active DReps. Idempotent via
 *      the conditional Put on the `(drepId, postId)` primary key.
 *
 * ---- Identity & idempotency ----
 *
 * Post identity is `(drepId, kind='auto_ga', linkedActionId)`. We
 * synthesize a deterministic postId from that triple so the conditional
 * Put on `attribute_not_exists(postId)` correctly de-dupes across
 * concurrent writers (the governance-intake sync writing alongside the
 * one-shot backfill, etc.). The chosen shape is `auto-ga#<actionId>` —
 * collision-proof since `actionId` is `${txHash}#${certIndex}` which is
 * globally unique on Cardano.
 *
 * Why not random ULIDs: with a ULID, two concurrent fan-out calls for
 * the same DRep+action would both succeed (different `postId`s), creating
 * a duplicate. With the deterministic postId, the second writer's Put
 * fails the condition and we get the desired skip.
 *
 * ---- Frozen-body semantics ----
 *
 * `autoSource.abstractFrozenAt` captures "the moment this specific row
 * was created in this clubhouse," NOT "the moment the GA was first
 * indexed by the platform." A DRep that becomes active a week after a
 * GA goes live gets a row whose abstract reflects the CURRENT state
 * of the GA at the moment of THEIR activation — not the original
 * abstract from when the GA was submitted on-chain.
 *
 * This is correct because:
 *   1. Each clubhouse has its own per-DRep auto-post row.
 *   2. The "frozen" promise is per-row, not per-GA. We freeze what THIS
 *      delegator's clubhouse displays for THIS GA.
 *   3. Subsequent GA-anchor metadata changes do not update the post
 *      (the body is captured at create time, then never touched).
 *
 * If we instead froze at "the first time ANY clubhouse saw this GA,"
 * we'd surface stale abstract text to new delegators for actions that
 * had since been republished with corrections — which is the opposite
 * of what "frozen at sync time" should mean.
 *
 * ---- Cost analysis ----
 *
 *   - Per-new-GA fan-out: ~368 active DReps × 1 conditional Put = ~368
 *     WCU on the rare event that a new GA is detected (~50/year on
 *     mainnet today). Negligible: ~18k WCU/year total.
 *
 *   - Per-newly-active-DRep backfill: ~50 currently-active GAs × 1
 *     conditional Put = ~50 WCU. DReps becoming active fire a couple
 *     times a week. Negligible: ~5k WCU/year.
 *
 *   - One-shot backfill (the moment this feature deploys): ~50 GAs ×
 *     ~368 DReps = ~18,400 WCU one-time. ~$0.025 on PAY_PER_REQUEST.
 *
 *   - Completion sweep: per GA that transitions to `executed`/`expired`,
 *     ~368 Update calls. Fires when GAs complete (~50/year). Same
 *     order as the per-new-GA fan-out.
 *
 * The dominant write activity on `clubhouse_posts` is organic user
 * posts; the auto-post fan-out adds <0.1% to baseline.
 */

import { ulid } from 'ulid';
import {
  docClient,
  putItemIfAbsent,
  queryItems,
  tableNames,
} from '../lib/dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type {
  ClubhousePostItem,
  DRepDirectoryItem,
  GovernanceActionItem,
} from '../lib/types';

/** Author label rendered on every `auto_ga` row. The frontend uses
 *  this string verbatim as a fallback display name when no
 *  user-controllable display name is set; the rendering rule
 *  ("no avatar; small 'governance feed' badge") is keyed on the
 *  `type === 'auto_ga'` flag, not on this string. The wallet field
 *  uses a `_system` sentinel so the listing handler can never expose
 *  it as a real wallet address. */
export const AUTO_POST_AUTHOR_WALLET = '_system:governance_feed';
export const AUTO_POST_AUTHOR_DISPLAY_NAME = 'drep.tools governance feed';

/** Cap on parallel auto-post writes per fan-out call. DDB on-demand
 *  handles ~4k WPS per partition, and we're writing across N distinct
 *  drepId partitions, so contention is not a concern. The cap exists
 *  to bound Lambda memory + event-loop pressure. */
const AUTO_POST_WRITE_CONCURRENCY = 16;

/**
 * Build the deterministic postId for an auto_ga row. See module header
 * for the rationale.
 *
 * NOTE: this is a pure function. The returned string is used as the
 * DynamoDB primary sort key — change at your peril (existing rows
 * would orphan).
 */
export function autoPostId(actionId: string): string {
  return `auto-ga#${actionId}`;
}

export interface AutoPostFanoutInput {
  /** The newly-detected (or being-backfilled-into-this-DRep) GA. */
  action: GovernanceActionItem;
  /** Active DReps to write into. Caller is responsible for filtering
   *  out inactive / retired DReps before calling — this module trusts
   *  the input. */
  drepIds: readonly string[];
  /** Now timestamp. Caller passes it so test runs can pin time and so
   *  the same "moment" is used for both `createdAt` on the post AND
   *  `abstractFrozenAt` on its `autoSource`. */
  now: string;
}

export interface AutoPostFanoutResult {
  /** Number of (drepId, action) pairs where a new row was inserted. */
  written: number;
  /** Number of pairs where the conditional Put failed because a row
   *  already existed (idempotent re-run). */
  skipped: number;
  /** Errored writes (transport failure, etc.). The Promise resolves
   *  successfully — failures are tracked here. */
  errored: number;
}

/**
 * Build the immutable body + metadata for the auto-post row. Extracted
 * so the unpinning sweep and the post-construction site can share the
 * shape without drift.
 */
export function buildAutoPostBody(action: GovernanceActionItem): {
  title: string;
  body: string;
} {
  // Title prefers the off-chain anchor body title; falls back to the
  // synthesized on-chain summary (always present after enrichmentVersion
  // ≥ 4). Capped at 200 chars to fit comfortably in the clubhouse list
  // header.
  const rawTitle =
    (typeof action.title === 'string' && action.title.trim()) ||
    (typeof action.summary === 'string' && action.summary.trim()) ||
    `Governance Action ${action.actionId}`;
  const title = rawTitle.length > 200 ? `${rawTitle.slice(0, 197)}...` : rawTitle;

  // Body prefers the CIP-108 abstract, then the synthesized on-chain
  // summary, then a stock line. Capped at 5000 chars — well under the
  // 50k clubhouse-post body limit and keeps the row size reasonable
  // (~3KB × 368 DReps = ~1.1MB per fan-out, comfortably under DDB's
  // 400KB item limit per row).
  const rawBody =
    (typeof action.abstract === 'string' && action.abstract.trim()) ||
    (typeof action.summary === 'string' && action.summary.trim()) ||
    'New governance action posted. See the linked action for details.';
  const body = rawBody.length > 5_000 ? `${rawBody.slice(0, 4_997)}...` : rawBody;

  return { title, body };
}

/**
 * Fan-out the auto-post for one GA to every DRep in `drepIds`. Idempotent
 * — concurrent re-invocations skip rows that already exist via the
 * conditional Put.
 *
 * No throw on individual write failures: each pair is independent. A
 * transient DDB error on one row should not poison the rest of the
 * fan-out — the next sync cycle will retry it (idempotently).
 */
export async function fanoutAutoPosts(
  input: AutoPostFanoutInput,
): Promise<AutoPostFanoutResult> {
  const { action, drepIds, now } = input;
  const result: AutoPostFanoutResult = { written: 0, skipped: 0, errored: 0 };
  if (drepIds.length === 0) return result;

  const { title, body } = buildAutoPostBody(action);
  const postId = autoPostId(action.actionId);

  // Concurrent writes via a simple lane pool. Same pattern as
  // governance-intake's `persistVoteEvents`.
  let cursor = 0;
  const drepArr = drepIds;
  const lane = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= drepArr.length) return;
      const drepId = drepArr[i]!;
      const post: ClubhousePostItem = {
        drepId,
        postId,
        authorWallet: AUTO_POST_AUTHOR_WALLET,
        authorDisplayName: AUTO_POST_AUTHOR_DISPLAY_NAME,
        isDRepPost: false,
        body,
        title,
        // P0-3 de-inline migration (2026-05-28): the inline `comments: []`
        // field was REMOVED in Phase 6. Auto-posts initialize only the
        // denormalized `commentCount: 0` counter. See
        // `handlers/clubhouse/createPost.ts` for the matching contract.
        commentCount: 0,
        createdAt: now,
        updatedAt: now,
        type: 'auto_ga',
        pinned: true,
        linkedActionId: action.actionId,
        autoSource: {
          kind: 'governance_action',
          actionId: action.actionId,
          // The frozen-at timestamp captures the moment this specific
          // row was created in this clubhouse. See module header for
          // the rationale on why we use "now" rather than the GA's
          // submittedAt or ingestedAt.
          abstractFrozenAt: now,
        },
      };
      const putResult = await putItemIfAbsent(
        tableNames.clubhousePosts,
        post as unknown as Record<string, unknown>,
        { partitionKey: 'drepId', sortKey: 'postId' },
      );
      if (putResult.outcome === 'written') {
        result.written++;
      } else if (putResult.outcome === 'skipped') {
        result.skipped++;
      } else {
        result.errored++;
        if (putResult.error) {
          console.warn(
            `auto-post Put failed for drep=${drepId} action=${action.actionId}:`,
            putResult.error,
          );
        }
      }
    }
  };
  const lanes = Math.min(AUTO_POST_WRITE_CONCURRENCY, drepArr.length);
  await Promise.all(Array.from({ length: lanes }, () => lane()));
  return result;
}

/**
 * Completion sweep for one GA — find every auto-post linked to
 * `actionId` and flip `pinned=false`. Idempotent: rows already
 * unpinned are still updated (cheap no-op on DDB; UpdateExpression
 * with SET is unconditional).
 *
 * Uses the `linkedActionId-index` GSI. Pages through every result
 * (the GSI is partitioned on linkedActionId so a single Query returns
 * all rows for one action, but with ~368 rows per partition and the
 * 1MB result-size cap we may need a couple of round-trips for the
 * GSI projection size — current row size is ~3KB so 1MB ≈ 330 rows).
 */
export interface UnpinAutoPostsResult {
  unpinned: number;
  errored: number;
}

export async function unpinAutoPostsForAction(
  actionId: string,
): Promise<UnpinAutoPostsResult> {
  const result: UnpinAutoPostsResult = { unpinned: 0, errored: 0 };
  let lastKey: Record<string, unknown> | undefined;
  do {
    const queryRes = await queryItems<ClubhousePostItem>(
      tableNames.clubhousePosts,
      {
        indexName: 'linkedActionId-index',
        keyConditionExpression: '#k = :v',
        expressionAttributeNames: { '#k': 'linkedActionId' },
        expressionAttributeValues: { ':v': actionId },
        ...(lastKey ? { exclusiveStartKey: lastKey } : {}),
      },
    );
    for (const row of queryRes.items) {
      try {
        // Issue an UpdateItem that flips `pinned` to false. We avoid
        // overwriting the entire row with putItem because organic
        // edits to other fields (none exist today, but defending
        // against future drift) shouldn't be clobbered.
        //
        // Note: this is the one place in this module that touches the
        // DDB client directly. The `dynamodb.ts` helper exposes
        // `updateItem` but it requires a non-empty values map which
        // makes calls noisier than needed; the inline UpdateCommand
        // is clearer at this size.
        await docClient.send(
          new UpdateCommand({
            TableName: tableNames.clubhousePosts,
            Key: { drepId: row.drepId, postId: row.postId },
            UpdateExpression: 'SET #p = :false, #u = :now',
            ExpressionAttributeNames: { '#p': 'pinned', '#u': 'updatedAt' },
            ExpressionAttributeValues: {
              ':false': false,
              ':now': new Date().toISOString(),
            },
          }),
        );
        result.unpinned++;
      } catch (err) {
        result.errored++;
        console.warn(
          `unpinAutoPostsForAction: update failed for drep=${row.drepId} postId=${row.postId}:`,
          err,
        );
      }
    }
    lastKey = queryRes.lastEvaluatedKey;
  } while (lastKey);
  return result;
}

/**
 * Detect "completed" GAs from the current sync's view and run the
 * unpinning sweep for any that transitioned this cycle.
 *
 * "Completed" = status is one of `expired` / `enacted` / `dropped` per
 * the `GovernanceActionStatus` union (we do not have an `executed`
 * status; the spec used `executed` loosely — it maps to `enacted` on
 * mainnet today).
 *
 * Inputs:
 *   - `previousByAction`: the existing rows BEFORE this cycle's writes
 *     (already in memory from the governance-intake sync's per-action
 *     existence Get).
 *   - `nextByAction`: the candidate rows being written this cycle.
 *
 * We only fire the sweep when the status TRANSITIONED to a completed
 * state this cycle — running it for a GA that was already completed
 * last cycle would re-issue ~368 UpdateItem calls per cycle for nothing.
 */
const COMPLETED_STATUSES = new Set(['expired', 'enacted', 'dropped']);

export function isCompletedStatus(status: string): boolean {
  return COMPLETED_STATUSES.has(status);
}

export interface CompletionSweepCandidate {
  actionId: string;
  previousStatus: string | undefined;
  nextStatus: string;
}

/** Filter the (prev, next) pairs to only those that transitioned to a
 *  completed status this cycle. Pure function — caller fires the
 *  sweep.
 *
 *  # SEC-2 (2026-05-28) — born-completed guard
 *
 *  A brand-new row (`previous === undefined`) whose `next.status` is
 *  already a completed value (`enacted`/`expired`/`dropped`) is filtered
 *  OUT. Rationale:
 *
 *    - The fan-out path is now ALSO gated to skip born-completed GAs
 *      (see `governance-intake.ts`'s newGAItems filter), so there are
 *      no pinned auto-posts to unpin for these rows.
 *    - Running the sweep regardless would issue ~368 UpdateItem calls
 *      against `clubhouse_posts` rows that don't exist — every one
 *      would be a no-op against a missing row (UpdateItem is "upsert" by
 *      default and would CREATE empty rows!). Even with the GSI Query
 *      finding zero matching rows the sweep is wasted work + CloudWatch
 *      noise.
 *    - Worth the explicit guard rather than relying on the GSI being
 *      empty: an audit / replay scenario could surface stale post rows
 *      from a previous deploy, and the right answer is still "don't run
 *      a sweep for a GA that completed before we ever saw it."
 *
 *  Active → completed transitions (the common case) STILL fire the
 *  sweep — that's the whole point of unpinning a freshly-completed GA's
 *  auto-posts in every clubhouse. The guard only changes behavior for
 *  the rare cold-start / backfill / late-discovery cases. */
export function selectCompletionSweepCandidates(
  pairs: readonly { actionId: string; previous: GovernanceActionItem | undefined; next: GovernanceActionItem }[],
): CompletionSweepCandidate[] {
  const out: CompletionSweepCandidate[] = [];
  for (const p of pairs) {
    const nextStatus = p.next.status as string;
    if (!isCompletedStatus(nextStatus)) continue;
    const previousStatus = p.previous?.status as string | undefined;
    // Only fire when the status changed INTO a completed state. If the
    // row was already in a completed state last cycle, the sweep already
    // ran (or didn't need to run); we don't want to re-issue ~368
    // updates every minute.
    if (previousStatus !== undefined && isCompletedStatus(previousStatus)) {
      continue;
    }
    // Born-completed guard: a brand-new row that landed already in a
    // completed state has no pinned auto-posts to unpin (the fan-out
    // skipped it for the same reason). Skip the sweep.
    if (p.previous === undefined) {
      continue;
    }
    out.push({
      actionId: p.actionId,
      previousStatus,
      nextStatus,
    });
  }
  return out;
}

/**
 * Filter a list of newly-detected GAs to those that should trigger
 * the auto-post fan-out. A new GA whose status is already a completed
 * value (`enacted` / `expired` / `dropped`) when first seen is excluded
 * — fanning out ~368 pinned auto-posts and then immediately unpinning
 * them is ~736 wasted writes plus CloudWatch noise for a GA that's
 * invisible (unpinned) anyway. A GA that completed before we ever saw
 * it doesn't need auto-posts in every clubhouse.
 *
 * Active GAs (the common case) pass through unchanged.
 *
 * SEC-2 (2026-05-28).
 */
export function selectFanoutCandidates(
  newGAs: readonly GovernanceActionItem[],
): GovernanceActionItem[] {
  return newGAs.filter((ga) => !isCompletedStatus(ga.status as string));
}

// ---- Internal exports used by tests ----
// (none currently — the public exports above are sufficient)

/** Convenience helper for callers that have a list of `DRepDirectoryItem`
 *  and want just the IDs that are currently active. Filters predefined
 *  DReps IN (they're active by definition) and filters retired DReps
 *  OUT. */
export function activeDRepIds(rows: readonly DRepDirectoryItem[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (r.isActive === true) out.push(r.drepId);
  }
  return out;
}

// Re-export ulid so callers (e.g. the backfill script) don't need an
// extra import line. Used only for organic posts, never for auto_ga
// rows (those use the deterministic id).
export { ulid as _ulid };
