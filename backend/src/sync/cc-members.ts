/**
 * Constitutional Committee members sync — populates the `cc_members`
 * DDB cache from Koios's `/committee_info`.
 *
 * # Why this sync exists
 *
 * CC voters surface on the per-action Votes tab as bech32 `cc_hot...`
 * strings by default. The cache lets the votes read path join CC vote
 * rows to a stable per-member identity (with optional human-readable
 * name when one is registered on-chain via an UpdateCommittee action's
 * anchor) in a single BatchGet per request.
 *
 * # Cadence and epoch-skip
 *
 * EventBridge fires this hourly. The Lambda first reads `/tip` for the
 * current epoch, then reads the table's `META` side-row for the epoch
 * last synced. If the two match, the Lambda returns immediately
 * without calling `/committee_info` — CC membership only changes at
 * epoch boundaries (~every 5 days on mainnet today) via an
 * `UpdateCommittee` action, so re-fetching mid-epoch is wasted I/O.
 *
 * The Koios `/committee_info` call only fires on epoch transitions —
 * ~5 calls per epoch on mainnet, ~365 calls per year. Negligible.
 *
 * # Row shape
 *
 * | PK (`ccHotCred`)      | Attributes                                                |
 * |-----------------------|-----------------------------------------------------------|
 * | bech32 `cc_hot...`    | `coldCred, ccName?, joinedAtEpoch?, expiresAtEpoch?, lastSyncedAt` |
 * | `META`                | `lastSyncedEpoch` (number) — epoch of the last successful sync     |
 *
 * The META row is the epoch-skip cursor. We write it AFTER the
 * member writes succeed; if a Koios outage interrupts the cycle, the
 * next invocation tries again rather than thinking it's already
 * synced.
 *
 * # Names
 *
 * Today Koios does NOT expose a per-CC-member display name endpoint —
 * names typically come from the off-chain anchor of the
 * UpdateCommittee action that appointed the member. We persist
 * `ccName: undefined` as a placeholder so the schema is forward-
 * compatible when we add a backfill step that walks UpdateCommittee
 * anchors. The read path falls back to "CC Member ({hotCred
 * truncated})" when `ccName` is absent — see `recognition.ts`.
 *
 * # Failure modes
 *
 * - `/tip` failure: log and abort cycle. Membership is stable enough
 *   that one missed cycle is harmless.
 * - `/committee_info` failure: log and abort cycle. META row stays at
 *   the previous epoch; next hour's cycle retries.
 * - Per-member write failure: log, increment error counter, but
 *   continue with the rest. The META row is still bumped if any
 *   members were written — partial-but-flagged behavior.
 */

import type { ScheduledEvent, Context } from 'aws-lambda';
import {
  getCommitteeMembers,
  getCurrentEpoch,
  KoiosError,
  type KoiosCommitteeMember,
} from '../lib/koios';
import { getItem, putItem, tableNames } from '../lib/dynamodb';

/** Row shape persisted to `cc_members` for one member. */
export interface CCMemberItem {
  /** PK — bech32 `cc_hot...` voter identity. */
  ccHotCred: string;
  /** Bech32 `cc_cold...` cold credential (informational; the voter
   *  identity is `ccHotCred`). Undefined when Koios reports null. */
  coldCred?: string;
  /** Human-readable name, if any. Today always undefined — see module
   *  header. */
  ccName?: string;
  /** Epoch at which this member's term expires; null when no
   *  expiration is set. */
  expiresAtEpoch?: number;
  lastSyncedAt: string;
  [key: string]: unknown;
}

/** Row shape for the epoch-skip cursor. PK=`META`, no SK; the table is
 *  PK-only because every "real" CC member has a unique bech32 hot cred,
 *  and the META row's reserved PK doesn't collide with any real one. */
export interface CCMembersMetaItem {
  ccHotCred: 'META';
  /** Epoch number of the most recent successful sync. The next cycle
   *  skips the Koios call if `currentEpoch === lastSyncedEpoch`. */
  lastSyncedEpoch: number;
  lastSyncedAt: string;
  [key: string]: unknown;
}

export interface CCMembersSyncResult {
  /** `'skipped-same-epoch'` when the META row already matched the
   *  current epoch (no Koios call made). `'synced'` when Koios was
   *  reached and members were processed. `'errored'` when the cycle
   *  bailed before processing members. */
  outcome: 'skipped-same-epoch' | 'synced' | 'errored';
  currentEpoch?: number;
  lastSyncedEpoch?: number;
  membersTotal: number;
  membersWritten: number;
  errors: number;
}

/** Reserved PK for the epoch-skip cursor. Real CC hot creds are bech32
 *  `cc_hot...` strings; `META` cannot collide. */
export const CC_MEMBERS_META_KEY = 'META';

export async function runCCMembersSync(): Promise<CCMembersSyncResult> {
  const result: CCMembersSyncResult = {
    outcome: 'errored',
    membersTotal: 0,
    membersWritten: 0,
    errors: 0,
  };

  // Step 1: read the current epoch. If Koios `/tip` is unavailable we
  // bail rather than processing under a wrong epoch — the META row
  // would get a stale value and we'd skip future cycles incorrectly.
  let currentEpoch: number;
  try {
    currentEpoch = await getCurrentEpoch();
  } catch (err) {
    if (err instanceof KoiosError) {
      console.warn('CC-members sync: /tip unavailable; aborting cycle', err.message);
    } else {
      console.error('CC-members sync: /tip threw:', err);
    }
    result.errors = 1;
    return result;
  }
  result.currentEpoch = currentEpoch;

  // Step 2: read META row. If the last sync was the same epoch, skip
  // the (cheap but unnecessary) Koios round-trip and the per-member
  // writes. Membership doesn't change mid-epoch.
  let meta: CCMembersMetaItem | undefined;
  try {
    meta = await getItem<CCMembersMetaItem>(tableNames.ccMembers, {
      ccHotCred: CC_MEMBERS_META_KEY,
    });
  } catch (err) {
    // META read failure is not fatal — we treat it as "no prior sync"
    // and continue with a fresh fetch. The next successful sync will
    // re-populate META.
    console.warn('CC-members sync: META read failed; treating as cold-start', err);
  }
  if (meta && meta.lastSyncedEpoch === currentEpoch) {
    result.outcome = 'skipped-same-epoch';
    result.lastSyncedEpoch = meta.lastSyncedEpoch;
    console.log(
      `CC-members sync: skipped — META.lastSyncedEpoch=${meta.lastSyncedEpoch} matches current epoch ${currentEpoch}`,
    );
    return result;
  }

  // Step 3: fetch the current committee. `getCommitteeMembers` already
  // filters to `status === 'authorized'` and excludes rows with null
  // `cc_hot_id` — every row we get is a valid voter.
  let members: KoiosCommitteeMember[];
  try {
    members = await getCommitteeMembers();
  } catch (err) {
    if (err instanceof KoiosError) {
      console.warn('CC-members sync: /committee_info unavailable; aborting cycle', err.message);
    } else {
      console.error('CC-members sync: /committee_info threw:', err);
    }
    result.errors = 1;
    return result;
  }
  result.membersTotal = members.length;

  // Step 4: write each authorized member. Blind Put — the row is
  // small (~5 fields) and write-on-every-epoch-transition is cheap
  // (~7 WCU per transition, ~365 WCU/year).
  const now = new Date().toISOString();
  for (const m of members) {
    if (typeof m.cc_hot_id !== 'string') continue;
    const item: CCMemberItem = {
      ccHotCred: m.cc_hot_id,
      lastSyncedAt: now,
    };
    if (typeof m.cc_cold_id === 'string' && m.cc_cold_id.length > 0) {
      item.coldCred = m.cc_cold_id;
    }
    if (typeof m.expiration_epoch === 'number' && Number.isFinite(m.expiration_epoch)) {
      item.expiresAtEpoch = m.expiration_epoch;
    }
    // `ccName` is left undefined today — future work walks
    // UpdateCommittee anchors to populate it.
    try {
      await putItem(tableNames.ccMembers, item);
      result.membersWritten++;
    } catch (err) {
      console.error(`CC-members sync: failed to write ${m.cc_hot_id}:`, err);
      result.errors++;
    }
  }

  // Step 5: bump the META row AFTER member writes. If a partial
  // failure happened above we still bump (so the next cycle doesn't
  // re-attempt the whole list); errors are surfaced via the result
  // counter for CloudWatch.
  try {
    const metaItem: CCMembersMetaItem = {
      ccHotCred: CC_MEMBERS_META_KEY,
      lastSyncedEpoch: currentEpoch,
      lastSyncedAt: now,
    };
    await putItem(tableNames.ccMembers, metaItem);
    result.lastSyncedEpoch = currentEpoch;
  } catch (err) {
    console.error('CC-members sync: META write failed', err);
    result.errors++;
  }

  result.outcome = 'synced';
  console.log(
    `CC-members sync complete: epoch=${currentEpoch} ` +
      `total=${result.membersTotal} written=${result.membersWritten} errors=${result.errors}`,
  );
  return result;
}

/**
 * EventBridge scheduled handler. Cadence: hourly. The epoch-skip
 * guard inside `runCCMembersSync` means Koios is only contacted on
 * actual epoch transitions (~5/epoch on mainnet).
 */
export const handler = async (
  _event: ScheduledEvent,
  _context: Context,
): Promise<CCMembersSyncResult> => {
  return runCCMembersSync();
};
