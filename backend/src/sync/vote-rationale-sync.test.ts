import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/dynamodb', () => ({
  queryItems: vi.fn(),
  updateItem: vi.fn().mockResolvedValue(undefined),
  tableNames: {
    governanceActions: 'test-governance_actions',
    governanceVotes: 'test-governance_votes',
  },
}));

import { queryItems, updateItem } from '../lib/dynamodb';
import { runVoteRationaleSync } from './vote-rationale-sync';
import type { VoteRationaleResult } from '../lib/voteRationale';

const mockQuery = vi.mocked(queryItems);
const mockUpdate = vi.mocked(updateItem);

const NOW = Date.parse('2026-06-05T12:00:00Z');

/** Wire queryItems to serve active actions then per-action votes. */
function wireQueries(actionIds: string[], votesByAction: Record<string, unknown[]>) {
  mockQuery.mockImplementation(async (_table: string, opts: { indexName?: string; expressionAttributeValues: Record<string, unknown> }) => {
    if (opts.indexName === 'status-submittedAt-index') {
      return { items: actionIds.map((actionId) => ({ actionId })), count: actionIds.length } as never;
    }
    const a = opts.expressionAttributeValues[':a'] as string;
    const items = votesByAction[a] ?? [];
    return { items, count: items.length } as never;
  });
}

beforeEach(() => {
  mockQuery.mockReset();
  mockUpdate.mockReset();
  mockUpdate.mockResolvedValue(undefined);
});

describe('runVoteRationaleSync', () => {
  it('processes only un-cached anchored votes and writes the result', async () => {
    wireQueries(['act1#0'], {
      'act1#0': [
        { actionId: 'act1#0', voteKey: 'DRep#d1#tx1', metaUrl: 'ipfs://Qm1', metaHash: 'h1' }, // new → process
        { actionId: 'act1#0', voteKey: 'DRep#d2#tx2', metaUrl: 'ipfs://Qm2', metaHash: 'h2', rationaleStatus: 'cached', rationaleAnchorUrl: 'ipfs://Qm2' }, // terminal → skip
        { actionId: 'act1#0', voteKey: 'SPO#p1#tx3' }, // no metaUrl → not anchored (wouldn't be returned, but guard anyway)
      ],
    });
    const fetchFn = vi.fn(async (): Promise<VoteRationaleResult> => ({ status: 'cached', title: 'T', text: 'hi', hashMatch: true }));

    const stats = await runVoteRationaleSync({ now: NOW, fetchFn });

    expect(stats.activeActions).toBe(1);
    expect(stats.candidates).toBe(1);
    expect(stats.fetched).toBe(1);
    expect(stats.cached).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith('ipfs://Qm1', 'h1');
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    // The update SETs status/text/title and targets the right row.
    const [, key, expr, , values] = mockUpdate.mock.calls[0]!;
    expect(key).toEqual({ actionId: 'act1#0', voteKey: 'DRep#d1#tx1' });
    expect(expr).toContain('SET');
    expect(values[':rs']).toBe('cached');
    expect(values[':rt']).toBe('hi');
  });

  it('retries a stale unreachable vote but skips a fresh one', async () => {
    const stale = new Date(NOW - 7 * 60 * 60 * 1000).toISOString(); // 7h ago > 6h retry
    const fresh = new Date(NOW - 1 * 60 * 60 * 1000).toISOString(); // 1h ago < 6h retry
    wireQueries(['act1#0'], {
      'act1#0': [
        { actionId: 'act1#0', voteKey: 'v-stale', metaUrl: 'ipfs://Qm', metaHash: 'h', rationaleStatus: 'unreachable', rationaleAnchorUrl: 'ipfs://Qm', rationaleFetchedAt: stale },
        { actionId: 'act1#0', voteKey: 'v-fresh', metaUrl: 'ipfs://Qm', metaHash: 'h', rationaleStatus: 'unreachable', rationaleAnchorUrl: 'ipfs://Qm', rationaleFetchedAt: fresh },
      ],
    });
    const fetchFn = vi.fn(async (): Promise<VoteRationaleResult> => ({ status: 'unreachable' }));

    const stats = await runVoteRationaleSync({ now: NOW, fetchFn });
    expect(stats.candidates).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(stats.unreachable).toBe(1);
  });

  it('REMOVEs optional fields when a result has no title/text (empty)', async () => {
    wireQueries(['act1#0'], {
      'act1#0': [{ actionId: 'act1#0', voteKey: 'v1', metaUrl: 'ipfs://Qm', metaHash: 'h' }],
    });
    const fetchFn = vi.fn(async (): Promise<VoteRationaleResult> => ({ status: 'empty' }));

    await runVoteRationaleSync({ now: NOW, fetchFn });
    const [, , expr] = mockUpdate.mock.calls[0]!;
    expect(expr).toContain('REMOVE');
    expect(expr).toContain('#rt'); // rationaleText removed
  });

  it('caps the number of fetches per run and reports capped=true', async () => {
    const votes = Array.from({ length: 5 }, (_, i) => ({
      actionId: 'act1#0', voteKey: `v${i}`, metaUrl: 'ipfs://Qm', metaHash: 'h',
    }));
    wireQueries(['act1#0'], { 'act1#0': votes });
    const fetchFn = vi.fn(async (): Promise<VoteRationaleResult> => ({ status: 'cached', text: 'x' }));

    const stats = await runVoteRationaleSync({ now: NOW, fetchFn, maxFetches: 2 });
    expect(stats.candidates).toBe(5);
    expect(stats.fetched).toBe(2);
    expect(stats.capped).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('does nothing when there are no active actions', async () => {
    wireQueries([], {});
    const fetchFn = vi.fn();
    const stats = await runVoteRationaleSync({ now: NOW, fetchFn });
    expect(stats.activeActions).toBe(0);
    expect(stats.fetched).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
