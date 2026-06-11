/**
 * Sprint 5 — focused tests for the DVT thresholds snapshot step of
 * `runDirectorySync`. The rest of the sync is exercised in
 * `drep-directory.test.ts`; this file pins the new step's compare-then-
 * write idempotency and the "Koios unavailable" fallback.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../lib/koios', () => ({
  listAllDReps: vi.fn().mockResolvedValue([]),
  fetchDRepInfoBatch: vi.fn().mockResolvedValue([]),
  fetchDRepMetadata: vi.fn().mockResolvedValue([]),
  fetchPredefinedDRepDelegatorCount: vi.fn().mockResolvedValue(null),
  listAllVotes: vi.fn().mockResolvedValue([]),
  getCurrentEpoch: vi.fn(),
  getEpochParams: vi.fn(),
  KoiosError: class KoiosError extends Error {
    public readonly endpoint: string;
    constructor(endpoint: string, message: string) {
      super(`[Koios ${endpoint}] ${message}`);
      this.name = 'KoiosError';
      this.endpoint = endpoint;
    }
  },
}));

vi.mock('../lib/dynamodb', () => ({
  putItem: vi.fn().mockResolvedValue(undefined),
  batchGetItems: vi.fn().mockResolvedValue([]),
  queryItems: vi.fn().mockResolvedValue({ items: [], count: 0 }),
  putItemIfAbsent: vi.fn(),
  docClient: { send: vi.fn() },
  tableNames: {
    drepDirectory: 'test-drep_directory',
    platformState: 'test-platform_state',
    governanceActions: 'test-governance_actions',
  },
}));

vi.mock('../lib/dreps/avatarStore', () => ({
  storeDrepAvatars: vi.fn().mockResolvedValue({ scanned: 0, stored: 0, cleared: 0, failed: 0 }),
  s3AvatarBucket: vi.fn(() => ({
    put: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
  })),
}));

import { getCurrentEpoch, getEpochParams } from '../lib/koios';
import { putItem, batchGetItems } from '../lib/dynamodb';
import { runDirectorySync } from './drep-directory';

const mockGetCurrentEpoch = vi.mocked(getCurrentEpoch);
const mockGetEpochParams = vi.mocked(getEpochParams);
const mockPutItem = vi.mocked(putItem);
const mockBatchGetItems = vi.mocked(batchGetItems);

beforeEach(() => {
  vi.clearAllMocks();
  mockBatchGetItems.mockResolvedValue([]);
});

describe('runDirectorySync — DVT thresholds snapshot (Sprint 5)', () => {
  it('writes the persisted row and returns "written" on a cold-start cycle', async () => {
    mockGetCurrentEpoch.mockResolvedValue(500);
    mockGetEpochParams.mockResolvedValue({
      dvt_treasury_withdrawal: 0.67,
      dvt_motion_no_confidence: 0.6,
    });

    const r = await runDirectorySync();
    expect(r.dvtThresholds).toBe('written');
    // Find the platform_state Put.
    const putCalls = mockPutItem.mock.calls.filter(
      (c) => c[0] === 'test-platform_state',
    );
    expect(putCalls).toHaveLength(1);
    const persisted = putCalls[0]![1] as Record<string, unknown>;
    expect(persisted['stateKey']).toBe('DREP_DVT_THRESHOLDS');
    expect(persisted['epochNo']).toBe(500);
    expect(persisted['dvt_treasury_withdrawal']).toBe(0.67);
  });

  it('returns "skipped" when the existing row matches the fresh response', async () => {
    mockGetCurrentEpoch.mockResolvedValue(500);
    mockGetEpochParams.mockResolvedValue({
      dvt_treasury_withdrawal: 0.67,
    });
    // Return a matching existing row from the platform_state BatchGet.
    mockBatchGetItems.mockImplementation(async (table) => {
      if (table === 'test-platform_state') {
        return [
          {
            stateKey: 'DREP_DVT_THRESHOLDS',
            epochNo: 500,
            capturedAt: '2026-05-01T00:00:00.000Z',
            dvt_treasury_withdrawal: 0.67,
          },
        ];
      }
      return [];
    });

    const r = await runDirectorySync();
    expect(r.dvtThresholds).toBe('skipped');
    const putCalls = mockPutItem.mock.calls.filter(
      (c) => c[0] === 'test-platform_state',
    );
    expect(putCalls).toHaveLength(0);
  });

  it('returns "unavailable" when Koios /epoch_params fails', async () => {
    mockGetCurrentEpoch.mockResolvedValue(500);
    mockGetEpochParams.mockResolvedValue(null);

    const r = await runDirectorySync();
    expect(r.dvtThresholds).toBe('unavailable');
    const putCalls = mockPutItem.mock.calls.filter(
      (c) => c[0] === 'test-platform_state',
    );
    expect(putCalls).toHaveLength(0);
  });

  it('returns "unavailable" when Koios /tip fails (getCurrentEpoch throws)', async () => {
    mockGetCurrentEpoch.mockRejectedValue(new Error('Koios timeout'));

    const r = await runDirectorySync();
    expect(r.dvtThresholds).toBe('unavailable');
  });
});
