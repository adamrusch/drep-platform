/**
 * Tests for `getVotesForAction`'s historical-voting-power lookup
 * (Issue #12, Batch D).
 *
 * The Votes tab used to render each DRep voter's CURRENT voting power
 * (joined from `drep_directory.PROFILE`). That's misleading for a vote
 * cast many epochs ago by a DRep whose power has changed since. The
 * new path joins per-epoch `POWER#{padded epoch}` snapshots written by
 * the daily `drep-voting-power-history` sync, falling back to current
 * power with `votingPowerIsApprox: true` when the historical row is
 * absent.
 *
 * # Invariants under test
 *
 *   1. DRep voter + POWER#{epoch} present → uses historical snapshot,
 *      `votingPowerIsApprox` undefined.
 *   2. DRep voter + POWER#{epoch} absent + PROFILE present → uses
 *      current `votingPower`, `votingPowerIsApprox === true`.
 *   3. DRep voter + neither PROFILE nor POWER → no
 *      `votingPowerLovelace`, no `votingPowerIsApprox`.
 *   4. SPO + CC voters → no `votingPowerLovelace` regardless of any
 *      directory state (the directory only covers DReps).
 *   5. POWER lookup uses the correct zero-padded SK matching what the
 *      `drep-voting-power-history` sync writes (`POWER#000515` for
 *      epoch 515).
 *   6. The BatchGet that fetches PROFILE + POWER rows is exactly one
 *      call (the helper internally chunks, but the test mock sees a
 *      single invocation with all keys merged).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mocks must precede SUT import — vi.mock is hoisted.
vi.mock('./dynamodb', () => ({
  batchGetItems: vi.fn(),
  queryItems: vi.fn(),
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

// Stub the SPO + CC name helpers — those have their own tests and we
// don't want this file's coverage to include unrelated lookups.
vi.mock('./recognition', () => ({
  getPoolNamesBulk: vi.fn(async () => new Map()),
  getCCMemberNamesBulk: vi.fn(async () => new Map()),
}));

import { batchGetItems, queryItems } from './dynamodb';
import { getVotesForAction, type GovernanceVoteItem } from './votes';

const mockBatchGet = vi.mocked(batchGetItems);
const mockQuery = vi.mocked(queryItems);

const ACTION_ID = 'tx_abc#0';
const DREP_A = 'drep1abc';
const DREP_B = 'drep1xyz';

/** Helper — one persisted vote row. */
function vote(overrides: Partial<GovernanceVoteItem>): GovernanceVoteItem {
  return {
    actionId: ACTION_ID,
    voteKey: 'DRep#drep1abc#vote1',
    voterRole: 'DRep',
    voterId: DREP_A,
    vote: 'Yes',
    votedAt: '2026-05-01T00:00:00.000Z',
    blockTime: 1_700_000_000,
    epochNo: 515,
    voteTxHash: 'vote1',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default to "no votes" — tests override per case.
  mockQuery.mockResolvedValue({ items: [], count: 0 });
  mockBatchGet.mockResolvedValue([]);
});

describe('getVotesForAction — historical voting power', () => {
  it('uses the historical POWER snapshot when present', async () => {
    mockQuery.mockResolvedValue({
      items: [vote({ voterId: DREP_A, epochNo: 515, voteTxHash: 'v1' })],
      count: 1,
    });
    mockBatchGet.mockResolvedValue([
      // PROFILE: current power is 999B (irrelevant — snapshot wins).
      {
        drepId: DREP_A,
        SK: 'PROFILE',
        votingPower: '999000000000000',
        givenName: 'DRep A',
      },
      // POWER snapshot for epoch 515: 5 billion.
      {
        drepId: DREP_A,
        SK: 'POWER#000515',
        epochNo: 515,
        amount: '5000000000000',
        capturedAt: '2026-04-30T02:00:00.000Z',
      },
    ]);

    const out = await getVotesForAction(ACTION_ID);

    expect(out).toHaveLength(1);
    expect(out[0]!.votingPowerLovelace).toBe('5000000000000');
    expect(out[0]!.votingPowerIsApprox).toBeUndefined();
    expect(out[0]!.voterDisplayName).toBe('DRep A');
  });

  it('falls back to current power + isApprox when POWER row is absent', async () => {
    mockQuery.mockResolvedValue({
      items: [vote({ voterId: DREP_A, epochNo: 510, voteTxHash: 'v1' })],
      count: 1,
    });
    // Only PROFILE — no POWER#000510 row.
    mockBatchGet.mockResolvedValue([
      {
        drepId: DREP_A,
        SK: 'PROFILE',
        votingPower: '7500000000000',
        givenName: 'DRep A',
      },
    ]);

    const out = await getVotesForAction(ACTION_ID);

    expect(out).toHaveLength(1);
    expect(out[0]!.votingPowerLovelace).toBe('7500000000000');
    expect(out[0]!.votingPowerIsApprox).toBe(true);
  });

  it('omits both fields when PROFILE and POWER are both missing', async () => {
    mockQuery.mockResolvedValue({
      items: [vote({ voterId: DREP_A, voteTxHash: 'v1' })],
      count: 1,
    });
    // Directory returns nothing — DRep not in cache.
    mockBatchGet.mockResolvedValue([]);

    const out = await getVotesForAction(ACTION_ID);

    expect(out).toHaveLength(1);
    expect(out[0]!.votingPowerLovelace).toBeUndefined();
    expect(out[0]!.votingPowerIsApprox).toBeUndefined();
  });

  it('handles per-DRep mixed state (POWER hit for one, miss for another)', async () => {
    mockQuery.mockResolvedValue({
      items: [
        vote({ voterId: DREP_A, epochNo: 515, voteTxHash: 'a1' }),
        vote({ voterId: DREP_B, epochNo: 510, voteTxHash: 'b1', blockTime: 1_699_000_000 }),
      ],
      count: 2,
    });
    mockBatchGet.mockResolvedValue([
      {
        drepId: DREP_A,
        SK: 'PROFILE',
        votingPower: '999000000000000',
        givenName: 'DRep A',
      },
      {
        drepId: DREP_A,
        SK: 'POWER#000515',
        epochNo: 515,
        amount: '5000000000000',
      },
      {
        drepId: DREP_B,
        SK: 'PROFILE',
        votingPower: '888000000000000',
        givenName: 'DRep B',
      },
      // No POWER row for DREP_B → fallback to current.
    ]);

    const out = await getVotesForAction(ACTION_ID);
    // Newest first by blockTime — DREP_A's vote sorted first.
    expect(out).toHaveLength(2);
    const a = out.find((r) => r.voterId === DREP_A)!;
    const b = out.find((r) => r.voterId === DREP_B)!;
    expect(a.votingPowerLovelace).toBe('5000000000000');
    expect(a.votingPowerIsApprox).toBeUndefined();
    expect(b.votingPowerLovelace).toBe('888000000000000');
    expect(b.votingPowerIsApprox).toBe(true);
  });

  it('omits voting power entirely for SPO and CC voters', async () => {
    mockQuery.mockResolvedValue({
      items: [
        vote({
          voterRole: 'SPO',
          voterId: 'pool1xxx',
          voteTxHash: 's1',
          epochNo: 515,
        }),
        vote({
          voterRole: 'ConstitutionalCommittee',
          voterId: 'cc_hot_xxx',
          voteTxHash: 'c1',
          epochNo: 515,
        }),
      ],
      count: 2,
    });
    // Directory has rows for the IDs — should NOT be joined since
    // they aren't DRep voters.
    mockBatchGet.mockResolvedValue([]);

    const out = await getVotesForAction(ACTION_ID);

    expect(out).toHaveLength(2);
    for (const row of out) {
      expect(row.votingPowerLovelace).toBeUndefined();
      expect(row.votingPowerIsApprox).toBeUndefined();
    }
  });

  it('builds the POWER SK with the correct zero-padded epoch', async () => {
    mockQuery.mockResolvedValue({
      items: [
        vote({ voterId: DREP_A, epochNo: 7, voteTxHash: 'v1' }),
        vote({ voterId: DREP_B, epochNo: 12345, voteTxHash: 'v2' }),
      ],
      count: 2,
    });
    mockBatchGet.mockResolvedValue([]);

    await getVotesForAction(ACTION_ID);

    expect(mockBatchGet).toHaveBeenCalledTimes(1);
    const keys = mockBatchGet.mock.calls[0]![1] as Array<Record<string, unknown>>;
    // PROFILE keys + POWER keys are merged in one BatchGet call.
    const skList = keys.map((k) => k['SK']);
    expect(skList).toContain('PROFILE');
    // Padded width 6 — epoch 7 → 000007, epoch 12345 → 012345.
    expect(skList).toContain('POWER#000007');
    expect(skList).toContain('POWER#012345');
  });

  it('issues ONE merged BatchGet for PROFILE + POWER keys', async () => {
    mockQuery.mockResolvedValue({
      items: [
        vote({ voterId: DREP_A, epochNo: 515, voteTxHash: 'a1' }),
        vote({ voterId: DREP_B, epochNo: 510, voteTxHash: 'b1' }),
      ],
      count: 2,
    });
    mockBatchGet.mockResolvedValue([]);

    await getVotesForAction(ACTION_ID);

    expect(mockBatchGet).toHaveBeenCalledTimes(1);
    // 2 DReps × (1 PROFILE + 1 POWER) = 4 keys in the single call.
    const keys = mockBatchGet.mock.calls[0]![1] as Array<Record<string, unknown>>;
    expect(keys).toHaveLength(4);
  });

  it('dedupes POWER keys when the same DRep voted in the same epoch twice', async () => {
    // Vote-then-recast scenario: same DRep, same epoch, two rows. We
    // should still only request ONE POWER#{epoch} key.
    mockQuery.mockResolvedValue({
      items: [
        vote({ voterId: DREP_A, epochNo: 515, voteTxHash: 'old', blockTime: 100 }),
        vote({ voterId: DREP_A, epochNo: 515, voteTxHash: 'new', blockTime: 200 }),
      ],
      count: 2,
    });
    mockBatchGet.mockResolvedValue([]);

    await getVotesForAction(ACTION_ID);

    const keys = mockBatchGet.mock.calls[0]![1] as Array<Record<string, unknown>>;
    const powerKeys = keys.filter((k) =>
      typeof k['SK'] === 'string' && (k['SK'] as string).startsWith('POWER#'),
    );
    expect(powerKeys).toHaveLength(1); // deduped
    expect(powerKeys[0]!['SK']).toBe('POWER#000515');
  });
});
