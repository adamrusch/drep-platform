/**
 * Tests for the GA auto-post fan-out helpers (Batch B, 2026-05-26).
 *
 * Covered behaviors:
 *   - `fanoutAutoPosts` writes one row per DRep with the deterministic
 *     postId and the right body / pinned / autoSource shape.
 *   - Idempotency: a second call for the same (drep, action) pair is
 *     a no-op via the conditional Put on `attribute_not_exists`.
 *   - `buildAutoPostBody` falls back through title → summary → stock,
 *     and through abstract → summary → stock, with the right caps.
 *   - `selectCompletionSweepCandidates` only emits actions that
 *     TRANSITIONED into a completed state this cycle — actions that
 *     were already completed last cycle are filtered out (so the
 *     unpin sweep doesn't re-fire ~368 updates per cycle).
 *   - `unpinAutoPostsForAction` flips `pinned=false` on every row
 *     returned by the GSI query.
 *
 * Why this exists: the auto-post feature touches multi-table fan-out
 * with real-scale write volume. A regression in the conditional-Put
 * idempotency would create one extra row per DRep per cycle (~368
 * extra writes per cycle × 1440 cycles/day = ~530k extra writes/day,
 * ~$0.70/day). A regression in the completion sweep would either
 * (a) fail to unpin posts when GAs complete (UX bug) or (b) re-fire
 * ~368 unpins per cycle per completed GA forever (cost bug).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../lib/dynamodb', () => ({
  putItemIfAbsent: vi.fn(),
  queryItems: vi.fn(),
  docClient: { send: vi.fn() },
  tableNames: {
    users: 'test-users',
    drepCommittees: 'test-drep_committees',
    drepDirectory: 'test-drep_directory',
    governanceActions: 'test-governance_actions',
    governanceVotes: 'test-governance_votes',
    comments: 'test-comments',
    commentVotes: 'test-comment_votes',
    clubhousePosts: 'test-clubhouse_posts',
    auditLog: 'test-audit_log',
    authNonces: 'test-auth_nonces',
  },
}));

import { putItemIfAbsent, queryItems, docClient } from '../lib/dynamodb';
import {
  autoPostId,
  buildAutoPostBody,
  fanoutAutoPosts,
  selectCompletionSweepCandidates,
  selectFanoutCandidates,
  unpinAutoPostsForAction,
  activeDRepIds,
  AUTO_POST_AUTHOR_DISPLAY_NAME,
  AUTO_POST_AUTHOR_WALLET,
} from './clubhouseAutoPosts';
import type { DRepDirectoryItem, GovernanceActionItem } from '../lib/types';

const mockPutItemIfAbsent = vi.mocked(putItemIfAbsent);
const mockQueryItems = vi.mocked(queryItems);
const mockDocSend = vi.mocked(docClient.send);

const NOW = '2026-05-26T20:00:00.000Z';

function buildAction(overrides: Partial<GovernanceActionItem> = {}): GovernanceActionItem {
  return {
    actionId: 'abcd1234#0',
    SK: 'ACTION',
    actionType: 'InfoAction',
    description: 'desc',
    submittedAt: '2026-04-01T00:00:00.000Z',
    epochDeadline: 500,
    status: 'active',
    title: 'Test action title',
    summary: 'Stock summary',
    abstract: 'A detailed abstract about this governance action.',
    enrichmentVersion: 13,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPutItemIfAbsent.mockResolvedValue({ outcome: 'written' });
  mockQueryItems.mockResolvedValue({ items: [], count: 0 });
  mockDocSend.mockResolvedValue({} as never);
});

describe('autoPostId', () => {
  it('produces a deterministic id derived from the action id', () => {
    expect(autoPostId('abcd1234#0')).toBe('auto-ga#abcd1234#0');
    // Different action → different id.
    expect(autoPostId('ffff#9')).toBe('auto-ga#ffff#9');
  });
});

describe('buildAutoPostBody', () => {
  it('uses title + abstract when both present', () => {
    const { title, body } = buildAutoPostBody(
      buildAction({ title: 'My title', abstract: 'My abstract' }),
    );
    expect(title).toBe('My title');
    expect(body).toBe('My abstract');
  });

  it('falls back to summary then a stock body', () => {
    const { title, body } = buildAutoPostBody(
      buildAction({ title: undefined, abstract: undefined, summary: 'Synth summary' }),
    );
    expect(title).toBe('Synth summary');
    expect(body).toBe('Synth summary');
  });

  it('produces a stock fallback when neither title nor body sources are available', () => {
    const { title, body } = buildAutoPostBody(
      buildAction({
        title: undefined,
        abstract: undefined,
        summary: undefined,
        actionId: 'abcd1234#0',
      }),
    );
    expect(title).toContain('abcd1234#0');
    expect(body).toMatch(/governance action/i);
  });

  it('caps the title and body at safe lengths', () => {
    const big = 'x'.repeat(10_000);
    const { title, body } = buildAutoPostBody(buildAction({ title: big, abstract: big }));
    expect(title.length).toBeLessThanOrEqual(200);
    expect(body.length).toBeLessThanOrEqual(5_000);
    expect(title.endsWith('...')).toBe(true);
    expect(body.endsWith('...')).toBe(true);
  });
});

describe('fanoutAutoPosts', () => {
  it('writes one auto-post per DRep with the right shape', async () => {
    const action = buildAction();
    const drepIds = ['drep1', 'drep2', 'drep3'];

    const res = await fanoutAutoPosts({ action, drepIds, now: NOW });

    expect(res.written).toBe(3);
    expect(res.skipped).toBe(0);
    expect(res.errored).toBe(0);

    // Every call should land on the same table with the same conditional
    // Put key shape.
    expect(mockPutItemIfAbsent).toHaveBeenCalledTimes(3);
    const writtenItems = mockPutItemIfAbsent.mock.calls.map((c) => c[1]);
    const drepIdsWritten = writtenItems.map((it) => (it as { drepId: string }).drepId).sort();
    expect(drepIdsWritten).toEqual(['drep1', 'drep2', 'drep3']);

    // Pick one row and verify the canonical shape.
    const sample = writtenItems[0]! as Record<string, unknown>;
    expect(sample['postId']).toBe('auto-ga#abcd1234#0');
    expect(sample['type']).toBe('auto_ga');
    expect(sample['pinned']).toBe(true);
    expect(sample['isDRepPost']).toBe(false);
    expect(sample['authorWallet']).toBe(AUTO_POST_AUTHOR_WALLET);
    expect(sample['authorDisplayName']).toBe(AUTO_POST_AUTHOR_DISPLAY_NAME);
    expect(sample['linkedActionId']).toBe('abcd1234#0');
    expect(sample['title']).toBe('Test action title');
    expect(sample['body']).toBe('A detailed abstract about this governance action.');
    expect(sample['createdAt']).toBe(NOW);
    expect(sample['updatedAt']).toBe(NOW);
    // P0-3 Phase 6 (2026-05-28): the inline `comments: []` field is
    // no longer written on new post rows. The denormalized
    // `commentCount: 0` counter replaces it.
    expect(sample['comments']).toBeUndefined();
    expect(sample['commentCount']).toBe(0);

    // autoSource shape — abstractFrozenAt MUST equal `now` (frozen at
    // this row's creation moment).
    const autoSource = sample['autoSource'] as Record<string, unknown>;
    expect(autoSource).toBeDefined();
    expect(autoSource['kind']).toBe('governance_action');
    expect(autoSource['actionId']).toBe('abcd1234#0');
    expect(autoSource['abstractFrozenAt']).toBe(NOW);
  });

  it('idempotency: skipped writes are counted but do not error', async () => {
    // Mock returns "skipped" for all calls — simulates a re-run where
    // every (drep, action) pair already has a row.
    mockPutItemIfAbsent.mockResolvedValue({ outcome: 'skipped' });
    const action = buildAction();
    const drepIds = ['drep1', 'drep2'];

    const res = await fanoutAutoPosts({ action, drepIds, now: NOW });

    expect(res.written).toBe(0);
    expect(res.skipped).toBe(2);
    expect(res.errored).toBe(0);
    // Still attempted both writes — the helper doesn't pre-check; the
    // conditional Put IS the dedupe.
    expect(mockPutItemIfAbsent).toHaveBeenCalledTimes(2);
  });

  it('records errored writes without throwing', async () => {
    mockPutItemIfAbsent
      .mockResolvedValueOnce({ outcome: 'written' })
      .mockResolvedValueOnce({ outcome: 'errored', error: new Error('DDB transport') });

    const action = buildAction();
    const drepIds = ['drep1', 'drep2'];

    const res = await fanoutAutoPosts({ action, drepIds, now: NOW });

    expect(res.written).toBe(1);
    expect(res.skipped).toBe(0);
    expect(res.errored).toBe(1);
  });

  it('uses the deterministic postId (same id reused across DReps for one GA)', async () => {
    const action = buildAction({ actionId: 'xx#7' });
    await fanoutAutoPosts({ action, drepIds: ['a', 'b'], now: NOW });
    const items = mockPutItemIfAbsent.mock.calls.map((c) => c[1] as Record<string, unknown>);
    // Both rows share the postId — the (drepId, postId) PK distinguishes
    // them across clubhouses.
    expect(items[0]!['postId']).toBe('auto-ga#xx#7');
    expect(items[1]!['postId']).toBe('auto-ga#xx#7');
  });

  it('handles an empty DRep list as a no-op', async () => {
    const res = await fanoutAutoPosts({
      action: buildAction(),
      drepIds: [],
      now: NOW,
    });
    expect(res).toEqual({ written: 0, skipped: 0, errored: 0 });
    expect(mockPutItemIfAbsent).not.toHaveBeenCalled();
  });

  it('frozen body: re-running with a different "now" does not change rows that already exist', async () => {
    // First call writes — outcome: 'written'.
    const action = buildAction();
    await fanoutAutoPosts({ action, drepIds: ['drep1'], now: '2026-05-26T20:00:00.000Z' });
    expect(mockPutItemIfAbsent).toHaveBeenCalledTimes(1);

    // Second call would target the same row. The conditional Put would
    // fail in real DDB; the mock returns 'skipped' to model that. No
    // update happens — the existing row keeps its frozen `abstractFrozenAt`.
    mockPutItemIfAbsent.mockResolvedValueOnce({ outcome: 'skipped' });
    const res2 = await fanoutAutoPosts({
      action,
      drepIds: ['drep1'],
      now: '2026-05-30T20:00:00.000Z', // 4 days later
    });
    expect(res2.written).toBe(0);
    expect(res2.skipped).toBe(1);
    // The mock was called with the new timestamps in the would-be row,
    // but the conditional rejected — the existing row's frozen-at is
    // preserved.
    const secondCallItem = mockPutItemIfAbsent.mock.calls[1]![1] as Record<string, unknown>;
    const autoSource = secondCallItem['autoSource'] as Record<string, unknown>;
    expect(autoSource['abstractFrozenAt']).toBe('2026-05-30T20:00:00.000Z');
    // The fact that this attempt was 'skipped' (per the mock) is what
    // protects the real DDB row's frozen-at. Caller's responsibility:
    // do NOT add an "if (skipped) putItem" path.
  });
});

describe('selectCompletionSweepCandidates', () => {
  it('emits actions that transitioned from active → enacted', () => {
    const pairs = [
      {
        actionId: 'a#0',
        previous: buildAction({ actionId: 'a#0', status: 'active' }),
        next: buildAction({ actionId: 'a#0', status: 'enacted' }),
      },
    ];
    const candidates = selectCompletionSweepCandidates(pairs);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.actionId).toBe('a#0');
    expect(candidates[0]!.previousStatus).toBe('active');
    expect(candidates[0]!.nextStatus).toBe('enacted');
  });

  it('emits actions that transitioned from active → expired and from active → dropped', () => {
    const pairs = [
      {
        actionId: 'a#0',
        previous: buildAction({ actionId: 'a#0', status: 'active' }),
        next: buildAction({ actionId: 'a#0', status: 'expired' }),
      },
      {
        actionId: 'b#0',
        previous: buildAction({ actionId: 'b#0', status: 'active' }),
        next: buildAction({ actionId: 'b#0', status: 'dropped' }),
      },
    ];
    const candidates = selectCompletionSweepCandidates(pairs);
    expect(candidates).toHaveLength(2);
  });

  it('IGNORES actions that were already completed last cycle (avoid re-firing the sweep)', () => {
    // GA was `enacted` last cycle, still `enacted` this cycle. Do NOT
    // re-fire the sweep — it already ran when the row first transitioned.
    const pairs = [
      {
        actionId: 'a#0',
        previous: buildAction({ actionId: 'a#0', status: 'enacted' }),
        next: buildAction({ actionId: 'a#0', status: 'enacted' }),
      },
    ];
    expect(selectCompletionSweepCandidates(pairs)).toHaveLength(0);
  });

  it('ignores transitions BETWEEN completed states (expired → enacted shouldn\'t happen, but guard anyway)', () => {
    const pairs = [
      {
        actionId: 'a#0',
        previous: buildAction({ actionId: 'a#0', status: 'expired' }),
        next: buildAction({ actionId: 'a#0', status: 'enacted' }),
      },
    ];
    expect(selectCompletionSweepCandidates(pairs)).toHaveLength(0);
  });

  it('ignores active → active (no transition)', () => {
    const pairs = [
      {
        actionId: 'a#0',
        previous: buildAction({ actionId: 'a#0', status: 'active' }),
        next: buildAction({ actionId: 'a#0', status: 'active' }),
      },
    ];
    expect(selectCompletionSweepCandidates(pairs)).toHaveLength(0);
  });

  it('SKIPS a brand-new GA that lands ALREADY-completed (no previous row) — SEC-2 born-completed guard', () => {
    // SEC-2 (2026-05-28): a GA discovered for the first time when
    // it's ALREADY in a completed state (`enacted`/`expired`/`dropped`)
    // skips the fan-out (handled in governance-intake's
    // `selectFanoutCandidates`), so there are no pinned auto-posts to
    // unpin. Running the sweep regardless would issue ~368 UpdateItem
    // calls against nonexistent post rows — wasted work and CloudWatch
    // noise. Pre-SEC-2 this fired; the comment in the previous version
    // of this test rationalized it as "in case a parallel fan-out
    // created posts" but the new fan-out gate makes that impossible.
    const pairs = [
      {
        actionId: 'a#0',
        previous: undefined,
        next: buildAction({ actionId: 'a#0', status: 'expired' }),
      },
    ];
    expect(selectCompletionSweepCandidates(pairs)).toHaveLength(0);
  });

  it('SKIPS a born-completed GA across all three completed statuses', () => {
    // Coverage matrix — every completed status should follow the same
    // born-completed skip rule.
    for (const status of ['enacted', 'expired', 'dropped']) {
      const pairs = [
        {
          actionId: 'a#0',
          previous: undefined,
          next: buildAction({ actionId: 'a#0', status: status as 'enacted' }),
        },
      ];
      expect(selectCompletionSweepCandidates(pairs)).toHaveLength(0);
    }
  });
});

describe('selectFanoutCandidates', () => {
  it('passes through new active GAs unchanged (the common case)', () => {
    const active = buildAction({ actionId: 'a#0', status: 'active' });
    expect(selectFanoutCandidates([active])).toEqual([active]);
  });

  it('SKIPS new GAs that are born-completed (enacted/expired/dropped)', () => {
    // Cold-start / late-discovery scenario: a GA the sync sees for
    // the first time when its lifecycle is already finished. Fanning
    // out ~368 pinned auto-posts that nobody can see (they'd be
    // unpinned immediately) is ~736 wasted DDB writes per GA plus
    // CloudWatch noise. SEC-2 (2026-05-28): we skip these.
    expect(
      selectFanoutCandidates([
        buildAction({ actionId: 'a#0', status: 'enacted' }),
      ]),
    ).toEqual([]);
    expect(
      selectFanoutCandidates([
        buildAction({ actionId: 'b#0', status: 'expired' }),
      ]),
    ).toEqual([]);
    expect(
      selectFanoutCandidates([
        buildAction({ actionId: 'c#0', status: 'dropped' }),
      ]),
    ).toEqual([]);
  });

  it('mixes: keeps active ones, drops born-completed ones (preserves input order)', () => {
    // The full GovernanceActionStatus enum is
    // `'active' | 'expired' | 'enacted' | 'dropped'`. `active` is the
    // only non-completed value. The filter must drop the three
    // completed statuses while keeping order on the rest.
    const list = [
      buildAction({ actionId: 'a#0', status: 'active' }),
      buildAction({ actionId: 'b#0', status: 'expired' }),
      buildAction({ actionId: 'c#0', status: 'active' }),
      buildAction({ actionId: 'd#0', status: 'enacted' }),
      buildAction({ actionId: 'e#0', status: 'dropped' }),
      buildAction({ actionId: 'f#0', status: 'active' }),
    ];
    const out = selectFanoutCandidates(list);
    expect(out.map((g) => g.actionId)).toEqual(['a#0', 'c#0', 'f#0']);
  });

  it('empty list → empty list', () => {
    expect(selectFanoutCandidates([])).toEqual([]);
  });
});

describe('unpinAutoPostsForAction', () => {
  it('flips pinned=false on every row returned by the GSI query', async () => {
    mockQueryItems.mockResolvedValueOnce({
      items: [
        { drepId: 'drep1', postId: 'auto-ga#a#0' } as never,
        { drepId: 'drep2', postId: 'auto-ga#a#0' } as never,
        { drepId: 'drep3', postId: 'auto-ga#a#0' } as never,
      ],
      count: 3,
    });

    const res = await unpinAutoPostsForAction('a#0');

    expect(res.unpinned).toBe(3);
    expect(res.errored).toBe(0);
    expect(mockDocSend).toHaveBeenCalledTimes(3);

    // First UpdateCommand should target the right table+key with
    // pinned=false and a fresh updatedAt. Cast through `unknown` because
    // the @aws-sdk Command class is a generic over hard-to-narrow service
    // shapes; we know what we built locally so this is safe.
    const firstCall = mockDocSend.mock.calls[0]![0] as unknown as {
      input: {
        TableName: string;
        Key: { drepId: string; postId: string };
        UpdateExpression: string;
        ExpressionAttributeValues: { ':false': boolean; ':now': string };
      };
    };
    expect(firstCall.input.TableName).toBe('test-clubhouse_posts');
    expect(firstCall.input.Key.drepId).toBe('drep1');
    expect(firstCall.input.Key.postId).toBe('auto-ga#a#0');
    expect(firstCall.input.UpdateExpression).toMatch(/SET/);
    expect(firstCall.input.ExpressionAttributeValues[':false']).toBe(false);
  });

  it('handles a multi-page GSI result via the lastEvaluatedKey cursor', async () => {
    // First page returns 2 items + a cursor; second page returns 1
    // item + no cursor.
    mockQueryItems
      .mockResolvedValueOnce({
        items: [
          { drepId: 'drep1', postId: 'auto-ga#a#0' } as never,
          { drepId: 'drep2', postId: 'auto-ga#a#0' } as never,
        ],
        lastEvaluatedKey: { drepId: 'drep2' },
        count: 2,
      })
      .mockResolvedValueOnce({
        items: [{ drepId: 'drep3', postId: 'auto-ga#a#0' } as never],
        count: 1,
      });

    const res = await unpinAutoPostsForAction('a#0');
    expect(res.unpinned).toBe(3);
    expect(mockQueryItems).toHaveBeenCalledTimes(2);
  });

  it('counts errored updates and continues with the remaining rows', async () => {
    mockQueryItems.mockResolvedValueOnce({
      items: [
        { drepId: 'drep1', postId: 'auto-ga#a#0' } as never,
        { drepId: 'drep2', postId: 'auto-ga#a#0' } as never,
      ],
      count: 2,
    });
    mockDocSend
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({} as never);

    const res = await unpinAutoPostsForAction('a#0');
    expect(res.unpinned).toBe(1);
    expect(res.errored).toBe(1);
  });

  it('empty result → no-op (no updates)', async () => {
    mockQueryItems.mockResolvedValueOnce({ items: [], count: 0 });
    const res = await unpinAutoPostsForAction('a#0');
    expect(res).toEqual({ unpinned: 0, errored: 0 });
    expect(mockDocSend).not.toHaveBeenCalled();
  });
});

describe('activeDRepIds', () => {
  it('returns the IDs of active DReps, skipping inactive/retired', () => {
    const rows = [
      { drepId: 'a', isActive: true } as DRepDirectoryItem,
      { drepId: 'b', isActive: false } as DRepDirectoryItem,
      { drepId: 'c', isActive: true } as DRepDirectoryItem,
    ];
    expect(activeDRepIds(rows)).toEqual(['a', 'c']);
  });
});
