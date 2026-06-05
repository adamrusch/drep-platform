/**
 * vote-rationale-sync — download + cache DRep/SPO/CC vote rationales for the
 * currently ACTIVE governance actions.
 *
 * Scope (product decision 2026-06): rationales for ALL voter roles, but only
 * on actions whose voting window is still open. That keeps the working set
 * small and always-current — a handful of active actions, each with a bounded
 * number of votes — instead of fanning out over every historical vote.
 *
 * Per run:
 *   1. Query active governance actions (status-submittedAt-index, status=active).
 *   2. For each, query its `governance_votes` rows that carry a rationale
 *      anchor (`attribute_exists(metaUrl)`).
 *   3. For each vote not yet cached (or a stale `unreachable` retry), fetch +
 *      verify + extract the rationale body (`fetchVoteRationale`) and write the
 *      compact { title, text, status, … } back onto the vote row. The existing
 *      `GET /governance/{actionId}` then returns it inline with the vote — no
 *      extra reads on the hot path.
 *
 * Bounded: at most MAX_FETCHES_PER_RUN network fetches per invocation, with
 * CONCURRENCY in flight. Whatever doesn't get processed this run is picked up
 * next run — the EventBridge cadence catches a backlog up over a few cycles
 * and then just handles newly-arrived votes. Idempotent: terminal statuses
 * (cached / hash_mismatch / empty / unsupported) are skipped; only
 * `unreachable` is retried, after RETRY_UNREACHABLE_AFTER_MS.
 */
import type { ScheduledEvent, Context } from 'aws-lambda';
import { queryItems, updateItem, tableNames } from '../lib/dynamodb';
import type { GovernanceActionItem } from '../lib/types';
import type { GovernanceVoteItem } from '../lib/votes';
import { fetchVoteRationale, type VoteRationaleResult } from '../lib/voteRationale';

// Bounded so the run fits comfortably in the Lambda timeout even when many
// anchors are slow/unreachable (each unreachable fetch walks several gateways).
// A first-run backlog is caught up over consecutive cycles.
const MAX_FETCHES_PER_RUN = 200;
const CONCURRENCY = 8;
const RETRY_UNREACHABLE_AFTER_MS = 6 * 60 * 60 * 1000; // 6h
const MAX_ACTION_PAGES = 20;
const MAX_VOTE_PAGES_PER_ACTION = 40;

export interface VoteRationaleSyncOptions {
  maxFetches?: number;
  concurrency?: number;
  retryAfterMs?: number;
  /** Injectable for tests; defaults to `Date.now()`. */
  now?: number;
  /** Injectable for tests; defaults to the real fetcher. */
  fetchFn?: (metaUrl?: string, metaHash?: string) => Promise<VoteRationaleResult>;
}

export interface VoteRationaleSyncResult {
  activeActions: number;
  candidates: number;
  fetched: number;
  cached: number;
  hashMismatch: number;
  empty: number;
  unreachable: number;
  unsupported: number;
  capped: boolean;
}

/** A vote needs (re)processing when it has an anchor and either was never
 *  processed, its anchor URL changed, or a prior `unreachable` attempt is now
 *  old enough to retry. Terminal outcomes are left alone. */
function needsProcessing(v: GovernanceVoteItem, now: number, retryAfterMs: number): boolean {
  if (!v.metaUrl) return false;
  const status = v['rationaleStatus'] as string | undefined;
  if (!status) return true;
  if (v['rationaleAnchorUrl'] !== v.metaUrl) return true; // anchor changed
  if (status === 'unreachable') {
    const fetchedAt = v['rationaleFetchedAt'] as string | undefined;
    const last = fetchedAt ? Date.parse(fetchedAt) : 0;
    return !Number.isFinite(last) || now - last >= retryAfterMs;
  }
  return false;
}

/** Build the SET/REMOVE update that writes a fetch result onto a vote row.
 *  Absent fields (e.g. no title) are REMOVEd so a retry can't leave stale
 *  data from a previous outcome. */
function buildUpdate(
  result: VoteRationaleResult,
  anchorUrl: string,
  nowIso: string,
): { expr: string; names: Record<string, string>; values: Record<string, unknown> } {
  const names: Record<string, string> = {
    '#rs': 'rationaleStatus',
    '#rf': 'rationaleFetchedAt',
    '#ra': 'rationaleAnchorUrl',
  };
  const values: Record<string, unknown> = {
    ':rs': result.status,
    ':rf': nowIso,
    ':ra': anchorUrl,
  };
  const sets = ['#rs = :rs', '#rf = :rf', '#ra = :ra'];
  const removes: string[] = [];

  const optional: Array<[string, string, unknown]> = [
    ['#rt', 'rationaleText', result.text],
    ['#rti', 'rationaleTitle', result.title],
    ['#rtr', 'rationaleTruncated', result.truncated ? true : undefined],
    ['#rhm', 'rationaleHashMatch', result.hashMatch],
  ];
  for (const [ph, attr, val] of optional) {
    if (val !== undefined) {
      names[ph] = attr;
      values[`:${ph.slice(1)}`] = val;
      sets.push(`${ph} = :${ph.slice(1)}`);
    } else {
      names[ph] = attr;
      removes.push(ph);
    }
  }

  const expr = `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`;
  return { expr, names, values };
}

async function listActiveActionIds(): Promise<string[]> {
  const ids: string[] = [];
  let start: Record<string, unknown> | undefined;
  for (let page = 0; page < MAX_ACTION_PAGES; page++) {
    const res = await queryItems<GovernanceActionItem>(tableNames.governanceActions, {
      indexName: 'status-submittedAt-index',
      keyConditionExpression: '#status = :status',
      expressionAttributeNames: { '#status': 'status' },
      expressionAttributeValues: { ':status': 'active' },
      projectionExpression: 'actionId',
      ...(start ? { exclusiveStartKey: start } : {}),
    });
    for (const a of res.items) if (a.actionId) ids.push(a.actionId);
    if (!res.lastEvaluatedKey) break;
    start = res.lastEvaluatedKey;
  }
  return ids;
}

async function listAnchoredVotes(actionId: string): Promise<GovernanceVoteItem[]> {
  const votes: GovernanceVoteItem[] = [];
  let start: Record<string, unknown> | undefined;
  for (let page = 0; page < MAX_VOTE_PAGES_PER_ACTION; page++) {
    const res = await queryItems<GovernanceVoteItem>(tableNames.governanceVotes, {
      keyConditionExpression: 'actionId = :a',
      expressionAttributeValues: { ':a': actionId },
      // Only rows that carry a rationale anchor — keeps the payload small.
      filterExpression: 'attribute_exists(metaUrl)',
      projectionExpression:
        'actionId, voteKey, metaUrl, metaHash, rationaleStatus, rationaleAnchorUrl, rationaleFetchedAt',
      ...(start ? { exclusiveStartKey: start } : {}),
    });
    votes.push(...res.items);
    if (!res.lastEvaluatedKey) break;
    start = res.lastEvaluatedKey;
  }
  return votes;
}

/** Run a bounded pool of async tasks with a fixed concurrency. */
async function pool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx]!);
    }
  });
  await Promise.all(runners);
}

export async function runVoteRationaleSync(
  opts: VoteRationaleSyncOptions = {},
): Promise<VoteRationaleSyncResult> {
  const maxFetches = opts.maxFetches ?? MAX_FETCHES_PER_RUN;
  const concurrency = opts.concurrency ?? CONCURRENCY;
  const retryAfterMs = opts.retryAfterMs ?? RETRY_UNREACHABLE_AFTER_MS;
  const now = opts.now ?? Date.now();
  const fetchFn = opts.fetchFn ?? fetchVoteRationale;
  const nowIso = new Date(now).toISOString();

  const stats: VoteRationaleSyncResult = {
    activeActions: 0,
    candidates: 0,
    fetched: 0,
    cached: 0,
    hashMismatch: 0,
    empty: 0,
    unreachable: 0,
    unsupported: 0,
    capped: false,
  };

  const actionIds = await listActiveActionIds();
  stats.activeActions = actionIds.length;

  // Collect candidates across all active actions, then process up to the cap.
  const candidates: GovernanceVoteItem[] = [];
  for (const actionId of actionIds) {
    const votes = await listAnchoredVotes(actionId);
    for (const v of votes) {
      if (needsProcessing(v, now, retryAfterMs)) candidates.push(v);
    }
  }
  stats.candidates = candidates.length;

  const batch = candidates.slice(0, maxFetches);
  stats.capped = candidates.length > batch.length;

  await pool(batch, concurrency, async (v) => {
    const anchorUrl = v.metaUrl as string;
    let result: VoteRationaleResult;
    try {
      result = await fetchFn(v.metaUrl, v.metaHash);
    } catch (err) {
      console.warn(`vote-rationale-sync: fetch threw for ${v.actionId}/${v.voteKey}:`, err);
      result = { status: 'unreachable' };
    }
    const { expr, names, values } = buildUpdate(result, anchorUrl, nowIso);
    try {
      await updateItem(
        tableNames.governanceVotes,
        { actionId: v.actionId, voteKey: v.voteKey },
        expr,
        names,
        values,
        // Don't recreate a row that was deleted between read and write.
        'attribute_exists(voteKey)',
      );
    } catch (err) {
      console.warn(`vote-rationale-sync: update failed for ${v.actionId}/${v.voteKey}:`, err);
      return;
    }
    stats.fetched++;
    switch (result.status) {
      case 'cached': stats.cached++; break;
      case 'hash_mismatch': stats.hashMismatch++; break;
      case 'empty': stats.empty++; break;
      case 'unreachable': stats.unreachable++; break;
      case 'unsupported': stats.unsupported++; break;
    }
  });

  console.log('vote-rationale-sync complete:', JSON.stringify(stats));
  return stats;
}

export const handler = async (
  _event: ScheduledEvent,
  _context: Context,
): Promise<VoteRationaleSyncResult> => {
  return runVoteRationaleSync();
};
