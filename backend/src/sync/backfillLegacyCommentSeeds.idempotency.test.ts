/**
 * Tests for the legacy-comment seed-vote backfill script (Batch F #16,
 * 2026-05-27).
 *
 * The actual script lives in `backend/scripts/backfill-legacy-comment-seeds.ts`
 * (out of tree of `src/` so it doesn't bundle into Lambda artifacts).
 * We import the testable `processComment` helper from the script and
 * mock its downstream collaborators (`lookupStake`, `transactWrite`).
 *
 * # What we lock in
 *
 *   1. A fresh seed (no prior row) writes a transactWrite with the
 *      expected ConditionExpression and counter delta. Counter
 *      reflects the looked-up lovelace; `upvoteCount` ADD = +1.
 *   2. A re-run that lands on an already-seeded row catches the
 *      ConditionalCheckFailedException and counts as `skipped` (no
 *      counter mutation re-applied).
 *   3. TransactionCanceledException with a ConditionalCheckFailed
 *      reason is treated as `skipped` (transact path).
 *   4. Both-upstreams-failed lookups count as `errors`+`upstreamFailures`
 *      WITHOUT writing a zero-weight seed. Operator re-runs once
 *      upstreams recover.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../lib/recognition', () => ({
  lookupStake: vi.fn(),
}));

vi.mock('../lib/dynamodb', () => ({
  scanItems: vi.fn(),
  transactWrite: vi.fn(),
  // P0-2 (2026-05-28): backfill now invokes `updateItem` first when the
  // comment row's `supportLovelace` is a legacy `S` string, to flip it
  // to `N`. Tests that don't exercise the migration path leave it
  // unmocked-by-default; the call simply resolves to undefined.
  updateItem: vi.fn().mockResolvedValue(undefined),
  tableNames: {
    users: 'test-users',
    drepCommittees: 'test-drep_committees',
    drepDirectory: 'test-drep_directory',
    governanceActions: 'test-governance_actions',
    governanceVotes: 'test-governance_votes',
    comments: 'test-comments',
    commentVotes: 'test-comment_votes',
    clubhousePosts: 'test-clubhouse_posts',
    poolMetadata: 'test-pool_metadata',
    ccMembers: 'test-cc_members',
    auditLog: 'test-audit_log',
    authNonces: 'test-auth_nonces',
  },
}));

import { lookupStake } from '../lib/recognition';
import { transactWrite, updateItem } from '../lib/dynamodb';
import {
  processComment,
  type BackfillSeedCounters,
} from '../lib/backfill-legacy-comment-seeds';
import type { CommentItem } from '../lib/types';

const mockLookupStake = vi.mocked(lookupStake);
const mockTransactWrite = vi.mocked(transactWrite);
const mockUpdateItem = vi.mocked(updateItem);

const STAKE = 'stake1uyvjdz9rxsfsmv44rtk75k2rqyqskrga96dgdfrqjvjjpwsefcjnp';
const LOVELACE = '12345000000';

function freshCounters(): BackfillSeedCounters {
  return {
    totalScanned: 0,
    candidates: 0,
    seeded: 0,
    skipped: 0,
    errors: 0,
    upstreamFailures: 0,
  };
}

function makeComment(overrides: Partial<CommentItem> = {}): CommentItem {
  return {
    actionId: 'action-1',
    commentId: 'cmt-01HF0',
    walletAddress: STAKE,
    body: 'legacy comment text',
    isPublic: true,
    isDRep: false,
    createdAt: '2026-04-15T12:00:00.000Z',
    updatedAt: '2026-04-15T12:00:00.000Z',
    upvoteCount: 0,
    downvoteCount: 0,
    ...overrides,
  };
}

describe('backfill-legacy-comment-seeds:processComment', () => {
  beforeEach(() => {
    mockLookupStake.mockReset();
    mockTransactWrite.mockReset();
    mockUpdateItem.mockReset();
    mockUpdateItem.mockResolvedValue(undefined);
  });

  it('writes a seed vote + counter update when stake lookup succeeds and no prior row exists', async () => {
    mockLookupStake.mockResolvedValue({ lovelace: LOVELACE, source: 'koios' });
    mockTransactWrite.mockResolvedValue(undefined);

    const counters = freshCounters();
    const comment = makeComment();
    await processComment(comment, counters);

    expect(counters.seeded).toBe(1);
    expect(counters.skipped).toBe(0);
    expect(counters.errors).toBe(0);
    expect(counters.upstreamFailures).toBe(0);

    expect(mockTransactWrite).toHaveBeenCalledTimes(1);
    const callArgs = mockTransactWrite.mock.calls[0];
    expect(callArgs).toBeDefined();
    const items = callArgs![0];
    expect(items).toBeDefined();
    // Two items: the Put on comment_votes (with attribute_not_exists
    // condition) and the Update on comments (counter delta).
    expect(items).toHaveLength(2);
    const putItem = (items![0] as { Put?: Record<string, unknown> }).Put;
    const updateItem = (items![1] as { Update?: Record<string, unknown> }).Update;
    expect(putItem).toBeDefined();
    expect(updateItem).toBeDefined();
    expect(putItem!['TableName']).toBe('test-comment_votes');
    expect(putItem!['ConditionExpression']).toBe('attribute_not_exists(#pk)');
    // Seed-vote payload uses the looked-up lovelace and backdates to
    // the comment's original createdAt.
    const seed = putItem!['Item'] as Record<string, unknown>;
    expect(seed['lovelace']).toBe(LOVELACE);
    expect(seed['vote']).toBe('up');
    expect(seed['stakeAddress']).toBe(STAKE);
    expect(seed['actionId']).toBe('action-1');
    expect(seed['commentId']).toBe('cmt-01HF0');
    expect(seed['votedAt']).toBe('2026-04-15T12:00:00.000Z');
    // Counter delta: ADD :delta to supportLovelace + 1 to upvoteCount.
    const updateExpr = updateItem!['UpdateExpression'] as string;
    expect(updateExpr).toMatch(/ADD\s+#supportLov\s+:delta/);
    expect(updateExpr).toMatch(/#upCount\s+:upD/);
    const values = updateItem!['ExpressionAttributeValues'] as Record<string, unknown>;
    // P0-2 (2026-05-28): the script now emits `:delta` as a JS bigint
    // so the doc client marshals it to DDB `N`. Previously it was a
    // string and the marshaller emitted `S`, which made the `ADD`
    // throw `ValidationException` (same bug as in the live vote
    // handler).
    expect(values[':delta']).toBe(BigInt(LOVELACE));
    expect(typeof values[':delta']).toBe('bigint');
    expect(values[':upD']).toBe(1);
  });

  it('counts a re-run hit as skipped when the seed row already exists (ConditionalCheckFailedException)', async () => {
    mockLookupStake.mockResolvedValue({ lovelace: LOVELACE, source: 'koios' });
    const condFail = new Error('seed exists');
    condFail.name = 'ConditionalCheckFailedException';
    mockTransactWrite.mockRejectedValue(condFail);

    const counters = freshCounters();
    await processComment(makeComment(), counters);

    expect(counters.skipped).toBe(1);
    expect(counters.seeded).toBe(0);
    expect(counters.errors).toBe(0);
  });

  it('counts a re-run hit as skipped on TransactionCanceledException with a ConditionalCheckFailed reason', async () => {
    mockLookupStake.mockResolvedValue({ lovelace: LOVELACE, source: 'koios' });
    const txFail: Error & { CancellationReasons?: unknown } = new Error('tx cancelled');
    txFail.name = 'TransactionCanceledException';
    txFail.CancellationReasons = [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }];
    mockTransactWrite.mockRejectedValue(txFail);

    const counters = freshCounters();
    await processComment(makeComment(), counters);

    expect(counters.skipped).toBe(1);
    expect(counters.errors).toBe(0);
  });

  it('counts both-upstreams-failed lookups as errors+upstreamFailures and skips the write', async () => {
    mockLookupStake.mockResolvedValue({ lovelace: null, source: null });

    const counters = freshCounters();
    await processComment(makeComment(), counters);

    expect(counters.errors).toBe(1);
    expect(counters.upstreamFailures).toBe(1);
    expect(counters.seeded).toBe(0);
    expect(counters.skipped).toBe(0);
    expect(mockTransactWrite).not.toHaveBeenCalled();
  });

  it('two-pass idempotency: a successful seed followed by an identical re-run yields seeded=1, skipped=1', async () => {
    // Pass 1: Put succeeds.
    mockLookupStake.mockResolvedValue({ lovelace: LOVELACE, source: 'koios' });
    mockTransactWrite.mockResolvedValueOnce(undefined);

    const counters = freshCounters();
    await processComment(makeComment(), counters);
    expect(counters.seeded).toBe(1);
    expect(counters.skipped).toBe(0);

    // Pass 2: seed already exists — conditional fails.
    const condFail = new Error('seed exists');
    condFail.name = 'ConditionalCheckFailedException';
    mockTransactWrite.mockRejectedValueOnce(condFail);

    await processComment(makeComment(), counters);
    expect(counters.seeded).toBe(1);
    expect(counters.skipped).toBe(1);
    expect(counters.errors).toBe(0);
  });

  // ---- P0-2 (2026-05-28) ----

  it('P0-2: when comment.supportLovelace is a legacy `S` string, runs the migration UpdateItem before the seed transactWrite', async () => {
    mockLookupStake.mockResolvedValue({ lovelace: LOVELACE, source: 'koios' });
    mockTransactWrite.mockResolvedValue(undefined);

    const counters = freshCounters();
    const legacyComment = makeComment({ supportLovelace: '7777000000' });
    await processComment(legacyComment, counters);

    // The migration ran exactly once with the right shape.
    expect(mockUpdateItem).toHaveBeenCalledTimes(1);
    const [tableName, key, expr, names, values, condition] =
      mockUpdateItem.mock.calls[0]!;
    expect(tableName).toBe('test-comments');
    expect(key).toEqual({ actionId: 'action-1', commentId: 'cmt-01HF0' });
    expect(expr).toBe('SET #supportLov = :n');
    expect(names).toEqual({ '#supportLov': 'supportLovelace' });
    expect(values).toEqual({ ':n': BigInt('7777000000'), ':sType': 'S' });
    expect(condition).toBe('attribute_type(#supportLov, :sType)');

    // …and the regular seed transactWrite still ran afterwards.
    expect(mockTransactWrite).toHaveBeenCalledTimes(1);
    expect(counters.seeded).toBe(1);
  });

  it('P0-2: skips the migration UpdateItem when supportLovelace is absent (the existing legacy filter)', async () => {
    mockLookupStake.mockResolvedValue({ lovelace: LOVELACE, source: 'koios' });
    mockTransactWrite.mockResolvedValue(undefined);

    const counters = freshCounters();
    // The default `makeComment` shape omits `supportLovelace`.
    await processComment(makeComment(), counters);

    expect(mockUpdateItem).not.toHaveBeenCalled();
    expect(counters.seeded).toBe(1);
  });
});
