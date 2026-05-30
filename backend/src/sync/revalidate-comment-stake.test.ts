/**
 * Tests for the comment-vote stake re-validation sync (Batch REVAL,
 * 2026-05-29).
 *
 * # What we lock in
 *
 *   1. Re-weight math — `computeSupportDelta` is a pure function with
 *      4 axes (up/down × increase/decrease/zero/same). All covered.
 *   2. Emptied-wallet semantics — a wallet whose current stake reads as
 *      0 has its votes re-weighted DOWN to 0 contribution and the
 *      distinct `comment_vote.reweighted_emptied` audit event fires
 *      (Sybil signature).
 *   3. **CRITICAL**: never zero a wallet's votes when the Koios lookup
 *      failed. Covers three failure modes:
 *        - whole-batch throws (Koios outage)
 *        - wallet missing from batch response
 *        - malformed `total_balance` (non-string / empty / unparseable)
 *      In all three cases the per-vote rows are NOT touched, the
 *      registry is NOT advanced, and the counters surface the wallet
 *      as `walletsUpstreamFailures`.
 *   4. Idempotency — a second run with no stake changes does nothing
 *      (cheap-skip when `lastKnownStake === currentStake`).
 *   5. Empty registry — runs cleanly with zero work, fires the per-pass
 *      summary audit event.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../lib/koios', () => ({
  fetchAccountInfoBatch: vi.fn(),
  KoiosError: class KoiosError extends Error {
    public readonly status: number | undefined;
    public readonly endpoint: string;
    constructor(endpoint: string, message: string, status?: number) {
      super(`[Koios ${endpoint}] ${message}`);
      this.name = 'KoiosError';
      this.endpoint = endpoint;
      this.status = status;
    }
  },
}));

vi.mock('../lib/dynamodb', () => ({
  scanItems: vi.fn(),
  queryItems: vi.fn(),
  transactWrite: vi.fn(),
  updateItem: vi.fn(),
  tableNames: {
    comments: 'test-comments',
    commentVotes: 'test-comment_votes',
    commentVoters: 'test-comment_voters',
    auditLog: 'test-audit_log',
  },
}));

vi.mock('../lib/audit', () => ({
  writeAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

import { fetchAccountInfoBatch, KoiosError } from '../lib/koios';
import {
  scanItems,
  queryItems,
  transactWrite,
  updateItem,
} from '../lib/dynamodb';
import { writeAuditEvent } from '../lib/audit';
import {
  computeSupportDelta,
  runRevalidateCommentStake,
} from './revalidate-comment-stake';
import type { CommentVoterItem } from '../lib/types';

const mockFetchAccounts = vi.mocked(fetchAccountInfoBatch);
const mockScan = vi.mocked(scanItems);
const mockQuery = vi.mocked(queryItems);
const mockTransact = vi.mocked(transactWrite);
const mockUpdate = vi.mocked(updateItem);
const mockAudit = vi.mocked(writeAuditEvent);

const STAKE_A = 'stake1a';
const STAKE_B = 'stake1b';
const STAKE_C = 'stake1c';
const ACTION_ID = 'aaaa#0';
const COMMENT_ID = '01HXMHTEST123ABCDEF';
const COMMENT_ID_2 = '01HXMHTEST123ABCDXX';
const COMMENT_ID_3 = '01HXMHTEST123ABCDYY';

beforeEach(() => {
  vi.resetAllMocks();
  // Sensible defaults so most tests don't have to re-mock every call.
  mockScan.mockResolvedValue({ items: [], lastEvaluatedKey: undefined, count: 0 });
  mockQuery.mockResolvedValue({ items: [], lastEvaluatedKey: undefined, count: 0 });
  mockTransact.mockResolvedValue(undefined);
  mockUpdate.mockResolvedValue(undefined);
  mockAudit.mockResolvedValue(undefined);
});

function makeVoter(overrides: Partial<CommentVoterItem> = {}): CommentVoterItem {
  return {
    stakeAddress: STAKE_A,
    lastKnownStake: '1000000000', // 1k ADA
    lastCheckedAt: '2026-05-25T00:00:00.000Z',
    voteCount: 1,
    ...overrides,
  };
}

// ---- 1. Pure re-weight math ----

describe('computeSupportDelta — pure math', () => {
  it('upvote: stake INCREASE produces a positive support delta', () => {
    expect(computeSupportDelta('up', 1_000_000_000n, 2_000_000_000n)).toBe(
      1_000_000_000n,
    );
  });

  it('upvote: stake DECREASE produces a negative support delta', () => {
    expect(computeSupportDelta('up', 2_000_000_000n, 500_000_000n)).toBe(
      -1_500_000_000n,
    );
  });

  it('upvote: stake EMPTIED (→0) produces exactly -oldSnapshot', () => {
    expect(computeSupportDelta('up', 1_000_000_000n, 0n)).toBe(-1_000_000_000n);
  });

  it('downvote: stake INCREASE produces a negative support delta', () => {
    // More opposition: down × bigger stake → support tilts further down.
    expect(computeSupportDelta('down', 1_000_000_000n, 2_000_000_000n)).toBe(
      -1_000_000_000n,
    );
  });

  it('downvote: stake DECREASE produces a positive support delta', () => {
    // Less opposition: down × smaller stake → support recovers.
    expect(computeSupportDelta('down', 2_000_000_000n, 500_000_000n)).toBe(
      1_500_000_000n,
    );
  });

  it('downvote: stake EMPTIED (→0) produces exactly +oldSnapshot', () => {
    expect(computeSupportDelta('down', 1_000_000_000n, 0n)).toBe(1_000_000_000n);
  });

  it('idempotent: when newStake == oldSnapshot the delta is zero', () => {
    expect(computeSupportDelta('up', 1_000_000_000n, 1_000_000_000n)).toBe(0n);
    expect(computeSupportDelta('down', 1_000_000_000n, 1_000_000_000n)).toBe(0n);
  });
});

// ---- 2. Emptied-wallet semantics + Sybil-signature audit ----

describe('runRevalidateCommentStake — emptied wallet (Sybil signature)', () => {
  it('zeros a wallet whose stake dropped to 0 and fires the comment_vote.reweighted_emptied audit event', async () => {
    // Wallet A had 1M ADA when it voted; now its `total_balance` reads
    // as 0 (the attacker drained it between sweeps). The re-weight
    // pass must subtract the 1M contribution from the parent comment
    // and fire the distinct emptied-wallet audit event.
    mockScan.mockResolvedValueOnce({
      items: [makeVoter({ stakeAddress: STAKE_A, lastKnownStake: '1000000000000' })],
      lastEvaluatedKey: undefined,
      count: 1,
    });
    mockFetchAccounts.mockResolvedValueOnce([
      { stake_address: STAKE_A, total_balance: '0' } as never,
    ]);
    mockQuery.mockResolvedValueOnce({
      items: [
        {
          commentId: COMMENT_ID,
          stakeAddress: STAKE_A,
          vote: 'up',
          lovelace: '1000000000000',
          actionId: ACTION_ID,
        },
      ],
      lastEvaluatedKey: undefined,
      count: 1,
    });

    const result = await runRevalidateCommentStake();

    expect(result.walletsReweighted).toBe(1);
    expect(result.walletsEmptied).toBe(1);
    expect(result.votesReweighted).toBe(1);
    // Net delta = -1_000_000_000_000 (one upvote zeroed).
    expect(result.netSupportDelta).toBe('-1000000000000');

    // The re-weight transactWrite fired with the correct counter delta.
    expect(mockTransact).toHaveBeenCalledTimes(1);
    const items = mockTransact.mock.calls[0]![0] as Array<{
      Update?: {
        TableName: string;
        Key: Record<string, unknown>;
        ExpressionAttributeValues: Record<string, unknown>;
        UpdateExpression: string;
      };
    }>;
    expect(items).toHaveLength(2);
    const counterUpdate = items[0]!.Update!;
    expect(counterUpdate.TableName).toBe('test-comments');
    expect(counterUpdate.Key).toEqual({ actionId: ACTION_ID, commentId: COMMENT_ID });
    expect(counterUpdate.ExpressionAttributeValues[':delta']).toBe(
      -1_000_000_000_000n,
    );
    expect(typeof counterUpdate.ExpressionAttributeValues[':delta']).toBe('bigint');
    const voteUpdate = items[1]!.Update!;
    expect(voteUpdate.TableName).toBe('test-comment_votes');
    expect(voteUpdate.Key).toEqual({
      commentId: COMMENT_ID,
      stakeAddress: STAKE_A,
    });
    expect(voteUpdate.ExpressionAttributeValues[':s']).toBe('0');

    // The distinct emptied-wallet audit event fired.
    const emptiedCall = mockAudit.mock.calls.find(
      (c) => (c[0] as { eventType?: string }).eventType === 'comment_vote.reweighted_emptied',
    );
    expect(emptiedCall).toBeDefined();
    const emptiedInput = emptiedCall![0] as {
      entityId: string;
      metadata: Record<string, unknown>;
    };
    expect(emptiedInput.entityId).toBe(STAKE_A);
    expect(emptiedInput.metadata['priorStake']).toBe('1000000000000');
    expect(emptiedInput.metadata['currentStake']).toBe('0');
    expect(emptiedInput.metadata['votesAffected']).toBe(1);

    // The per-vote re-weight audit also fired (not the emptied
    // variant — the per-vote variant).
    const reweightCall = mockAudit.mock.calls.find(
      (c) => (c[0] as { eventType?: string }).eventType === 'comment_vote.reweighted',
    );
    expect(reweightCall).toBeDefined();

    // Registry was advanced.
    expect(mockUpdate).toHaveBeenCalledWith(
      'test-comment_voters',
      { stakeAddress: STAKE_A },
      expect.stringContaining('SET'),
      expect.objectContaining({ '#lastKnownStake': 'lastKnownStake' }),
      expect.objectContaining({ ':s': '0' }),
    );
  });
});

// ---- 3. CRITICAL: never zero on Koios lookup failure ----

describe('runRevalidateCommentStake — CRITICAL: never zero on upstream failure', () => {
  it("never zeros a wallet's votes when the Koios batch THROWS (Koios outage)", async () => {
    // Wallet A is in the registry; Koios is unreachable. The pass
    // MUST NOT touch any of A's votes — a Koios outage cannot wipe
    // vote weight. This is the load-bearing correctness invariant.
    mockScan.mockResolvedValueOnce({
      items: [makeVoter({ stakeAddress: STAKE_A, lastKnownStake: '1000000000000' })],
      lastEvaluatedKey: undefined,
      count: 1,
    });
    mockFetchAccounts.mockRejectedValueOnce(
      new KoiosError('/account_info_cached', 'connection refused', 503),
    );
    // Silence the expected `console.warn`.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await runRevalidateCommentStake();

    // The wallet was scanned but NOT checked (the batch threw before
    // any per-wallet processing). The upstream-failure counter is
    // bumped by the batch size.
    expect(result.walletsScanned).toBe(1);
    expect(result.walletsUpstreamFailures).toBe(1);
    expect(result.walletsReweighted).toBe(0);
    expect(result.walletsEmptied).toBe(0);
    expect(result.votesReweighted).toBe(0);

    // CRITICAL assertions: no per-vote write was issued, no GSI
    // query was issued, no registry update happened. The votes are
    // exactly as they were.
    expect(mockTransact).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();

    warn.mockRestore();
  });

  it("never zeros a wallet's votes when the wallet is MISSING from the Koios batch response", async () => {
    // Koios returns a row for B but NOT for A. We have NO IDEA what
    // A's current stake is — SKIP. The votes are untouched.
    mockScan.mockResolvedValueOnce({
      items: [
        makeVoter({ stakeAddress: STAKE_A, lastKnownStake: '1000000000000' }),
        makeVoter({ stakeAddress: STAKE_B, lastKnownStake: '500000000' }),
      ],
      lastEvaluatedKey: undefined,
      count: 2,
    });
    mockFetchAccounts.mockResolvedValueOnce([
      // Only B comes back. A is omitted (e.g. unregistered / never
      // staked in Koios's view).
      { stake_address: STAKE_B, total_balance: '500000000' } as never,
    ]);

    const result = await runRevalidateCommentStake();

    // A is counted as upstream failure (missing from response).
    // B is unchanged (same stake).
    expect(result.walletsScanned).toBe(2);
    expect(result.walletsUpstreamFailures).toBe(1);
    expect(result.walletsUnchanged).toBe(1);
    expect(result.walletsReweighted).toBe(0);
    expect(result.votesReweighted).toBe(0);

    // A's GSI was NEVER queried.
    expect(mockQuery).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        expressionAttributeValues: expect.objectContaining({ ':s': STAKE_A }),
      }),
    );
    // No re-weight transact was issued.
    expect(mockTransact).not.toHaveBeenCalled();
  });

  it("never zeros a wallet's votes when total_balance is missing / empty / unparseable", async () => {
    // Koios returns a row but `total_balance` is malformed — we cannot
    // know the wallet's stake. SKIP every variant. None of A, B, C
    // get their votes touched.
    mockScan.mockResolvedValueOnce({
      items: [
        makeVoter({ stakeAddress: STAKE_A, lastKnownStake: '1000000000000' }),
        makeVoter({ stakeAddress: STAKE_B, lastKnownStake: '500000000' }),
        makeVoter({ stakeAddress: STAKE_C, lastKnownStake: '750000000' }),
      ],
      lastEvaluatedKey: undefined,
      count: 3,
    });
    mockFetchAccounts.mockResolvedValueOnce([
      // A: empty string.
      { stake_address: STAKE_A, total_balance: '' } as never,
      // B: non-string (Koios sometimes returns null on unregistered).
      { stake_address: STAKE_B, total_balance: null } as never,
      // C: unparseable string.
      { stake_address: STAKE_C, total_balance: 'not-a-number' } as never,
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await runRevalidateCommentStake();

    expect(result.walletsScanned).toBe(3);
    expect(result.walletsUpstreamFailures).toBe(3);
    expect(result.walletsReweighted).toBe(0);
    expect(result.votesReweighted).toBe(0);

    // No re-weight transact, no GSI query, no registry update.
    expect(mockTransact).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();

    warn.mockRestore();
  });
});

// ---- 4. Idempotency: unchanged wallets are no-ops ----

describe('runRevalidateCommentStake — idempotency', () => {
  it('cheap-skips wallets whose lastKnownStake exactly matches the current Koios reading (no re-weight, no registry update)', async () => {
    mockScan.mockResolvedValueOnce({
      items: [makeVoter({ stakeAddress: STAKE_A, lastKnownStake: '12345000000' })],
      lastEvaluatedKey: undefined,
      count: 1,
    });
    mockFetchAccounts.mockResolvedValueOnce([
      { stake_address: STAKE_A, total_balance: '12345000000' } as never,
    ]);

    const result = await runRevalidateCommentStake();

    expect(result.walletsScanned).toBe(1);
    expect(result.walletsChecked).toBe(1);
    expect(result.walletsUnchanged).toBe(1);
    expect(result.walletsReweighted).toBe(0);
    expect(result.walletsUpstreamFailures).toBe(0);

    // The GSI was NOT queried (no votes to re-weight).
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockTransact).not.toHaveBeenCalled();
    // The registry was NOT advanced (lastCheckedAt stays unchanged —
    // see the sync's inline comment about preserving "when did this
    // wallet's stake last actually move?" as recoverable from the
    // registry alone).
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('two-pass: a second invocation against the same state issues zero writes', async () => {
    mockScan.mockResolvedValue({
      items: [makeVoter({ stakeAddress: STAKE_A, lastKnownStake: '12345000000' })],
      lastEvaluatedKey: undefined,
      count: 1,
    });
    mockFetchAccounts.mockResolvedValue([
      { stake_address: STAKE_A, total_balance: '12345000000' } as never,
    ]);

    await runRevalidateCommentStake();
    await runRevalidateCommentStake();

    // Two scans, two Koios batch calls, but zero per-vote writes
    // because nothing changed. The Koios batch is the only fixed
    // cost per sweep.
    expect(mockScan).toHaveBeenCalledTimes(2);
    expect(mockFetchAccounts).toHaveBeenCalledTimes(2);
    expect(mockTransact).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

// ---- 5. Multi-comment re-weight + delta accumulation ----

describe('runRevalidateCommentStake — multi-vote walk', () => {
  it('re-weights every vote belonging to one wallet across multiple comments', async () => {
    // Wallet A had 1M ADA when it voted on three comments (one up, two
    // down). It now reads 500k ADA — every vote re-weights down by 50%
    // of its prior contribution.
    mockScan.mockResolvedValueOnce({
      items: [makeVoter({ stakeAddress: STAKE_A, lastKnownStake: '1000000000' })],
      lastEvaluatedKey: undefined,
      count: 1,
    });
    mockFetchAccounts.mockResolvedValueOnce([
      { stake_address: STAKE_A, total_balance: '500000000' } as never,
    ]);
    mockQuery.mockResolvedValueOnce({
      items: [
        {
          commentId: COMMENT_ID,
          stakeAddress: STAKE_A,
          vote: 'up',
          lovelace: '1000000000',
          actionId: ACTION_ID,
        },
        {
          commentId: COMMENT_ID_2,
          stakeAddress: STAKE_A,
          vote: 'down',
          lovelace: '1000000000',
          actionId: ACTION_ID,
        },
        {
          commentId: COMMENT_ID_3,
          stakeAddress: STAKE_A,
          vote: 'down',
          lovelace: '1000000000',
          actionId: ACTION_ID,
        },
      ],
      lastEvaluatedKey: undefined,
      count: 3,
    });

    const result = await runRevalidateCommentStake();

    expect(result.walletsReweighted).toBe(1);
    expect(result.walletsEmptied).toBe(0); // current stake is 500k, not 0
    expect(result.votesReweighted).toBe(3);
    // Net delta:
    //   upvote: (+500_000_000) - (+1_000_000_000) = -500_000_000
    //   downvote: (-500_000_000) - (-1_000_000_000) = +500_000_000
    //   downvote: (-500_000_000) - (-1_000_000_000) = +500_000_000
    //   sum: +500_000_000
    expect(result.netSupportDelta).toBe('500000000');
    // Three transactWrites — one per vote re-weighted.
    expect(mockTransact).toHaveBeenCalledTimes(3);
  });
});

// ---- 6. Empty registry ----

describe('runRevalidateCommentStake — empty registry', () => {
  it('runs cleanly with zero work when the registry is empty (the prod-today path)', async () => {
    mockScan.mockResolvedValueOnce({
      items: [],
      lastEvaluatedKey: undefined,
      count: 0,
    });

    const result = await runRevalidateCommentStake();

    expect(result).toEqual({
      walletsScanned: 0,
      walletsChecked: 0,
      walletsUpstreamFailures: 0,
      walletsUnchanged: 0,
      walletsReweighted: 0,
      walletsEmptied: 0,
      votesReweighted: 0,
      netSupportDelta: '0',
      reweightErrors: 0,
    });
    // No Koios call, no GSI query, no writes.
    expect(mockFetchAccounts).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockTransact).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    // But the per-pass summary audit DID fire — so a CloudWatch search
    // for "this sweep ran" still finds the empty pass.
    const passSummaryCall = mockAudit.mock.calls.find(
      (c) => (c[0] as { eventType?: string }).eventType === 'comment_vote.revalidate_pass',
    );
    expect(passSummaryCall).toBeDefined();
  });
});
