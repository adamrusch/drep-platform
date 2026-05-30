/**
 * Tests for the `comment_voters` registry upsert helper (Batch REVAL,
 * 2026-05-29).
 *
 * # What we lock in
 *
 *   1. Wire shape — `UpdateItem` against `comment_voters` keyed on
 *      `stakeAddress`, expression `ADD voteCount :one SET
 *      lastKnownStake = :s, lastCheckedAt = :now`.
 *   2. Best-effort guarantee — an exception thrown by the underlying
 *      `updateItem` does NOT propagate to the caller. This is the
 *      load-bearing invariant: a registry-upsert failure must NEVER
 *      take down the vote-write it's auditing.
 *   3. Non-Error throwables are also caught (defensive).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./dynamodb', () => ({
  updateItem: vi.fn(),
  tableNames: {
    commentVoters: 'test-comment_voters',
  },
}));

import { updateItem } from './dynamodb';
import { upsertCommentVoter } from './comment-voters';

const mockUpdate = vi.mocked(updateItem);

const STAKE = 'stake1uyvjdz9rxsfsmv44rtk75k2rqyqskrga96dgdfrqjvjjpwsefcjnp';
const LOVELACE = '12345000000';

beforeEach(() => {
  vi.resetAllMocks();
  mockUpdate.mockResolvedValue(undefined);
});

describe('upsertCommentVoter — wire shape', () => {
  it('targets the comment_voters table keyed on stakeAddress', async () => {
    await upsertCommentVoter({ stakeAddress: STAKE, lovelace: LOVELACE });
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const [tableName, key] = mockUpdate.mock.calls[0]!;
    expect(tableName).toBe('test-comment_voters');
    expect(key).toEqual({ stakeAddress: STAKE });
  });

  it('builds an atomic ADD voteCount :one + SET lastKnownStake/lastCheckedAt expression', async () => {
    await upsertCommentVoter({ stakeAddress: STAKE, lovelace: LOVELACE });
    const [, , updateExpression, names, values] = mockUpdate.mock.calls[0]!;
    expect(updateExpression).toBe(
      'ADD #voteCount :one SET #lastKnownStake = :s, #lastCheckedAt = :now',
    );
    expect(names).toEqual({
      '#voteCount': 'voteCount',
      '#lastKnownStake': 'lastKnownStake',
      '#lastCheckedAt': 'lastCheckedAt',
    });
    expect(values).toMatchObject({
      ':one': 1,
      ':s': LOVELACE,
    });
    // `:now` is an ISO-8601 timestamp; we don't lock it to an exact
    // value but verify the shape.
    expect(typeof (values as Record<string, unknown>)[':now']).toBe('string');
    expect((values as Record<string, unknown>)[':now']).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
  });
});

describe('upsertCommentVoter — best-effort guarantee', () => {
  it('CRITICAL: returns void without throwing when updateItem rejects', async () => {
    // This is THE test that proves the invariant: a thrown error from
    // the registry upsert must NOT change the vote handler's success
    // response. If this test ever flakes back to expecting a rejection,
    // an entire class of governance-platform vote-write paths becomes
    // takedown-able via DDB partition throttling on `comment_voters`.
    mockUpdate.mockRejectedValue(new Error('throttled by DynamoDB'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // No `expect(...).rejects` — the helper must resolve.
    await expect(
      upsertCommentVoter({ stakeAddress: STAKE, lovelace: LOVELACE }),
    ).resolves.toBeUndefined();

    // The failure is observable via console.warn (CloudWatch will
    // surface it) but never propagates.
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('best-effort against non-Error throwables too (defensive)', async () => {
    // updateItem could in theory reject with a non-Error value. The
    // helper must catch that too — `catch (err)` matches anything.
    mockUpdate.mockRejectedValue('upstream string rejection');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      upsertCommentVoter({ stakeAddress: STAKE, lovelace: LOVELACE }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
