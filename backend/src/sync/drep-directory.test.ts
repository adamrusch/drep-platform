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
