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
  getItem: vi.fn(),
  tableNames: {
    comments: 'test-comments',
    commentVotes: 'test-comment_votes',
    commentVoters: 'test-comment_voters',
    auditLog: 'test-audit_log',
    clubhousePosts: 'test-clubhouse_posts',
    clubhouseComments: 'test-clubhouse_comments',
    drepCommittees: 'test-drep_committees',
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
  getItem,
} from '../lib/dynamodb';
import { writeAuditEvent } from '../lib/audit';
import {
  computeSupportDelta,
  runRevalidateCommentStake,
  runRevalidateClubhouseDelegations,
  enumerateClubhouseParticipants,
} from './revalidate-comment-stake';
import type { CommentVoterItem } from '../lib/types';

const mockFetchAccounts = vi.mocked(fetchAccountInfoBatch);
const mockScan = vi.mocked(scanItems);
const mockQuery = vi.mocked(queryItems);
const mockTransact = vi.mocked(transactWrite);
const mockUpdate = vi.mocked(updateItem);
const mockGetItem = vi.mocked(getItem);
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

// ============================================================
// Batch CLUBHOUSE-DELEGATION-GATE (2026-05-30) — Phase 2 sweep tests.
// ============================================================
//
// What we lock in:
//   1. CRITICAL guard: SKIPS revoke/badge on Koios batch failure (the
//      load-bearing safety invariant — same posture as the stake sweep's
//      "never zero on lookup failure"). Locked in for both failure
//      modes: whole-batch throws + wallet missing from response.
//   2. Confirmed mismatch → revokes poll vote AND badges comment.
//   3. Confirmed mismatch → role-holder BYPASS retains participation.
//   4. Re-activation: previously-badged author with re-aligned
//      delegation gets `authorDelegationActive` cleared back to true.
//   5. Idempotency: a second pass over the same state issues no extra
//      writes.
//   6. Enumeration: posts Scan harvests pollVotes; comments Scan
//      harvests authorWallet; non-stake addresses are filtered out.
//
// Per-record helpers (all keyed by drepId so a single wallet that
// participates in multiple clubhouses is correctly multi-tracked).

const DREP_A = 'drep1aaa';
const DREP_B = 'drep1bbb';
const POST_A = 'post-a';
const POST_B = 'post-b';
const POST_KEY_A = `${DREP_A}#${POST_A}`;
const POST_KEY_B = `${DREP_B}#${POST_B}`;

function makePollPost(opts: {
  drepId: string;
  postId: string;
  pollVotes?: Record<string, number>;
  pollOptions?: Array<{ id: string; label: string; votes: number }>;
}): Record<string, unknown> {
  return {
    drepId: opts.drepId,
    postId: opts.postId,
    pollVotes: opts.pollVotes ?? {},
    pollOptions: opts.pollOptions ?? [
      { id: 'a', label: 'Yes', votes: 1 },
      { id: 'b', label: 'No', votes: 0 },
    ],
  };
}

function makeCommentRow(opts: {
  postKey: string;
  commentId: string;
  drepId: string;
  authorWallet: string;
  authorDelegationActive?: boolean;
}): Record<string, unknown> {
  return {
    postKey: opts.postKey,
    commentId: opts.commentId,
    drepId: opts.drepId,
    authorWallet: opts.authorWallet,
    ...(opts.authorDelegationActive !== undefined
      ? { authorDelegationActive: opts.authorDelegationActive }
      : {}),
  };
}

/**
 * Wire the two Scan tables that the sweep's enumeration step issues.
 * Per-table dispatch keyed on the (mocked) tableName the call carries.
 */
function wireClubhouseScans(opts: {
  posts: Array<Record<string, unknown>>;
  comments: Array<Record<string, unknown>>;
}): void {
  mockScan.mockImplementation(async (tableName: string) => {
    if (tableName === 'test-clubhouse_posts') {
      return { items: opts.posts, lastEvaluatedKey: undefined, count: opts.posts.length };
    }
    if (tableName === 'test-clubhouse_comments') {
      return {
        items: opts.comments,
        lastEvaluatedKey: undefined,
        count: opts.comments.length,
      };
    }
    return { items: [], lastEvaluatedKey: undefined, count: 0 };
  });
}

/**
 * Wire the committee Get for the role-holder check. Returns the given
 * committee row for the named drepId, undefined for everything else.
 */
function wireCommitteeGet(opts: {
  drepId: string;
  leadWallet?: string;
  memberWallets?: string[];
}): void {
  mockGetItem.mockImplementation(async (tableName: string, key: Record<string, unknown>) => {
    if (
      tableName === 'test-drep_committees' &&
      key['drepId'] === opts.drepId &&
      key['SK'] === 'COMMITTEE'
    ) {
      return {
        drepId: opts.drepId,
        SK: 'COMMITTEE',
        leadWallet: opts.leadWallet ?? 'stake1_someoneelse',
        committeeName: 'test',
        description: 'd',
        members: (opts.memberWallets ?? []).map((w) => ({
          walletAddress: w,
          joinedAt: '2026-01-01T00:00:00Z',
          role: 'committee_member',
        })),
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
      } as never;
    }
    return undefined as never;
  });
}

describe('enumerateClubhouseParticipants — enumeration semantics', () => {
  it('harvests poll voters from clubhouse_posts and comment authors from clubhouse_comments', async () => {
    wireClubhouseScans({
      posts: [
        makePollPost({
          drepId: DREP_A,
          postId: POST_A,
          pollVotes: { [STAKE_A]: 0, [STAKE_B]: 1 },
        }),
      ],
      comments: [
        makeCommentRow({
          postKey: POST_KEY_A,
          commentId: 'c1',
          drepId: DREP_A,
          authorWallet: STAKE_C,
        }),
      ],
    });

    const { participants } = await enumerateClubhouseParticipants();

    expect(participants).toHaveLength(3);
    const byKey = new Map(participants.map((p) => [`${p.drepId}|${p.walletAddress}`, p]));
    expect(byKey.get(`${DREP_A}|${STAKE_A}`)?.pollVotes).toEqual([
      { postId: POST_A, optionIndex: 0 },
    ]);
    expect(byKey.get(`${DREP_A}|${STAKE_B}`)?.pollVotes).toEqual([
      { postId: POST_A, optionIndex: 1 },
    ]);
    expect(byKey.get(`${DREP_A}|${STAKE_C}`)?.comments).toEqual([
      { postKey: POST_KEY_A, commentId: 'c1', currentBadgeActive: undefined },
    ]);
  });

  it('filters out non-stake (payment-address fallback) entries — counted but skipped', async () => {
    wireClubhouseScans({
      posts: [
        makePollPost({
          drepId: DREP_A,
          postId: POST_A,
          // Payment-address fallback (addr1...) from useWalletAuth — Koios
          // can't resolve delegation for these, so we skip rather than
          // mis-attribute.
          pollVotes: { ['addr1nonstake']: 0, [STAKE_A]: 1 },
        }),
      ],
      comments: [
        makeCommentRow({
          postKey: POST_KEY_A,
          commentId: 'c1',
          drepId: DREP_A,
          authorWallet: 'addr1commentauthor',
        }),
      ],
    });

    const { participants, skippedNonStakeAddresses } =
      await enumerateClubhouseParticipants();

    expect(skippedNonStakeAddresses).toBe(2);
    // Only STAKE_A made it through.
    expect(participants).toHaveLength(1);
    expect(participants[0]!.walletAddress).toBe(STAKE_A);
  });

  it('a single wallet active in TWO different DReps gets TWO records (one per drepId)', async () => {
    wireClubhouseScans({
      posts: [
        makePollPost({
          drepId: DREP_A,
          postId: POST_A,
          pollVotes: { [STAKE_A]: 0 },
        }),
        makePollPost({
          drepId: DREP_B,
          postId: POST_B,
          pollVotes: { [STAKE_A]: 1 },
        }),
      ],
      comments: [],
    });

    const { participants } = await enumerateClubhouseParticipants();

    expect(participants).toHaveLength(2);
    const drepIds = participants.map((p) => p.drepId).sort();
    expect(drepIds).toEqual([DREP_A, DREP_B]);
    // Both records reference the SAME walletAddress — the scope is
    // (wallet, drepId), not wallet alone.
    expect(participants.every((p) => p.walletAddress === STAKE_A)).toBe(true);
  });

  it('skips poll-vote entries whose optionIndex is out of range vs the current pollOptions list (defensive)', async () => {
    wireClubhouseScans({
      posts: [
        makePollPost({
          drepId: DREP_A,
          postId: POST_A,
          pollOptions: [
            { id: 'a', label: 'Yes', votes: 0 },
            { id: 'b', label: 'No', votes: 0 },
          ],
          // 5 is out of range vs the 2-option poll above. Skipping
          // protects against an `pollOptions[5].votes -= 1` corrupting
          // the tally on a malformed row.
          pollVotes: { [STAKE_A]: 5, [STAKE_B]: 0 },
        }),
      ],
      comments: [],
    });

    const { participants } = await enumerateClubhouseParticipants();
    expect(participants).toHaveLength(1);
    expect(participants[0]!.walletAddress).toBe(STAKE_B);
  });
});

describe('runRevalidateClubhouseDelegations — confirmed mismatch acts (revoke + badge)', () => {
  it('confirmed mismatched delegation → REVOKES poll vote AND BADGES comment AND fires audit', async () => {
    // STAKE_A participates in DREP_A's clubhouse (one poll vote, one
    // comment). Koios confirms they're delegated to DREP_B instead.
    // STAKE_A is NOT a role-holder of DREP_A's committee. The sweep
    // must revoke the poll vote AND badge the comment.
    wireClubhouseScans({
      posts: [
        makePollPost({
          drepId: DREP_A,
          postId: POST_A,
          pollVotes: { [STAKE_A]: 0 },
        }),
      ],
      comments: [
        makeCommentRow({
          postKey: POST_KEY_A,
          commentId: 'c1',
          drepId: DREP_A,
          authorWallet: STAKE_A,
        }),
      ],
    });
    // Committee Get for DREP_A returns a committee where STAKE_A is NOT
    // a member — caller is not a role-holder, sweep should act.
    wireCommitteeGet({ drepId: DREP_A });
    mockFetchAccounts.mockResolvedValueOnce([
      {
        stake_address: STAKE_A,
        status: 'registered',
        delegated_pool: null,
        delegated_drep: DREP_B, // NOT DREP_A — mismatch
        total_balance: '1000000000',
        utxo: '1000000000',
        rewards: null,
        withdrawals: null,
        rewards_available: null,
        reserves: null,
        treasury: null,
      },
    ]);

    const result = await runRevalidateClubhouseDelegations();

    expect(result.pollVotesRevoked).toBe(1);
    expect(result.commentsBadged).toBe(1);
    expect(result.mismatchedRecords).toBe(1);
    expect(result.walletsUpstreamFailures).toBe(0);

    // The poll-vote revoke is an UpdateItem on clubhouse_posts with
    // REMOVE pollVotes.<wallet> + ADD pollOptions[0].votes :negOne.
    const revokeCall = mockUpdate.mock.calls.find(
      (c) => c[0] === 'test-clubhouse_posts',
    );
    expect(revokeCall).toBeDefined();
    expect(revokeCall![2]).toMatch(/REMOVE.*#pv\.#wallet/);
    expect(revokeCall![2]).toMatch(/ADD.*#po\[0\]\.#v :negOne/);

    // The badge write is an UpdateItem on clubhouse_comments with
    // SET authorDelegationActive = false.
    const badgeCall = mockUpdate.mock.calls.find(
      (c) => c[0] === 'test-clubhouse_comments',
    );
    expect(badgeCall).toBeDefined();
    expect(badgeCall![2]).toMatch(/SET.*authorDelegationActive|SET #ada/);
    expect(badgeCall![4]).toMatchObject({ ':v': false });

    // Both audit events fired.
    const auditEventTypes = mockAudit.mock.calls.map(
      (c) => (c[0] as { eventType?: string }).eventType,
    );
    expect(auditEventTypes).toContain('clubhouse.poll.revoked');
    expect(auditEventTypes).toContain('clubhouse.comment.badged');
  });

  it('role-holder BYPASS: a lead/committee_member retains participation even when delegated elsewhere', async () => {
    // STAKE_A is the lead of DREP_A's committee — they retain access to
    // their own clubhouse irrespective of where their wallet is
    // currently delegated. Sweep must NOT revoke / badge.
    wireClubhouseScans({
      posts: [
        makePollPost({
          drepId: DREP_A,
          postId: POST_A,
          pollVotes: { [STAKE_A]: 0 },
        }),
      ],
      comments: [
        makeCommentRow({
          postKey: POST_KEY_A,
          commentId: 'c1',
          drepId: DREP_A,
          authorWallet: STAKE_A,
        }),
      ],
    });
    wireCommitteeGet({ drepId: DREP_A, leadWallet: STAKE_A });
    mockFetchAccounts.mockResolvedValueOnce([
      {
        stake_address: STAKE_A,
        status: 'registered',
        delegated_pool: null,
        delegated_drep: DREP_B,
        total_balance: '1000000000',
        utxo: null,
        rewards: null,
        withdrawals: null,
        rewards_available: null,
        reserves: null,
        treasury: null,
      },
    ]);

    const result = await runRevalidateClubhouseDelegations();

    expect(result.pollVotesRevoked).toBe(0);
    expect(result.commentsBadged).toBe(0);
    expect(result.mismatchedRecords).toBe(0);
    // No revoke/badge UpdateItems issued.
    expect(
      mockUpdate.mock.calls.filter(
        (c) =>
          c[0] === 'test-clubhouse_posts' || c[0] === 'test-clubhouse_comments',
      ),
    ).toHaveLength(0);
  });
});

describe('runRevalidateClubhouseDelegations — CRITICAL never-act-on-upstream-failure guard', () => {
  it('SKIPS revoke/badge on Koios batch throw (whole-batch outage)', async () => {
    // The load-bearing safety invariant. A Koios outage MUST NOT strip
    // clubhouse participation across the board — that's worse than
    // the un-revoked stale vote we're trying to catch.
    wireClubhouseScans({
      posts: [
        makePollPost({
          drepId: DREP_A,
          postId: POST_A,
          pollVotes: { [STAKE_A]: 0, [STAKE_B]: 1 },
        }),
      ],
      comments: [
        makeCommentRow({
          postKey: POST_KEY_A,
          commentId: 'c1',
          drepId: DREP_A,
          authorWallet: STAKE_A,
        }),
      ],
    });
    wireCommitteeGet({ drepId: DREP_A });
    mockFetchAccounts.mockRejectedValueOnce(
      new KoiosError('/account_info_cached', 'HTTP 503 Service Unavailable', 503),
    );

    const result = await runRevalidateClubhouseDelegations();

    expect(result.walletsUpstreamFailures).toBeGreaterThan(0);
    expect(result.pollVotesRevoked).toBe(0);
    expect(result.commentsBadged).toBe(0);
    // CRITICAL: zero UpdateItems against the clubhouse tables.
    const writesAgainstClubhouseTables = mockUpdate.mock.calls.filter(
      (c) =>
        c[0] === 'test-clubhouse_posts' || c[0] === 'test-clubhouse_comments',
    );
    expect(writesAgainstClubhouseTables).toHaveLength(0);
  });

  it('SKIPS revoke/badge on wallet missing from Koios response (partial outage)', async () => {
    // Koios sometimes omits unregistered / never-staked addresses from
    // the response. We have no current delegation reading for those —
    // we must SKIP rather than misinterpret absence as "not delegated."
    wireClubhouseScans({
      posts: [
        makePollPost({
          drepId: DREP_A,
          postId: POST_A,
          pollVotes: { [STAKE_A]: 0 },
        }),
      ],
      comments: [],
    });
    wireCommitteeGet({ drepId: DREP_A });
    // STAKE_A NOT present in the response.
    mockFetchAccounts.mockResolvedValueOnce([]);

    const result = await runRevalidateClubhouseDelegations();

    expect(result.walletsUpstreamFailures).toBe(1);
    expect(result.pollVotesRevoked).toBe(0);
    expect(result.commentsBadged).toBe(0);
    expect(
      mockUpdate.mock.calls.filter(
        (c) =>
          c[0] === 'test-clubhouse_posts' || c[0] === 'test-clubhouse_comments',
      ),
    ).toHaveLength(0);
  });
});

describe('runRevalidateClubhouseDelegations — re-activation + idempotency', () => {
  it('clears a stale `authorDelegationActive=false` badge when the author is delegated again', async () => {
    // A previously-badged author has re-delegated to THIS drep. The
    // sweep must clear the badge — keeps the system self-healing.
    wireClubhouseScans({
      posts: [],
      comments: [
        makeCommentRow({
          postKey: POST_KEY_A,
          commentId: 'c1',
          drepId: DREP_A,
          authorWallet: STAKE_A,
          authorDelegationActive: false, // STALE — was badged on a prior pass
        }),
      ],
    });
    wireCommitteeGet({ drepId: DREP_A });
    mockFetchAccounts.mockResolvedValueOnce([
      {
        stake_address: STAKE_A,
        status: 'registered',
        delegated_pool: null,
        delegated_drep: DREP_A, // RE-DELEGATED — match
        total_balance: '1000000000',
        utxo: null,
        rewards: null,
        withdrawals: null,
        rewards_available: null,
        reserves: null,
        treasury: null,
      },
    ]);

    const result = await runRevalidateClubhouseDelegations();

    expect(result.commentsUnbadged).toBe(1);
    expect(result.commentsBadged).toBe(0);
    expect(result.walletsAllAligned).toBe(1);
    const unbadgeCall = mockUpdate.mock.calls.find(
      (c) => c[0] === 'test-clubhouse_comments',
    );
    expect(unbadgeCall).toBeDefined();
    expect(unbadgeCall![4]).toMatchObject({ ':v': true });
    // Audit fired.
    const auditEventTypes = mockAudit.mock.calls.map(
      (c) => (c[0] as { eventType?: string }).eventType,
    );
    expect(auditEventTypes).toContain('clubhouse.comment.unbadged');
  });

  it('IDEMPOTENT: skips comments already badged false on a confirmed mismatch (no duplicate badge write)', async () => {
    // STAKE_A is mismatched AND their comment is already badged
    // `authorDelegationActive=false` from a previous pass. The sweep
    // must NOT re-issue the badge write — wasteful, and would risk
    // duplicate audit events.
    wireClubhouseScans({
      posts: [],
      comments: [
        makeCommentRow({
          postKey: POST_KEY_A,
          commentId: 'c1',
          drepId: DREP_A,
          authorWallet: STAKE_A,
          authorDelegationActive: false, // ALREADY badged from a prior pass
        }),
      ],
    });
    wireCommitteeGet({ drepId: DREP_A });
    mockFetchAccounts.mockResolvedValueOnce([
      {
        stake_address: STAKE_A,
        status: 'registered',
        delegated_pool: null,
        delegated_drep: DREP_B,
        total_balance: '1000000000',
        utxo: null,
        rewards: null,
        withdrawals: null,
        rewards_available: null,
        reserves: null,
        treasury: null,
      },
    ]);

    const result = await runRevalidateClubhouseDelegations();

    expect(result.commentsBadged).toBe(0);
    // Idempotency: no extra badge write fired for the already-badged row.
    const badgeCalls = mockUpdate.mock.calls.filter(
      (c) => c[0] === 'test-clubhouse_comments',
    );
    expect(badgeCalls).toHaveLength(0);
    // No `clubhouse.comment.badged` audit event for the no-op pass.
    const auditEventTypes = mockAudit.mock.calls.map(
      (c) => (c[0] as { eventType?: string }).eventType,
    );
    expect(auditEventTypes).not.toContain('clubhouse.comment.badged');
  });

  it('IDEMPOTENT: poll-vote revoke that races a manual remove (CCFE) returns silently — counted as no-op', async () => {
    // The revoke is guarded by `pollVotes.<wallet> = :prev`. If a
    // concurrent write (e.g. the user logged in + un-voted) already
    // removed the entry, the guard fails CCFE and we treat as already-
    // done. No write error, no audit event.
    wireClubhouseScans({
      posts: [
        makePollPost({
          drepId: DREP_A,
          postId: POST_A,
          pollVotes: { [STAKE_A]: 0 },
        }),
      ],
      comments: [],
    });
    wireCommitteeGet({ drepId: DREP_A });
    mockFetchAccounts.mockResolvedValueOnce([
      {
        stake_address: STAKE_A,
        status: 'registered',
        delegated_pool: null,
        delegated_drep: DREP_B,
        total_balance: '1000000000',
        utxo: null,
        rewards: null,
        withdrawals: null,
        rewards_available: null,
        reserves: null,
        treasury: null,
      },
    ]);
    // First Update (the poll-vote revoke) hits CCFE → already-removed.
    mockUpdate.mockImplementation(async (tableName: string) => {
      if (tableName === 'test-clubhouse_posts') {
        throw Object.assign(new Error('CCFE'), {
          name: 'ConditionalCheckFailedException',
        });
      }
      return undefined as never;
    });

    const result = await runRevalidateClubhouseDelegations();

    expect(result.pollVotesRevoked).toBe(0);
    expect(result.writeErrors).toBe(0);
    // No `clubhouse.poll.revoked` audit event for the no-op revoke.
    const auditEventTypes = mockAudit.mock.calls.map(
      (c) => (c[0] as { eventType?: string }).eventType,
    );
    expect(auditEventTypes).not.toContain('clubhouse.poll.revoked');
  });
});

describe('runRevalidateClubhouseDelegations — empty state + summary', () => {
  it('empty clubhouse state runs cleanly and fires per-pass summary', async () => {
    wireClubhouseScans({ posts: [], comments: [] });
    const result = await runRevalidateClubhouseDelegations();
    expect(result).toMatchObject({
      participantsScanned: 0,
      walletsChecked: 0,
      pollVotesRevoked: 0,
      commentsBadged: 0,
      commentsUnbadged: 0,
    });
    // Per-pass summary audit fired regardless.
    const summary = mockAudit.mock.calls.find(
      (c) =>
        (c[0] as { eventType?: string }).eventType ===
        'clubhouse.delegation_sweep_pass',
    );
    expect(summary).toBeDefined();
    // No Koios call — short-circuits.
    expect(mockFetchAccounts).not.toHaveBeenCalled();
  });
});
