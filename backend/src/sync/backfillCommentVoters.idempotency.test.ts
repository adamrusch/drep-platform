/**
 * Idempotency tests for the `comment_voters` registry backfill script
 * (Batch REVAL, 2026-05-29). The actual script lives in
 * `backend/scripts/backfill-comment-voters.ts`; the testable library
 * (`backend/src/lib/backfill-comment-voters.ts`) is imported here.
 *
 * # What we lock in
 *
 *   1. `buildVoterRollup` accumulates per-wallet rollups correctly:
 *      - voteCount sums across rows
 *      - lastKnownStake reflects the LATEST `votedAt` snapshot
 *   2. `writeVoterIfAbsent` issues a conditional Put with
 *      `attribute_not_exists(stakeAddress)` and reports `'written' |
 *      'skipped' | 'errored'` appropriately.
 *   3. A second run hits the conditional-skip path on every wallet
 *      already in the registry — no double-counting.
 *   4. Dry-run skips writes entirely but still surfaces the rollup
 *      counters.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../lib/dynamodb', () => ({
  scanItems: vi.fn(),
  putItem: vi.fn(),
  tableNames: {
    commentVotes: 'test-comment_votes',
    commentVoters: 'test-comment_voters',
  },
}));

import { scanItems, putItem } from '../lib/dynamodb';
import {
  buildVoterRollup,
  writeVoterIfAbsent,
  runBackfillCommentVoters,
} from '../lib/backfill-comment-voters';
import type { CommentVoteItem } from '../lib/types';

const mockScan = vi.mocked(scanItems);
const mockPut = vi.mocked(putItem);

const STAKE_A = 'stake1a';
const STAKE_B = 'stake1b';

function makeVote(overrides: Partial<CommentVoteItem> = {}): CommentVoteItem {
  return {
    commentId: 'cmt-1',
    stakeAddress: STAKE_A,
    actionId: 'action-1',
    vote: 'up',
    lovelace: '1000000000',
    votedAt: '2026-05-20T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockPut.mockResolvedValue(undefined);
  mockScan.mockResolvedValue({ items: [], lastEvaluatedKey: undefined, count: 0 });
});

// ---- 1. Rollup math ----

describe('buildVoterRollup', () => {
  it('builds one rollup entry per distinct stakeAddress', () => {
    const rows = [
      makeVote({ commentId: 'c1', stakeAddress: STAKE_A }),
      makeVote({ commentId: 'c2', stakeAddress: STAKE_A }),
      makeVote({ commentId: 'c3', stakeAddress: STAKE_B }),
    ];
    const rollup = buildVoterRollup(rows);
    expect(rollup.size).toBe(2);
    expect(rollup.get(STAKE_A)?.voteCount).toBe(2);
    expect(rollup.get(STAKE_B)?.voteCount).toBe(1);
  });

  it('lastKnownStake reflects the LATEST votedAt row per wallet', () => {
    const rows = [
      makeVote({
        commentId: 'c1',
        stakeAddress: STAKE_A,
        lovelace: '1000000000', // older
        votedAt: '2026-05-01T00:00:00.000Z',
      }),
      makeVote({
        commentId: 'c2',
        stakeAddress: STAKE_A,
        lovelace: '5000000000', // newer
        votedAt: '2026-05-20T00:00:00.000Z',
      }),
      makeVote({
        commentId: 'c3',
        stakeAddress: STAKE_A,
        lovelace: '2000000000', // middle
        votedAt: '2026-05-10T00:00:00.000Z',
      }),
    ];
    const rollup = buildVoterRollup(rows);
    expect(rollup.get(STAKE_A)?.lastKnownStake).toBe('5000000000');
    expect(rollup.get(STAKE_A)?.latestVotedAt).toBe('2026-05-20T00:00:00.000Z');
  });

  it('skips rows with missing/empty stakeAddress (defensive)', () => {
    const rows = [
      makeVote({ stakeAddress: STAKE_A }),
      makeVote({ stakeAddress: '' as never }),
      makeVote({ stakeAddress: undefined as never }),
    ];
    const rollup = buildVoterRollup(rows);
    expect(rollup.size).toBe(1);
    expect(rollup.get(STAKE_A)?.voteCount).toBe(1);
  });
});

// ---- 2. Conditional Put outcomes ----

describe('writeVoterIfAbsent', () => {
  it('issues a Put with attribute_not_exists(stakeAddress) and returns "written" on success', async () => {
    const outcome = await writeVoterIfAbsent({
      stakeAddress: STAKE_A,
      voteCount: 3,
      lastKnownStake: '5000000000',
      latestVotedAt: '2026-05-20T00:00:00.000Z',
    });
    expect(outcome).toBe('written');
    expect(mockPut).toHaveBeenCalledTimes(1);
    const [table, item, condition, names] = mockPut.mock.calls[0]!;
    expect(table).toBe('test-comment_voters');
    expect(item).toMatchObject({
      stakeAddress: STAKE_A,
      lastKnownStake: '5000000000',
      voteCount: 3,
    });
    expect(typeof (item as Record<string, unknown>)['lastCheckedAt']).toBe('string');
    expect(condition).toBe('attribute_not_exists(#pk)');
    expect(names).toEqual({ '#pk': 'stakeAddress' });
  });

  it('returns "skipped" when ConditionalCheckFailedException fires (registry row already exists)', async () => {
    const condFail = new Error('row exists');
    condFail.name = 'ConditionalCheckFailedException';
    mockPut.mockRejectedValueOnce(condFail);
    const outcome = await writeVoterIfAbsent({
      stakeAddress: STAKE_A,
      voteCount: 1,
      lastKnownStake: '1000000000',
      latestVotedAt: '2026-05-20T00:00:00.000Z',
    });
    expect(outcome).toBe('skipped');
  });

  it('returns "errored" on any other DDB failure', async () => {
    mockPut.mockRejectedValueOnce(new Error('throttled'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const outcome = await writeVoterIfAbsent({
      stakeAddress: STAKE_A,
      voteCount: 1,
      lastKnownStake: '1000000000',
      latestVotedAt: '2026-05-20T00:00:00.000Z',
    });
    expect(outcome).toBe('errored');
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

// ---- 3. End-to-end idempotency ----

describe('runBackfillCommentVoters — two-pass idempotency', () => {
  it('first run writes; second run skips the already-existing rows (zero double-count)', async () => {
    const rows = [
      makeVote({ commentId: 'c1', stakeAddress: STAKE_A, lovelace: '1000000000' }),
      makeVote({ commentId: 'c2', stakeAddress: STAKE_A, lovelace: '2000000000' }),
      makeVote({ commentId: 'c3', stakeAddress: STAKE_B, lovelace: '500000000' }),
    ];
    mockScan.mockResolvedValue({
      items: rows,
      lastEvaluatedKey: undefined,
      count: 3,
    });

    // Pass 1: all rows written.
    mockPut.mockResolvedValue(undefined);
    const pass1 = await runBackfillCommentVoters();
    expect(pass1.voteRowsScanned).toBe(3);
    expect(pass1.distinctVoters).toBe(2);
    expect(pass1.registryWritten).toBe(2);
    expect(pass1.registrySkipped).toBe(0);
    expect(pass1.errors).toBe(0);

    // Pass 2: every Put gets ConditionalCheckFailed; no double-count.
    const condFail = new Error('row exists');
    condFail.name = 'ConditionalCheckFailedException';
    mockPut.mockReset();
    mockPut.mockRejectedValue(condFail);
    const pass2 = await runBackfillCommentVoters();
    expect(pass2.voteRowsScanned).toBe(3);
    expect(pass2.distinctVoters).toBe(2);
    expect(pass2.registryWritten).toBe(0);
    expect(pass2.registrySkipped).toBe(2);
    expect(pass2.errors).toBe(0);
  });

  it('dry-run scans + builds rollup but issues zero Puts', async () => {
    const rows = [
      makeVote({ commentId: 'c1', stakeAddress: STAKE_A }),
      makeVote({ commentId: 'c2', stakeAddress: STAKE_B }),
    ];
    mockScan.mockResolvedValue({
      items: rows,
      lastEvaluatedKey: undefined,
      count: 2,
    });

    const counters = await runBackfillCommentVoters({ dryRun: true });
    expect(counters.voteRowsScanned).toBe(2);
    expect(counters.distinctVoters).toBe(2);
    // `registryWritten` surfaces the "would-have-written" count under
    // dry-run (the operator can sanity-check the rollup size).
    expect(counters.registryWritten).toBe(2);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('no-op when comment_votes is empty (prod-today path)', async () => {
    mockScan.mockResolvedValueOnce({
      items: [],
      lastEvaluatedKey: undefined,
      count: 0,
    });
    const counters = await runBackfillCommentVoters();
    expect(counters.voteRowsScanned).toBe(0);
    expect(counters.distinctVoters).toBe(0);
    expect(counters.registryWritten).toBe(0);
    expect(mockPut).not.toHaveBeenCalled();
  });
});
