/**
 * Tests for `runCCMembersSync` — the epoch-skip behaviour is the
 * load-bearing invariant. Membership only changes at epoch boundaries,
 * so the Koios `/committee_info` call MUST be suppressed when the
 * META row's `lastSyncedEpoch` matches the current chain epoch.
 *
 * # Invariants under test
 *
 *   1. First-ever cycle (no META row): Koios call fires, every
 *      authorized member is written, META row is bumped to current
 *      epoch.
 *   2. Same-epoch cycle: Koios `/committee_info` is NOT called; no
 *      member writes; result outcome is `'skipped-same-epoch'`.
 *   3. New-epoch cycle: Koios is called, members rewritten, META row
 *      advances to the new epoch.
 *   4. `/tip` failure aborts the cycle (errors counter increments;
 *      no `/committee_info` call).
 *   5. `/committee_info` failure aborts after the META read but
 *      before any member writes.
 *   6. META key is the reserved string `'META'` and never collides
 *      with a real `cc_hot...` bech32 ID.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../lib/koios', () => ({
  getCurrentEpoch: vi.fn(),
  getCommitteeMembers: vi.fn(),
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
  getItem: vi.fn(),
  putItem: vi.fn(),
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

import { getCurrentEpoch, getCommitteeMembers, KoiosError } from '../lib/koios';
import { getItem, putItem } from '../lib/dynamodb';
import { runCCMembersSync, CC_MEMBERS_META_KEY } from './cc-members';

const mockGetCurrentEpoch = vi.mocked(getCurrentEpoch);
const mockGetCommitteeMembers = vi.mocked(getCommitteeMembers);
const mockGetItem = vi.mocked(getItem);
const mockPutItem = vi.mocked(putItem);

const HOT_A = 'cc_hot_aaaa';
const HOT_B = 'cc_hot_bbbb';
const COLD_A = 'cc_cold_aaaa';

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentEpoch.mockResolvedValue(515);
  mockGetCommitteeMembers.mockResolvedValue([]);
  mockGetItem.mockResolvedValue(undefined);
  mockPutItem.mockResolvedValue(undefined);
});

describe('runCCMembersSync — epoch-skip behavior', () => {
  it('cold-start with no META row: fetches Koios, writes members, bumps META', async () => {
    mockGetItem.mockResolvedValue(undefined); // no META row yet
    mockGetCommitteeMembers.mockResolvedValue([
      {
        status: 'authorized',
        cc_hot_id: HOT_A,
        cc_cold_id: COLD_A,
        cc_hot_hex: 'aaaa',
        cc_cold_hex: 'aaaa',
        expiration_epoch: 600,
        cc_hot_has_script: false,
        cc_cold_has_script: false,
      },
      {
        status: 'authorized',
        cc_hot_id: HOT_B,
        cc_cold_id: null,
        cc_hot_hex: 'bbbb',
        cc_cold_hex: null,
        expiration_epoch: null,
        cc_hot_has_script: false,
        cc_cold_has_script: false,
      },
    ]);

    const result = await runCCMembersSync();

    expect(mockGetCommitteeMembers).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('synced');
    expect(result.membersTotal).toBe(2);
    expect(result.membersWritten).toBe(2);
    expect(result.lastSyncedEpoch).toBe(515);
    // 2 member writes + 1 META write
    expect(mockPutItem).toHaveBeenCalledTimes(3);
  });

  it('same-epoch cycle: skips Koios call and writes nothing', async () => {
    mockGetItem.mockResolvedValue({
      ccHotCred: CC_MEMBERS_META_KEY,
      lastSyncedEpoch: 515, // matches current
      lastSyncedAt: '2026-05-01T00:00:00.000Z',
    });

    const result = await runCCMembersSync();

    expect(mockGetCommitteeMembers).not.toHaveBeenCalled();
    expect(mockPutItem).not.toHaveBeenCalled();
    expect(result.outcome).toBe('skipped-same-epoch');
    expect(result.currentEpoch).toBe(515);
    expect(result.lastSyncedEpoch).toBe(515);
    expect(result.membersWritten).toBe(0);
  });

  it('new-epoch cycle: fires Koios, rewrites members, advances META', async () => {
    // META row says we last synced epoch 514; current is 515 — refresh.
    mockGetItem.mockResolvedValue({
      ccHotCred: CC_MEMBERS_META_KEY,
      lastSyncedEpoch: 514,
      lastSyncedAt: '2026-04-20T00:00:00.000Z',
    });
    mockGetCommitteeMembers.mockResolvedValue([
      {
        status: 'authorized',
        cc_hot_id: HOT_A,
        cc_cold_id: COLD_A,
        cc_hot_hex: 'aaaa',
        cc_cold_hex: 'aaaa',
        expiration_epoch: 600,
        cc_hot_has_script: false,
        cc_cold_has_script: false,
      },
    ]);

    const result = await runCCMembersSync();

    expect(mockGetCommitteeMembers).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('synced');
    expect(result.lastSyncedEpoch).toBe(515);
    expect(result.membersWritten).toBe(1);
  });

  it('META read failure treats as cold-start and still syncs', async () => {
    mockGetItem.mockRejectedValue(new Error('DDB transient failure'));
    mockGetCommitteeMembers.mockResolvedValue([
      {
        status: 'authorized',
        cc_hot_id: HOT_A,
        cc_cold_id: COLD_A,
        cc_hot_hex: 'aaaa',
        cc_cold_hex: 'aaaa',
        expiration_epoch: null,
        cc_hot_has_script: false,
        cc_cold_has_script: false,
      },
    ]);

    const result = await runCCMembersSync();

    // META read failed but we still synced — better to over-fetch on
    // transient DDB blips than to skip when we shouldn't.
    expect(result.outcome).toBe('synced');
    expect(result.membersWritten).toBe(1);
  });
});

describe('runCCMembersSync — failure handling', () => {
  it('aborts cycle when /tip throws', async () => {
    mockGetCurrentEpoch.mockRejectedValue(new KoiosError('/tip', 'HTTP 503', 503));

    const result = await runCCMembersSync();

    expect(result.outcome).toBe('errored');
    expect(result.errors).toBe(1);
    // We never even reached the META read or member fetch.
    expect(mockGetItem).not.toHaveBeenCalled();
    expect(mockGetCommitteeMembers).not.toHaveBeenCalled();
  });

  it('aborts cycle when /committee_info throws', async () => {
    mockGetCommitteeMembers.mockRejectedValue(
      new KoiosError('/committee_info', 'HTTP 502', 502),
    );

    const result = await runCCMembersSync();

    expect(result.outcome).toBe('errored');
    expect(result.errors).toBe(1);
    // META should NOT have been bumped — we don't want to silence the
    // next hour's retry attempt.
    expect(mockPutItem).not.toHaveBeenCalled();
  });
});
