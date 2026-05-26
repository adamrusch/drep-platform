/**
 * Tests for the supersede / strikethrough dedupe rule.
 *
 * The rule is load-bearing for the Votes tab UX: Cardano allows a voter
 * to recast their vote on the same action, and the ledger keeps only the
 * most recent one as authoritative. The UI shows the full audit trail
 * (so a delegator can see "my DRep changed their mind"), but only the
 * latest vote per voter is "live"; everything earlier is rendered with
 * `line-through`.
 *
 * Invariants under test:
 *   1. Newest vote per (voterRole, voterId) is `superseded: false`.
 *   2. Every other vote by that same voter is `superseded: true`.
 *   3. Different voters do NOT supersede each other (even when one
 *      cast a vote after another).
 *   4. Different action types from the same voter (same voterId but
 *      different voterRole — extremely unlikely but theoretically
 *      possible) are tracked independently.
 *   5. Output is sorted newest-first by blockTime, with voteTxHash
 *      desc as the tie-break.
 *   6. Tie on identical blockTime: the row with the lexicographically
 *      larger voteTxHash wins (kept as live).
 */

import { describe, it, expect } from 'vitest';
import { markSupersededVotes, type GovernanceVoteItem } from './votes';

function row(overrides: Partial<GovernanceVoteItem>): GovernanceVoteItem {
  return {
    actionId: 'tx#0',
    voteKey: 'DRep#drep1abc#vote1',
    voterRole: 'DRep',
    voterId: 'drep1abc',
    vote: 'Yes',
    votedAt: '2026-01-01T00:00:00.000Z',
    blockTime: 1_700_000_000,
    epochNo: 500,
    voteTxHash: 'vote1',
    ...overrides,
  };
}

describe('markSupersededVotes', () => {
  it('returns an empty array when given no rows', () => {
    expect(markSupersededVotes([])).toEqual([]);
  });

  it('marks no rows as superseded when each voter voted once', () => {
    const result = markSupersededVotes([
      row({ voterId: 'drep1a', voteTxHash: 'tx_a', blockTime: 100 }),
      row({ voterId: 'drep1b', voteTxHash: 'tx_b', blockTime: 200 }),
      row({ voterId: 'drep1c', voteTxHash: 'tx_c', blockTime: 50 }),
    ]);
    expect(result.map((r) => ({ voterId: r.voterId, superseded: r.superseded }))).toEqual([
      { voterId: 'drep1b', superseded: false },
      { voterId: 'drep1a', superseded: false },
      { voterId: 'drep1c', superseded: false },
    ]);
  });

  it('keeps only the newest vote per voter live, marks older ones superseded', () => {
    const result = markSupersededVotes([
      row({ voterId: 'drep1a', vote: 'Yes', voteTxHash: 'old', blockTime: 100 }),
      row({ voterId: 'drep1a', vote: 'No', voteTxHash: 'new', blockTime: 200 }),
    ]);
    // Newest first
    expect(result[0]!.voteTxHash).toBe('new');
    expect(result[0]!.superseded).toBe(false);
    expect(result[1]!.voteTxHash).toBe('old');
    expect(result[1]!.superseded).toBe(true);
  });

  it('handles three votes by the same voter — only the newest is live', () => {
    const result = markSupersededVotes([
      row({ voterId: 'drep1a', voteTxHash: 'v1', blockTime: 100 }),
      row({ voterId: 'drep1a', voteTxHash: 'v3', blockTime: 300 }),
      row({ voterId: 'drep1a', voteTxHash: 'v2', blockTime: 200 }),
    ]);
    expect(result.map((r) => r.voteTxHash)).toEqual(['v3', 'v2', 'v1']);
    expect(result.map((r) => r.superseded)).toEqual([false, true, true]);
  });

  it('does not cross-supersede different voters', () => {
    const result = markSupersededVotes([
      row({ voterId: 'drep1a', voteTxHash: 'a1', blockTime: 100 }),
      row({ voterId: 'drep1b', voteTxHash: 'b1', blockTime: 200 }),
      row({ voterId: 'drep1a', voteTxHash: 'a2', blockTime: 300 }),
    ]);
    // Sorted newest-first
    expect(result.map((r) => r.voteTxHash)).toEqual(['a2', 'b1', 'a1']);
    // a2 (newest a vote) and b1 are live; a1 is superseded
    expect(result.map((r) => r.superseded)).toEqual([false, false, true]);
  });

  it('treats the same voterId under different roles as independent voters', () => {
    // Extremely unlikely on mainnet — a single bech32 ID is normally
    // unique to one role — but the supersede key is composite so the
    // behaviour is well-defined either way.
    const result = markSupersededVotes([
      row({ voterRole: 'DRep', voterId: 'shared_id', voteTxHash: 'd1', blockTime: 100 }),
      row({ voterRole: 'SPO', voterId: 'shared_id', voteTxHash: 's1', blockTime: 200 }),
    ]);
    // Both are live — different role buckets.
    expect(result.every((r) => !r.superseded)).toBe(true);
  });

  it('tie-breaks identical blockTime on voteTxHash desc', () => {
    const result = markSupersededVotes([
      row({ voterId: 'drep1a', voteTxHash: 'aaa', blockTime: 100 }),
      row({ voterId: 'drep1a', voteTxHash: 'zzz', blockTime: 100 }),
    ]);
    // zzz > aaa lexicographically, so zzz wins as the live one.
    expect(result[0]!.voteTxHash).toBe('zzz');
    expect(result[0]!.superseded).toBe(false);
    expect(result[1]!.voteTxHash).toBe('aaa');
    expect(result[1]!.superseded).toBe(true);
  });

  it('does not mutate the input array', () => {
    const input: GovernanceVoteItem[] = [
      row({ voterId: 'drep1a', voteTxHash: 'a1', blockTime: 100 }),
      row({ voterId: 'drep1a', voteTxHash: 'a2', blockTime: 200 }),
    ];
    const before = input.map((r) => r.voteTxHash);
    markSupersededVotes(input);
    const after = input.map((r) => r.voteTxHash);
    expect(after).toEqual(before);
  });
});
