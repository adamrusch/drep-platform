/**
 * Tests for `GET /governance/stats`.
 *
 * # What we lock in
 *
 * 1. The handler issues four `Query`s against the
 *    `status-submittedAt-index` GSI (one per lifecycle status), not a
 *    full-table Scan. This is the regression guard for the 2026-05-28
 *    Scan→Query migration — if someone reverts to `scanItems`, this test
 *    fails fast.
 * 2. Bucket counts (`byStatus`, `byType`, `byMetadataSource`) and the
 *    `treasuryWithdrawnLovelace` sum match a deterministic fixture. The
 *    sum is computed ONLY from `enacted` TreasuryWithdrawals — active /
 *    expired / dropped withdrawals are intentionally excluded.
 * 3. Multi-page Query pagination: if `lastEvaluatedKey` comes back on the
 *    first page, the handler re-queries with `exclusiveStartKey` set.
 * 4. The cache short-circuits the second call when within the 60s TTL.
 *
 * # Mocking strategy
 *
 * The handler reads via `queryItems(tableNames.governanceActions, ...)`
 * with `indexName: 'status-submittedAt-index'`. We mock `queryItems` to
 * return fixture rows keyed by the status in the request. This mirrors
 * DynamoDB's behavior (Queries return only rows matching the partition
 * key) and lets the test assert that the right fan-out happened without
 * pulling in the AWS SDK.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

vi.mock('../../lib/dynamodb', () => ({
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
    clubhouseComments: 'test-clubhouse_comments',
    poolMetadata: 'test-pool_metadata',
    ccMembers: 'test-cc_members',
    auditLog: 'test-audit_log',
    authNonces: 'test-auth_nonces',
  },
}));

import { queryItems } from '../../lib/dynamodb';
import {
  handler,
  aggregateStats,
  __resetStatsCacheForTests,
} from './stats';
import type { GovernanceActionItem } from '../../lib/types';

const mockQuery = vi.mocked(queryItems);

function buildEvent(): APIGatewayProxyEventV2 {
  return {} as APIGatewayProxyEventV2;
}

function parseBody(body: string | undefined): Record<string, unknown> {
  return JSON.parse(body ?? '{}') as Record<string, unknown>;
}

/**
 * Fixture: a deterministic 8-row slice of `governance_actions` mirroring the
 * mainnet bucket shape. Two TreasuryWithdrawals are enacted (sum =
 * 1_000_000_000 + 2_500_000_000 = 3_500_000_000 lovelace), one is active
 * (NOT counted in the sum), and one is expired (NOT counted in the sum —
 * a withdrawal that never happened shouldn't show up in realized treasury
 * spend).
 */
const FIXTURE: Record<string, Partial<GovernanceActionItem>[]> = {
  active: [
    {
      actionId: 'tx_active_1#0',
      actionType: 'InfoAction',
      status: 'active',
      submittedAt: '2026-04-15T10:00:00.000Z',
      metadataSource: 'on-chain-anchor',
    },
    {
      actionId: 'tx_active_2#0',
      actionType: 'TreasuryWithdrawals',
      status: 'active',
      submittedAt: '2026-05-01T08:00:00.000Z',
      metadataSource: 'on-chain-anchor',
      // Excluded from sum (active, not enacted).
      treasuryWithdrawalLovelace: '999999999999',
    },
    {
      actionId: 'tx_active_3#0',
      actionType: 'ParameterChange',
      status: 'active',
      submittedAt: '2026-05-20T12:30:00.000Z',
      // metadataSource omitted → falls through to "legacy" bucket in
      // aggregateStats. Exercising the fallthrough is the point of
      // leaving this row's source unset.
    },
  ],
  enacted: [
    {
      actionId: 'tx_enacted_1#0',
      actionType: 'TreasuryWithdrawals',
      status: 'enacted',
      submittedAt: '2025-12-01T00:00:00.000Z',
      metadataSource: 'on-chain-anchor',
      treasuryWithdrawalLovelace: '1000000000', // 1B lovelace = 1k ADA
    },
    {
      actionId: 'tx_enacted_2#0',
      actionType: 'TreasuryWithdrawals',
      status: 'enacted',
      submittedAt: '2026-01-15T00:00:00.000Z',
      metadataSource: 'proposal-pillar',
      treasuryWithdrawalLovelace: '2500000000', // 2.5B lovelace
    },
    {
      actionId: 'tx_enacted_3#0',
      actionType: 'InfoAction',
      status: 'enacted',
      submittedAt: '2026-02-01T00:00:00.000Z',
      metadataSource: 'on-chain-anchor',
    },
  ],
  dropped: [
    {
      actionId: 'tx_dropped_1#0',
      actionType: 'HardForkInitiation',
      status: 'dropped',
      submittedAt: '2024-09-15T00:00:00.000Z',
      metadataSource: 'on-chain-anchor',
    },
  ],
  expired: [
    {
      actionId: 'tx_expired_1#0',
      actionType: 'TreasuryWithdrawals',
      status: 'expired',
      // Excluded from sum (expired, not enacted).
      treasuryWithdrawalLovelace: '7777777777',
      submittedAt: '2024-10-01T00:00:00.000Z',
      // metadataSource omitted → falls through to "legacy" bucket.
    },
  ],
};

/** Helper to swap in a fresh queryItems mock that returns the fixture
 *  bucket for the requested status, single page, no LastEvaluatedKey. */
function mockSingleBucketPerStatus(): void {
  mockQuery.mockReset();
  mockQuery.mockImplementation(async (_table, options) => {
    const status = options.expressionAttributeValues?.[':status'] as string;
    const items = (FIXTURE[status] ?? []) as GovernanceActionItem[];
    return { items, count: items.length, lastEvaluatedKey: undefined };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetStatsCacheForTests();
});

describe('governance/stats — Query-based aggregation', () => {
  it('issues one Query per status against the status-submittedAt-index GSI (not a Scan)', async () => {
    mockSingleBucketPerStatus();
    const res = await handler(buildEvent());
    expect((res as { statusCode: number }).statusCode).toBe(200);

    expect(mockQuery).toHaveBeenCalledTimes(4);
    const statusesQueried = mockQuery.mock.calls.map((call) => {
      const opts = call[1] as {
        indexName?: string;
        expressionAttributeValues?: Record<string, unknown>;
      };
      expect(opts.indexName).toBe('status-submittedAt-index');
      return opts.expressionAttributeValues?.[':status'] as string;
    });
    // Order-agnostic — Promise.all does not guarantee invocation order.
    expect(statusesQueried.sort()).toEqual(['active', 'dropped', 'enacted', 'expired']);
  });

  it('aggregates counts and sums correctly against the fixture', async () => {
    mockSingleBucketPerStatus();
    const res = await handler(buildEvent());
    const body = parseBody((res as { body?: string }).body);
    const data = body['data'] as Record<string, unknown>;

    expect(data['total']).toBe(8);
    expect(data['byStatus']).toEqual({
      active: 3,
      enacted: 3,
      dropped: 1,
      expired: 1,
    });
    expect(data['byType']).toEqual({
      InfoAction: 2,
      TreasuryWithdrawals: 4,
      ParameterChange: 1,
      HardForkInitiation: 1,
    });
    expect(data['byMetadataSource']).toEqual({
      'on-chain-anchor': 5,
      'proposal-pillar': 1,
      legacy: 2,
    });
    // Sum: 1_000_000_000 + 2_500_000_000 = 3_500_000_000 lovelace.
    // Active (999_999_999_999) and expired (7_777_777_777) treasury
    // withdrawals are intentionally excluded.
    expect(data['treasuryWithdrawnLovelace']).toBe('3500000000');
    // Earliest/latest across all 8 rows.
    expect(data['earliestSubmittedAt']).toBe('2024-09-15T00:00:00.000Z');
    expect(data['latestSubmittedAt']).toBe('2026-05-20T12:30:00.000Z');
  });

  it('drains a multi-page Query result via exclusiveStartKey', async () => {
    mockQuery.mockReset();
    let callCount = 0;
    mockQuery.mockImplementation(async (_table, options) => {
      const status = options.expressionAttributeValues?.[':status'] as string;
      if (status !== 'active') {
        return { items: [], count: 0, lastEvaluatedKey: undefined };
      }
      callCount += 1;
      if (callCount === 1) {
        // First active-status call → return one row plus a LastEvaluatedKey
        // (which DDB does when the page is full).
        return {
          items: [
            {
              actionId: 'tx_p1#0',
              actionType: 'InfoAction',
              status: 'active',
              submittedAt: '2026-01-01T00:00:00.000Z',
            } as GovernanceActionItem,
          ],
          count: 1,
          lastEvaluatedKey: { actionId: 'tx_p1#0', SK: 'ACTION', status: 'active', submittedAt: '2026-01-01T00:00:00.000Z' },
        };
      }
      // Second active-status call → exclusiveStartKey must have been
      // forwarded so DDB resumes; we hand back a second row + no
      // lastEvaluatedKey (end of page).
      expect(options.exclusiveStartKey).toEqual({
        actionId: 'tx_p1#0',
        SK: 'ACTION',
        status: 'active',
        submittedAt: '2026-01-01T00:00:00.000Z',
      });
      return {
        items: [
          {
            actionId: 'tx_p2#0',
            actionType: 'InfoAction',
            status: 'active',
            submittedAt: '2026-02-01T00:00:00.000Z',
          } as GovernanceActionItem,
        ],
        count: 1,
        lastEvaluatedKey: undefined,
      };
    });

    const res = await handler(buildEvent());
    const body = parseBody((res as { body?: string }).body);
    const data = body['data'] as Record<string, unknown>;
    expect(data['total']).toBe(2);
    expect(data['byStatus']).toEqual({ active: 2 });
    // Two active-status calls + one each for enacted/dropped/expired = 5.
    expect(mockQuery).toHaveBeenCalledTimes(5);
  });

  it('serves the 60s in-Lambda cache on the second call without re-querying', async () => {
    mockSingleBucketPerStatus();
    const first = await handler(buildEvent());
    expect((first as { statusCode: number }).statusCode).toBe(200);
    expect(mockQuery).toHaveBeenCalledTimes(4);

    const second = await handler(buildEvent());
    expect((second as { statusCode: number }).statusCode).toBe(200);
    // No additional queries on the second hit.
    expect(mockQuery).toHaveBeenCalledTimes(4);
    // Payload byte-identical (same JSON for both responses).
    expect((second as { body?: string }).body).toBe((first as { body?: string }).body);
  });

  it('returns 500 when any per-status Query throws (no partial-data leak)', async () => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(async (_table, options) => {
      const status = options.expressionAttributeValues?.[':status'] as string;
      if (status === 'enacted') {
        throw new Error('DDB transient outage');
      }
      return { items: [], count: 0, lastEvaluatedKey: undefined };
    });

    const res = await handler(buildEvent());
    expect((res as { statusCode: number }).statusCode).toBe(500);
  });
});

describe('governance/stats — aggregateStats pure function', () => {
  it('drops rows with non-string status from the byStatus bucket', () => {
    const items = [
      {
        actionId: 'x',
        actionType: 'InfoAction',
        // status undefined / non-string — drops from byStatus
        submittedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        actionId: 'y',
        actionType: 'InfoAction',
        status: 'active',
        submittedAt: '2026-02-01T00:00:00.000Z',
      },
    ] as GovernanceActionItem[];
    const out = aggregateStats(items);
    expect(out.total).toBe(2);
    expect(out.byStatus).toEqual({ active: 1 });
    expect(out.byType).toEqual({ InfoAction: 2 });
  });

  it('treats missing metadataSource as "legacy", not "none"', () => {
    const items = [
      {
        actionId: 'a',
        actionType: 'InfoAction',
        status: 'active',
        submittedAt: '2026-01-01T00:00:00.000Z',
        // metadataSource omitted
      },
    ] as GovernanceActionItem[];
    const out = aggregateStats(items);
    expect(out.byMetadataSource).toEqual({ legacy: 1 });
  });

  it('returns "0" for treasuryWithdrawnLovelace when no enacted TreasuryWithdrawals exist', () => {
    const items = [
      {
        actionId: 'a',
        actionType: 'InfoAction',
        status: 'enacted',
        submittedAt: '2026-01-01T00:00:00.000Z',
      },
    ] as GovernanceActionItem[];
    const out = aggregateStats(items);
    expect(out.treasuryWithdrawnLovelace).toBe('0');
  });

  it('skips a row whose treasuryWithdrawalLovelace is not a parseable BigInt without breaking the sum', () => {
    const items = [
      {
        actionId: 'bad',
        actionType: 'TreasuryWithdrawals',
        status: 'enacted',
        submittedAt: '2026-01-01T00:00:00.000Z',
        treasuryWithdrawalLovelace: 'not-a-number',
      },
      {
        actionId: 'good',
        actionType: 'TreasuryWithdrawals',
        status: 'enacted',
        submittedAt: '2026-02-01T00:00:00.000Z',
        treasuryWithdrawalLovelace: '500',
      },
    ] as GovernanceActionItem[];
    const out = aggregateStats(items);
    expect(out.treasuryWithdrawnLovelace).toBe('500');
  });

  it('ignores 1970-prefixed submittedAt placeholders when computing the date range', () => {
    const items = [
      {
        actionId: 'a',
        actionType: 'InfoAction',
        status: 'active',
        // Sentinel value the sync uses when no real submittedAt was found.
        submittedAt: '1970-01-01T00:00:00.000Z',
      },
      {
        actionId: 'b',
        actionType: 'InfoAction',
        status: 'active',
        submittedAt: '2026-03-01T00:00:00.000Z',
      },
    ] as GovernanceActionItem[];
    const out = aggregateStats(items);
    expect(out.earliestSubmittedAt).toBe('2026-03-01T00:00:00.000Z');
    expect(out.latestSubmittedAt).toBe('2026-03-01T00:00:00.000Z');
  });
});
