/**
 * Tests for `drep-directory.ts` sync — focused on the 2026-05-26
 * additions:
 *
 *   1. Predefined DReps (`drep_always_abstain`, `drep_always_no_confidence`)
 *      are synthesized as PROFILE rows with hard-coded display names,
 *      `isPredefined=true`, and the voting power Koios's `drep_info`
 *      reports for them. Previously the sync filtered them out
 *      explicitly — the user reported that the largest voting-power
 *      DReps on mainnet (Abstain holds ~9B ADA) were missing from
 *      drep.tools because of this filter.
 *   2. Every PROFILE row written by the sync now carries
 *      `entityType='DREP_PROFILE'` — the sparse-GSI partition key that
 *      the new read path (Query against `entityType-votingPower-index`)
 *      depends on. Without this on every Put, newly-registered DReps
 *      would be invisible to the list endpoint.
 *   3. The compare-then-write idempotency path still applies to
 *      predefined rows — running the sync twice produces the same row
 *      both times, and the second pass should skip the Put.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../lib/koios', () => ({
  listAllDReps: vi.fn(),
  fetchDRepInfoBatch: vi.fn(),
  fetchDRepMetadata: vi.fn(),
  fetchPredefinedDRepDelegatorCount: vi.fn(),
  listAllVotes: vi.fn(),
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
  putItem: vi.fn(),
  batchGetItems: vi.fn(),
  queryItems: vi.fn(),
  putItemIfAbsent: vi.fn(),
  // The auto-post helpers import `docClient` directly for the
  // UpdateCommand path (completion sweep). Stub it minimally —
  // tests that exercise that path mock the helper at a higher
  // layer (see `clubhouseAutoPosts.test.ts`).
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

import {
  listAllDReps,
  fetchDRepInfoBatch,
  fetchDRepMetadata,
  fetchPredefinedDRepDelegatorCount,
  listAllVotes,
} from '../lib/koios';
import { putItem, batchGetItems } from '../lib/dynamodb';
import {
  runDirectorySync,
  PREDEFINED_DREP_DISPLAY_NAMES,
} from './drep-directory';
import type { DRepDirectoryItem } from '../lib/types';

const mockListAllDReps = vi.mocked(listAllDReps);
const mockFetchDRepInfoBatch = vi.mocked(fetchDRepInfoBatch);
const mockFetchDRepMetadata = vi.mocked(fetchDRepMetadata);
const mockFetchPredefinedDRepDelegatorCount = vi.mocked(fetchPredefinedDRepDelegatorCount);
const mockListAllVotes = vi.mocked(listAllVotes);
const mockPutItem = vi.mocked(putItem);
const mockBatchGetItems = vi.mocked(batchGetItems);

/** Predefined DRep voting power on mainnet today, as reported by Koios. */
const ABSTAIN_POWER = '9025392512000000'; // 9.025 billion ADA in lovelace
const NO_CONF_POWER = '200083605000000'; // 200.08 million ADA in lovelace

beforeEach(() => {
  vi.clearAllMocks();
  // Default: empty registry, no votes, no metadata, no existing rows.
  // Tests override these as needed.
  mockListAllDReps.mockResolvedValue([]);
  mockFetchDRepInfoBatch.mockResolvedValue([]);
  mockFetchDRepMetadata.mockResolvedValue([]);
  mockListAllVotes.mockResolvedValue([]);
  mockBatchGetItems.mockResolvedValue([]);
  mockPutItem.mockResolvedValue(undefined);
  // Default: delegator count walk returns null (treat as upstream failure).
  // Tests override per case to exercise success / approx / preserve paths.
  mockFetchPredefinedDRepDelegatorCount.mockResolvedValue(null);
});

describe('runDirectorySync — predefined DRep injection', () => {
  it('synthesizes PROFILE rows for both predefined DReps even when drep_list is empty', async () => {
    // Koios drep_list returns nothing (extreme but valid edge case —
    // happens early in stack rebuild). The sync should STILL inject
    // the two predefined DReps; they don't depend on drep_list.
    mockFetchDRepInfoBatch.mockImplementation(async (ids) => {
      // The sync calls fetchDRepInfoBatch twice in this scenario:
      //   - First call: with the empty drepIds list (no registered DReps)
      //   - Second call: with the predefined IDs
      // We respond to the predefined-ID call with the real Koios shape.
      if (ids.includes('drep_always_abstain')) {
        return [
          {
            drep_id: 'drep_always_abstain',
            hex: null,
            has_script: false,
            drep_status: 'registered',
            deposit: null,
            active: true,
            expires_epoch_no: null,
            amount: ABSTAIN_POWER,
            meta_url: null,
            meta_hash: null,
          },
          {
            drep_id: 'drep_always_no_confidence',
            hex: null,
            has_script: false,
            drep_status: 'registered',
            deposit: null,
            active: true,
            expires_epoch_no: null,
            amount: NO_CONF_POWER,
            meta_url: null,
            meta_hash: null,
          },
        ];
      }
      return [];
    });

    const result = await runDirectorySync();

    // Find the two synthesized predefined PROFILE Puts.
    const puts = mockPutItem.mock.calls.map(([, item]) => item) as DRepDirectoryItem[];
    const abstainPut = puts.find((r) => r.drepId === 'drep_always_abstain');
    const noConfPut = puts.find((r) => r.drepId === 'drep_always_no_confidence');

    expect(abstainPut).toBeDefined();
    expect(noConfPut).toBeDefined();

    // Hardcoded display names — the contract for the frontend.
    expect(abstainPut!.givenName).toBe(PREDEFINED_DREP_DISPLAY_NAMES.drep_always_abstain);
    expect(abstainPut!.givenName).toBe('Always Abstain');
    expect(noConfPut!.givenName).toBe(PREDEFINED_DREP_DISPLAY_NAMES.drep_always_no_confidence);
    expect(noConfPut!.givenName).toBe('Always No-Confidence');

    // isPredefined flag is set so the frontend can render distinct
    // styling without inspecting the drepId string.
    expect(abstainPut!.isPredefined).toBe(true);
    expect(noConfPut!.isPredefined).toBe(true);

    // entityType present on every synthesized row — required for the
    // sparse-GSI read path to surface them.
    expect(abstainPut!.entityType).toBe('DREP_PROFILE');
    expect(noConfPut!.entityType).toBe('DREP_PROFILE');

    // Voting power picked up from drep_info verbatim. This is what was
    // missing from the user's UI ("DReps with the most power").
    expect(abstainPut!.votingPower).toBe(ABSTAIN_POWER);
    expect(noConfPut!.votingPower).toBe(NO_CONF_POWER);

    // No CIP-119 anchor metadata for predefined DReps.
    expect(abstainPut!.anchorUrl).toBeNull();
    expect(abstainPut!.image).toBeUndefined();
    expect(abstainPut!.objectives).toBeUndefined();
    expect(abstainPut!.references).toBeUndefined();

    // Forced active, never retired.
    expect(abstainPut!.isActive).toBe(true);
    expect(abstainPut!.isRetired).toBe(false);

    // Stat counters: 2 predefined contributed to total + active.
    expect(result.total).toBe(2);
    expect(result.active).toBe(2);
    expect(result.written).toBe(2);
    expect(result.errors).toBe(0);
  });

  it('still writes predefined rows with votingPower="0" when Koios drep_info returns nothing for them', async () => {
    // Koios outage / partial response — drep_info returns empty array.
    // The sync must still emit the predefined rows (so they don't
    // disappear from the directory) but with voting power 0.
    mockFetchDRepInfoBatch.mockResolvedValue([]);

    await runDirectorySync();

    const puts = mockPutItem.mock.calls.map(([, item]) => item) as DRepDirectoryItem[];
    const abstainPut = puts.find((r) => r.drepId === 'drep_always_abstain');

    expect(abstainPut).toBeDefined();
    expect(abstainPut!.votingPower).toBe('0');
    expect(abstainPut!.givenName).toBe('Always Abstain');
    expect(abstainPut!.isPredefined).toBe(true);
  });
});

describe('runDirectorySync — entityType on regular DRep rows', () => {
  it('writes entityType="DREP_PROFILE" on every regular PROFILE row Put', async () => {
    // Two registered DReps + the two predefined that always get injected.
    mockListAllDReps.mockResolvedValue([
      { drep_id: 'drep1aaa', hex: 'aa', has_script: false, registered: true },
      { drep_id: 'drep1bbb', hex: 'bb', has_script: false, registered: true },
    ]);
    mockFetchDRepInfoBatch.mockImplementation(async (ids) => {
      // Sync calls fetchDRepInfoBatch twice — once for regular DReps
      // and once for the two predefined. We match by content.
      if (ids.includes('drep1aaa')) {
        return [
          {
            drep_id: 'drep1aaa',
            hex: 'aa',
            has_script: false,
            drep_status: 'registered',
            deposit: '500000000',
            active: true,
            expires_epoch_no: 500,
            amount: '10000000000',
            meta_url: null,
            meta_hash: null,
          },
          {
            drep_id: 'drep1bbb',
            hex: 'bb',
            has_script: false,
            drep_status: 'registered',
            deposit: '500000000',
            active: true,
            expires_epoch_no: 500,
            amount: '20000000000',
            meta_url: null,
            meta_hash: null,
          },
        ];
      }
      return []; // predefined batch: empty -> voting power 0
    });

    await runDirectorySync();

    const puts = mockPutItem.mock.calls.map(([, item]) => item) as DRepDirectoryItem[];
    // All Puts (regular + predefined) carry entityType.
    expect(puts.length).toBeGreaterThanOrEqual(2);
    for (const p of puts) {
      expect(p.entityType).toBe('DREP_PROFILE');
    }
  });
});

describe('runDirectorySync — idempotency on predefined rows', () => {
  it('skips the Put when the existing predefined row already matches the synthesized candidate', async () => {
    // Pre-populate the BatchGet response with the predefined rows in
    // their exact synthesized form. The compare-then-write path should
    // detect equality and skip the Put.
    mockFetchDRepInfoBatch.mockResolvedValue([
      {
        drep_id: 'drep_always_abstain',
        hex: null,
        has_script: false,
        drep_status: 'registered',
        deposit: null,
        active: true,
        expires_epoch_no: null,
        amount: ABSTAIN_POWER,
        meta_url: null,
        meta_hash: null,
      },
      {
        drep_id: 'drep_always_no_confidence',
        hex: null,
        has_script: false,
        drep_status: 'registered',
        deposit: null,
        active: true,
        expires_epoch_no: null,
        amount: NO_CONF_POWER,
        meta_url: null,
        meta_hash: null,
      },
    ]);

    // First pass: capture what gets written so we can replay it as the
    // "existing rows" on the second pass.
    await runDirectorySync();
    const firstPassPuts = mockPutItem.mock.calls.map(([, item]) => item) as DRepDirectoryItem[];
    expect(firstPassPuts).toHaveLength(2);

    // Reset Put mock; keep BatchGet returning the just-written rows.
    mockPutItem.mockClear();
    mockBatchGetItems.mockResolvedValue(firstPassPuts);

    // Second pass: compare-then-write should detect no diff and skip.
    const secondPassResult = await runDirectorySync();
    expect(mockPutItem).not.toHaveBeenCalled();
    expect(secondPassResult.skippedFresh).toBe(2);
    expect(secondPassResult.written).toBe(0);
  });
});

// ============================================================
// Predefined-DRep delegatorCount precompute (Batch F #10, 2026-05-27)
// ============================================================

describe('runDirectorySync — predefined DRep delegatorCount precompute', () => {
  it('persists delegatorCount on the synthesized row when the fresh walk succeeds', async () => {
    // drep_info populated for both predefined DReps; delegator walks
    // succeed with realistic mainnet counts (Abstain ~60k, NoConf ~5k).
    mockFetchDRepInfoBatch.mockResolvedValue([
      {
        drep_id: 'drep_always_abstain',
        hex: null,
        has_script: false,
        drep_status: 'registered',
        deposit: null,
        active: true,
        expires_epoch_no: null,
        amount: ABSTAIN_POWER,
        meta_url: null,
        meta_hash: null,
      },
      {
        drep_id: 'drep_always_no_confidence',
        hex: null,
        has_script: false,
        drep_status: 'registered',
        deposit: null,
        active: true,
        expires_epoch_no: null,
        amount: NO_CONF_POWER,
        meta_url: null,
        meta_hash: null,
      },
    ]);
    mockFetchPredefinedDRepDelegatorCount.mockImplementation(async (id) => {
      if (id === 'drep_always_abstain') return { count: 61234, isApprox: false };
      if (id === 'drep_always_no_confidence') return { count: 4567, isApprox: false };
      return null;
    });

    await runDirectorySync();

    const puts = mockPutItem.mock.calls.map(([, item]) => item) as DRepDirectoryItem[];
    const abstainPut = puts.find((r) => r.drepId === 'drep_always_abstain');
    const noConfPut = puts.find((r) => r.drepId === 'drep_always_no_confidence');

    expect(abstainPut).toBeDefined();
    expect(noConfPut).toBeDefined();
    expect(abstainPut!.delegatorCount).toBe(61234);
    expect(noConfPut!.delegatorCount).toBe(4567);
    // Approx flag is NOT persisted on the directory row — the sync
    // is the authoritative source for these DReps and the get-handler
    // treats absence as "exact." See directory/get.ts for the contract.
    expect(abstainPut!.delegatorCountIsApprox).toBeUndefined();
  });

  it('still persists approximate counts when the walk hit the 100-page cap', async () => {
    mockFetchDRepInfoBatch.mockResolvedValue([
      {
        drep_id: 'drep_always_abstain',
        hex: null,
        has_script: false,
        drep_status: 'registered',
        deposit: null,
        active: true,
        expires_epoch_no: null,
        amount: ABSTAIN_POWER,
        meta_url: null,
        meta_hash: null,
      },
    ]);
    // Hit the 100-page cap — the walker stopped at 100k rows but the
    // DRep actually has more. Still persist; an approximate "100000" is
    // dramatically more useful than `undefined`.
    mockFetchPredefinedDRepDelegatorCount.mockResolvedValue({ count: 100000, isApprox: true });

    await runDirectorySync();

    const puts = mockPutItem.mock.calls.map(([, item]) => item) as DRepDirectoryItem[];
    const abstainPut = puts.find((r) => r.drepId === 'drep_always_abstain');
    expect(abstainPut!.delegatorCount).toBe(100000);
  });

  it('preserves the previous cycle delegatorCount when the fresh walk returns null', async () => {
    mockFetchDRepInfoBatch.mockResolvedValue([
      {
        drep_id: 'drep_always_abstain',
        hex: null,
        has_script: false,
        drep_status: 'registered',
        deposit: null,
        active: true,
        expires_epoch_no: null,
        amount: ABSTAIN_POWER,
        meta_url: null,
        meta_hash: null,
      },
    ]);
    // Previous cycle wrote a count of 59000; fresh walk fails (null).
    // Compare-then-write should preserve the prior value rather than
    // clobber the row with `undefined` (which would render as "—" in
    // the UI for 30 minutes until the next sync).
    mockBatchGetItems.mockResolvedValue([
      {
        drepId: 'drep_always_abstain',
        SK: 'PROFILE',
        entityType: 'DREP_PROFILE',
        isActive: true,
        isRetired: false,
        isPredefined: true,
        status: 'predefined',
        deposit: null,
        hex: null,
        hasScript: false,
        votingPower: ABSTAIN_POWER,
        votingPowerPartition: 'ALL',
        votingPowerSort: ABSTAIN_POWER.padStart(24, '0'),
        expiresEpoch: null,
        anchorUrl: null,
        anchorHash: null,
        anchorVerified: null,
        voteCount: 0,
        delegatorCount: 59000,
        givenName: 'Always Abstain',
        givenNameLower: 'always abstain',
        lastSyncedAt: '2026-05-27T00:00:00.000Z',
        enrichmentVersion: 4,
      } as DRepDirectoryItem,
    ]);
    mockFetchPredefinedDRepDelegatorCount.mockResolvedValue(null);

    await runDirectorySync();

    const puts = mockPutItem.mock.calls.map(([, item]) => item) as DRepDirectoryItem[];
    const abstainPut = puts.find((r) => r.drepId === 'drep_always_abstain');
    // The compare-then-write idempotency path should detect that nothing
    // changed (count preserved from existing row) and SKIP the Put. The
    // assertion is: if it WAS written, the count must be preserved.
    if (abstainPut) {
      expect(abstainPut.delegatorCount).toBe(59000);
    }
  });

  it('omits delegatorCount when the walk fails AND there is no prior cycle value', async () => {
    mockFetchDRepInfoBatch.mockResolvedValue([
      {
        drep_id: 'drep_always_abstain',
        hex: null,
        has_script: false,
        drep_status: 'registered',
        deposit: null,
        active: true,
        expires_epoch_no: null,
        amount: ABSTAIN_POWER,
        meta_url: null,
        meta_hash: null,
      },
    ]);
    // No existing row, fresh walk fails. The synthesized row should
    // simply omit `delegatorCount` rather than write `null` or `0`
    // (either of which would lie about the population).
    mockFetchPredefinedDRepDelegatorCount.mockResolvedValue(null);

    await runDirectorySync();

    const puts = mockPutItem.mock.calls.map(([, item]) => item) as DRepDirectoryItem[];
    const abstainPut = puts.find((r) => r.drepId === 'drep_always_abstain');
    expect(abstainPut!.delegatorCount).toBeUndefined();
  });

  it('calls the predefined walk exactly once per predefined DRep per sync cycle', async () => {
    mockFetchDRepInfoBatch.mockResolvedValue([]);
    mockFetchPredefinedDRepDelegatorCount.mockResolvedValue({ count: 100, isApprox: false });

    await runDirectorySync();

    // Two predefined DReps → two walks. Each is one walk per cycle —
    // the cost story relies on this (~200 round-trips MAX per cycle in
    // the worst case where both DReps hit their 100-page cap).
    expect(mockFetchPredefinedDRepDelegatorCount).toHaveBeenCalledTimes(2);
    expect(mockFetchPredefinedDRepDelegatorCount).toHaveBeenCalledWith('drep_always_abstain');
    expect(mockFetchPredefinedDRepDelegatorCount).toHaveBeenCalledWith('drep_always_no_confidence');
  });
});

// ============================================================
// Newly-active DRep → auto-post backfill (Batch B, 2026-05-26)
// ============================================================

import { queryItems, putItemIfAbsent } from '../lib/dynamodb';

const mockQueryItems = vi.mocked(queryItems);
const mockPutItemIfAbsent = vi.mocked(putItemIfAbsent);

describe('runDirectorySync — newly-active DRep auto-post backfill', () => {
  beforeEach(() => {
    // Defaults: no active GAs, no auto-post writes. Tests override.
    mockQueryItems.mockResolvedValue({ items: [], count: 0 });
    mockPutItemIfAbsent.mockResolvedValue({ outcome: 'written' });
  });

  it('triggers the auto-post fan-out when a DRep transitions from inactive to active', async () => {
    // Setup: one DRep registered, currently inactive in DDB (existing
    // row has isActive=false). Koios drep_info reports it as ACTIVE
    // this cycle — transition detected. We expect the auto-post
    // backfill to query active GAs and fan-out to this DRep.
    mockListAllDReps.mockResolvedValue([
      { drep_id: 'drep1transitioning', registered: true, has_script: false, hex: '' },
    ]);
    mockFetchDRepInfoBatch.mockImplementation(async (ids) => {
      if (ids.includes('drep_always_abstain')) return []; // predefined call
      return [
        {
          drep_id: 'drep1transitioning',
          hex: null,
          has_script: false,
          drep_status: 'registered',
          deposit: '500000000',
          active: true, // NOW active
          expires_epoch_no: 600,
          amount: '1000000000',
          meta_url: null,
          meta_hash: null,
        },
      ];
    });

    // Existing row in DDB — same DRep but isActive=false. This is the
    // pre-transition state.
    mockBatchGetItems.mockResolvedValue([
      {
        drepId: 'drep1transitioning',
        SK: 'PROFILE',
        entityType: 'DREP_PROFILE',
        hex: null,
        isActive: false, // was inactive last cycle
        isRetired: false,
        status: 'registered',
        deposit: '500000000',
        hasScript: false,
        votingPower: '900000000',
        votingPowerPartition: 'ALL',
        votingPowerSort: '000000000000000900000000',
        expiresEpoch: 600,
        anchorUrl: null,
        anchorHash: null,
        anchorVerified: null,
        voteCount: 0,
        lastSyncedAt: '2026-05-25T00:00:00.000Z',
        enrichmentVersion: 4,
      } as unknown as DRepDirectoryItem,
    ]);

    // Mock the active-GA query (the auto-post backfill calls this).
    mockQueryItems.mockResolvedValue({
      items: [
        {
          actionId: 'ga1#0',
          SK: 'ACTION',
          actionType: 'InfoAction',
          status: 'active',
          title: 'Action 1',
          summary: 'sum1',
          abstract: 'abs1',
        } as never,
        {
          actionId: 'ga2#0',
          SK: 'ACTION',
          actionType: 'InfoAction',
          status: 'active',
          title: 'Action 2',
          summary: 'sum2',
          abstract: 'abs2',
        } as never,
      ],
      count: 2,
    });

    const result = await runDirectorySync();

    // The backfill block must have populated the result.
    expect(result.autoPostBackfill).toBeDefined();
    expect(result.autoPostBackfill!.newlyActiveDReps).toBe(1);
    // 2 active GAs × 1 newly-active DRep = 2 expected fanout calls.
    expect(result.autoPostBackfill!.postsWritten).toBe(2);
    expect(result.autoPostBackfill!.postsErrored).toBe(0);

    // putItemIfAbsent should have been called for each (GA × DRep) pair.
    expect(mockPutItemIfAbsent).toHaveBeenCalledTimes(2);
    const writtenItems = mockPutItemIfAbsent.mock.calls.map(
      (c) => c[1] as Record<string, unknown>,
    );
    const drepIds = writtenItems.map((it) => it['drepId']);
    expect(drepIds).toEqual(['drep1transitioning', 'drep1transitioning']);
    const actionIds = writtenItems.map(
      (it) => (it['autoSource'] as Record<string, unknown>)['actionId'],
    );
    expect(actionIds.sort()).toEqual(['ga1#0', 'ga2#0']);

    // All rows MUST be auto_ga type, pinned, with autoSource present.
    for (const it of writtenItems) {
      expect(it['type']).toBe('auto_ga');
      expect(it['pinned']).toBe(true);
      expect(it['linkedActionId']).toBeDefined();
      expect(it['autoSource']).toBeDefined();
    }
  });

  it('does NOT trigger the backfill when DReps remain in their previous state', async () => {
    // Setup: one DRep that was active last cycle and is STILL active
    // this cycle. No transition → no backfill should fire.
    mockListAllDReps.mockResolvedValue([
      { drep_id: 'drep1stable', registered: true, has_script: false, hex: '' },
    ]);
    mockFetchDRepInfoBatch.mockImplementation(async (ids) => {
      if (ids.includes('drep_always_abstain')) return [];
      return [
        {
          drep_id: 'drep1stable',
          hex: null,
          has_script: false,
          drep_status: 'registered',
          deposit: '500000000',
          active: true,
          expires_epoch_no: 600,
          amount: '1000000000',
          meta_url: null,
          meta_hash: null,
        },
      ];
    });
    mockBatchGetItems.mockResolvedValue([
      {
        drepId: 'drep1stable',
        SK: 'PROFILE',
        entityType: 'DREP_PROFILE',
        hex: null,
        isActive: true, // was ALREADY active last cycle
        isRetired: false,
        status: 'registered',
        deposit: '500000000',
        hasScript: false,
        votingPower: '1000000000',
        votingPowerPartition: 'ALL',
        votingPowerSort: '000000000000000001000000000',
        expiresEpoch: 600,
        anchorUrl: null,
        anchorHash: null,
        anchorVerified: null,
        voteCount: 0,
        lastSyncedAt: '2026-05-25T00:00:00.000Z',
        enrichmentVersion: 4,
      } as unknown as DRepDirectoryItem,
    ]);

    const result = await runDirectorySync();

    // Backfill should be either undefined (no newly-active DReps to
    // process) or populated with newlyActiveDReps=0. Either is OK — the
    // contract is "no fan-out calls happened."
    expect(mockPutItemIfAbsent).not.toHaveBeenCalled();
    if (result.autoPostBackfill) {
      expect(result.autoPostBackfill.newlyActiveDReps).toBe(0);
    }
  });

  it('handles a newly-active DRep with zero currently-active GAs gracefully', async () => {
    // DRep transitions from inactive to active, but there are no
    // active GAs to fan out. The backfill block should still record
    // the newly-active count but write nothing.
    mockListAllDReps.mockResolvedValue([
      { drep_id: 'drep1transitioning', registered: true, has_script: false, hex: '' },
    ]);
    mockFetchDRepInfoBatch.mockImplementation(async (ids) => {
      if (ids.includes('drep_always_abstain')) return [];
      return [
        {
          drep_id: 'drep1transitioning',
          hex: null,
          has_script: false,
          drep_status: 'registered',
          deposit: '500000000',
          active: true,
          expires_epoch_no: 600,
          amount: '1000000000',
          meta_url: null,
          meta_hash: null,
        },
      ];
    });
    mockBatchGetItems.mockResolvedValue([
      {
        drepId: 'drep1transitioning',
        SK: 'PROFILE',
        entityType: 'DREP_PROFILE',
        hex: null,
        isActive: false,
        isRetired: false,
        status: 'registered',
        deposit: '500000000',
        hasScript: false,
        votingPower: '900000000',
        votingPowerPartition: 'ALL',
        votingPowerSort: '000000000000000900000000',
        expiresEpoch: 600,
        anchorUrl: null,
        anchorHash: null,
        anchorVerified: null,
        voteCount: 0,
        lastSyncedAt: '2026-05-25T00:00:00.000Z',
        enrichmentVersion: 4,
      } as unknown as DRepDirectoryItem,
    ]);
    // No active GAs.
    mockQueryItems.mockResolvedValue({ items: [], count: 0 });
    mockPutItemIfAbsent.mockResolvedValue({ outcome: 'written' });

    const result = await runDirectorySync();

    expect(result.autoPostBackfill).toBeDefined();
    expect(result.autoPostBackfill!.newlyActiveDReps).toBe(1);
    expect(result.autoPostBackfill!.postsWritten).toBe(0);
    expect(mockPutItemIfAbsent).not.toHaveBeenCalled();
  });
});
