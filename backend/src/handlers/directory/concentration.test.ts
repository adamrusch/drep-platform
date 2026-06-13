/**
 * Tests for `GET /dreps/concentration`.
 *
 * Covers:
 *   - PROFILE Query glue: the handler reads through the sparse
 *     `entityType-votingPower-index` GSI and excludes predefined DReps.
 *   - DVT threshold persistence: a fractional `dvt_*` field becomes an
 *     integer percent on the response markers, and duplicate-percent
 *     thresholds are coalesced into one marker.
 *   - Fallback default threshold when the persisted snapshot is absent.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

vi.mock('../../lib/dynamodb', () => ({
  queryItems: vi.fn(),
  batchGetItems: vi.fn(),
  tableNames: {
    drepDirectory: 'test-drep_directory',
    platformState: 'test-platform_state',
  },
}));

import { queryItems, batchGetItems } from '../../lib/dynamodb';
import {
  handler,
  _resetConcentrationCache,
  buildMarkersFromThresholds,
  pickDefaultThresholdPct,
} from './concentration';
import type { DRepDirectoryItem, PlatformDrepDvtThresholdsItem } from '../../lib/types';

const mockQuery = vi.mocked(queryItems);
const mockBatchGet = vi.mocked(batchGetItems);

function makeProfile(
  drepId: string,
  power: bigint,
  overrides: Partial<DRepDirectoryItem> = {},
): DRepDirectoryItem {
  return {
    drepId,
    SK: 'PROFILE',
    entityType: 'DREP_PROFILE',
    hex: null,
    isActive: true,
    status: 'registered',
    deposit: null,
    hasScript: false,
    votingPower: power.toString(),
    votingPowerPartition: 'ALL',
    votingPowerSort: power.toString().padStart(24, '0'),
    expiresEpoch: null,
    anchorUrl: null,
    anchorHash: null,
    anchorVerified: null,
    voteCount: 0,
    lastSyncedAt: '2026-06-01T00:00:00.000Z',
    enrichmentVersion: 4,
    givenName: drepId.toUpperCase(),
    ...overrides,
  } as DRepDirectoryItem;
}

function buildEvent(): APIGatewayProxyEventV2 {
  return {} as APIGatewayProxyEventV2;
}

function parseBody(res: APIGatewayProxyResultV2): {
  data: {
    concentration: { drepCount: number; topK: Array<{ drepId: string; pct: number }>; byPercent: Array<{ count: number; cumPct: number }> };
    markers: Array<{ pct: number; actions: string[] }>;
    defaultThresholdPct: number;
    thresholdsAsOf: string | null;
  };
} {
  const result = res as { body: string };
  return JSON.parse(result.body);
}

describe('GET /dreps/concentration', () => {
  beforeEach(() => {
    _resetConcentrationCache();
    mockQuery.mockReset();
    mockBatchGet.mockReset();
  });

  it('returns the concentration view and excludes predefined DReps', async () => {
    mockQuery.mockResolvedValueOnce({
      items: [
        makeProfile('drep1a', 80n),
        makeProfile('drep1b', 20n),
        makeProfile('drep_always_abstain', 9_000_000_000_000_000n, {
          isPredefined: true,
        }),
      ],
      count: 3,
    });
    mockBatchGet.mockResolvedValueOnce([
      {
        stateKey: 'DREP_DVT_THRESHOLDS',
        epochNo: 500,
        capturedAt: '2026-06-01T00:00:00.000Z',
        dvt_treasury_withdrawal: 0.67,
        dvt_hard_fork_initiation: 0.67,
        dvt_motion_no_confidence: 0.6,
        dvt_committee_no_confidence: 0.6,
      } satisfies PlatformDrepDvtThresholdsItem,
    ]);

    const res = (await handler(buildEvent())) as { statusCode: number; body: string };
    expect(res.statusCode).toBe(200);
    const body = parseBody(res);

    // Predefined excluded — total population is 2.
    expect(body.data.concentration.drepCount).toBe(2);
    expect(body.data.concentration.topK.map((t) => t.drepId)).toEqual(['drep1a', 'drep1b']);
    // 80% dominant DRep crosses 67% alone.
    expect(body.data.concentration.byPercent[67]!.count).toBe(1);

    // Two distinct DVT percents (60% and 67%); duplicate-percent fields
    // are coalesced under one marker.
    const markerPcts = body.data.markers.map((m) => m.pct);
    expect(markerPcts).toEqual([60, 67]);
    const sixty = body.data.markers.find((m) => m.pct === 60)!;
    expect(sixty.actions).toContain('No-confidence motion');
    expect(sixty.actions).toContain('Update committee (no-confidence)');
    const sixtySeven = body.data.markers.find((m) => m.pct === 67)!;
    expect(sixtySeven.actions).toContain('Treasury withdrawal');
    expect(sixtySeven.actions).toContain('Hard fork');

    expect(body.data.defaultThresholdPct).toBe(67);
    expect(body.data.thresholdsAsOf).toBe('2026-06-01T00:00:00.000Z');
  });

  it('falls back to 67% default when no DVT thresholds row exists', async () => {
    mockQuery.mockResolvedValueOnce({
      items: [makeProfile('drep1x', 50n)],
      count: 1,
    });
    mockBatchGet.mockResolvedValueOnce([]);

    const res = (await handler(buildEvent())) as { statusCode: number; body: string };
    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.data.markers).toEqual([]);
    expect(body.data.defaultThresholdPct).toBe(67);
    expect(body.data.thresholdsAsOf).toBeNull();
  });

  it('paginates a multi-page Query result', async () => {
    mockQuery
      .mockResolvedValueOnce({
        items: [makeProfile('drep1page1', 10n)],
        count: 1,
        lastEvaluatedKey: { drepId: 'drep1page1', SK: 'PROFILE' },
      })
      .mockResolvedValueOnce({
        items: [makeProfile('drep1page2', 5n)],
        count: 1,
      });
    mockBatchGet.mockResolvedValueOnce([]);

    const res = (await handler(buildEvent())) as { statusCode: number; body: string };
    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.data.concentration.drepCount).toBe(2);
    // Second Query call must carry exclusiveStartKey.
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const secondCall = mockQuery.mock.calls[1]!;
    expect((secondCall[1] as { exclusiveStartKey?: unknown }).exclusiveStartKey).toEqual({
      drepId: 'drep1page1',
      SK: 'PROFILE',
    });
  });
});

describe('buildMarkersFromThresholds', () => {
  it('drops fields with non-numeric values', () => {
    const row: PlatformDrepDvtThresholdsItem = {
      stateKey: 'DREP_DVT_THRESHOLDS',
      epochNo: 500,
      capturedAt: '2026-06-01T00:00:00Z',
      dvt_treasury_withdrawal: 0.67,
    };
    const markers = buildMarkersFromThresholds(row);
    expect(markers).toEqual([{ pct: 67, actions: ['Treasury withdrawal'] }]);
  });

  it('returns an empty list for an undefined row', () => {
    expect(buildMarkersFromThresholds(undefined)).toEqual([]);
  });
});

describe('pickDefaultThresholdPct', () => {
  it('prefers 67 when it is one of the markers', () => {
    expect(
      pickDefaultThresholdPct([
        { pct: 51, actions: [] },
        { pct: 67, actions: [] },
        { pct: 75, actions: [] },
      ]),
    ).toBe(67);
  });
  it('picks the highest marker ≤ 67 when 67 is missing', () => {
    expect(
      pickDefaultThresholdPct([
        { pct: 51, actions: [] },
        { pct: 60, actions: [] },
        { pct: 75, actions: [] },
      ]),
    ).toBe(60);
  });
  it('defaults to 67 with no markers', () => {
    expect(pickDefaultThresholdPct([])).toBe(67);
  });
});
