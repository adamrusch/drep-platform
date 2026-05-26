/**
 * Regression tests for the directory list handler's read path.
 *
 * # The bug being guarded against (2026-05-26)
 *
 * Previous Scan-with-FilterExpression read path was returning ~800 of 1623
 * PROFILE rows on mainnet because the table also holds ~100k POWER history
 * sub-rows under the same partitions, and the Scan's 50k raw-item budget
 * was being exhausted reading POWER rows rather than reaching all PROFILEs.
 *
 * Fix: switched to Query against a new sparse `entityType-votingPower-index`
 * GSI. The Query is O(PROFILE rows) not O(table size).
 *
 * # What we test
 *
 * 1. Given a Query that returns >=1500 rows across two pages, the handler
 *    accumulates them all and the response carries `total >= 1500`.
 *    This is the regression guard: if someone reverts the Query call to
 *    Scan with the old budget, or sets a too-small accumulator cap, this
 *    test fails fast.
 * 2. The handler issues a Query against the new GSI (`indexName` set,
 *    `keyConditionExpression` partitioned on `entityType='DREP_PROFILE'`),
 *    not a Scan against the base table.
 * 3. Multi-page pagination: when the first Query returns a
 *    `lastEvaluatedKey`, the handler issues another Query with
 *    `exclusiveStartKey` set.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

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
    auditLog: 'test-audit_log',
    authNonces: 'test-auth_nonces',
  },
}));

import { queryItems } from '../../lib/dynamodb';
import { handler, _resetListCache } from './list';
import type { DRepDirectoryItem } from '../../lib/types';

const mockQuery = vi.mocked(queryItems);

/** Build a synthetic PROFILE row at a given index. The `votingPowerSort`
 *  is unique per row so the in-memory comparator has a stable answer. */
function makeRow(i: number): DRepDirectoryItem {
  // 24-char zero-padded numeric string mirrors the production padLeft.
  const power = String(1_000_000_000_000n + BigInt(i)).padStart(24, '0');
  return {
    drepId: `drep1test${i.toString().padStart(8, '0')}`,
    SK: 'PROFILE',
    entityType: 'DREP_PROFILE',
    hex: null,
    isActive: true,
    isRetired: false,
    status: 'registered',
    deposit: null,
    hasScript: false,
    votingPower: power,
    votingPowerPartition: 'ALL',
    votingPowerSort: power,
    expiresEpoch: null,
    anchorUrl: null,
    anchorHash: null,
    anchorVerified: null,
    givenName: `DRep ${i}`,
    givenNameLower: `drep ${i}`,
    lastSyncedAt: '2026-05-26T00:00:00.000Z',
    enrichmentVersion: 4,
  };
}

function buildEvent(qs: Record<string, string>): APIGatewayProxyEventV2 {
  return {
    queryStringParameters: qs,
    requestContext: {} as never,
    rawPath: '/dreps',
    rawQueryString: '',
    headers: {},
    isBase64Encoded: false,
    routeKey: 'GET /dreps',
    version: '2.0',
  } as APIGatewayProxyEventV2;
}

function parseBody(res: APIGatewayProxyResultV2): {
  items: DRepDirectoryItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
} {
  if (typeof res !== 'object' || res === null || !('body' in res) || typeof res.body !== 'string') {
    throw new Error('expected structured response with body');
  }
  // The `ok(data)` helper wraps payloads in `{data: ...}` — peel it off.
  const parsed = JSON.parse(res.body);
  return parsed.data ?? parsed;
}

describe('directory/list handler — Query-against-GSI read path', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    // The handler caches the assembled response keyed by JSON-stringified
    // request params for 30s. Between tests the params often overlap
    // (e.g. two tests with `sort=power, page=0`), so a stale cache hit
    // from a prior test would short-circuit the Query mock and the
    // mock-call assertions would fail. Always reset.
    _resetListCache();
  });

  it('returns >=1500 rows when DynamoDB Query returns >=1500 rows across pages', async () => {
    // Construct two pages: 1000 rows on page 1 (with a lastEvaluatedKey)
    // and 623 rows on page 2 (no lastEvaluatedKey — end of data).
    // 1623 total mirrors the actual mainnet PROFILE count today and is
    // the exact size the previous Scan-based path was failing to return.
    const page1 = Array.from({ length: 1000 }, (_, i) => makeRow(i));
    const page2 = Array.from({ length: 623 }, (_, i) => makeRow(1000 + i));
    mockQuery
      .mockResolvedValueOnce({
        items: page1,
        lastEvaluatedKey: { drepId: 'cursor1', SK: 'PROFILE' },
        count: page1.length,
      })
      .mockResolvedValueOnce({
        items: page2,
        count: page2.length,
      });

    const res = await handler(
      buildEvent({ sort: 'power', includeInactive: 'true', pageSize: '100', page: '0' }),
    );
    const body = parseBody(res);

    // Regression guard: the total must reflect ALL the rows the Query
    // returned, not be silently truncated by an accumulator cap.
    expect(body.total).toBe(1623);
    expect(body.total).toBeGreaterThanOrEqual(1500);
    expect(body.totalPages).toBe(Math.ceil(1623 / 100));
    expect(body.items.length).toBe(100); // pageSize cap

    // Both Query rounds occurred (multi-page pagination).
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('issues a Query against the entityType-votingPower-index GSI, not a Scan', async () => {
    mockQuery.mockResolvedValueOnce({
      items: [makeRow(0)],
      count: 1,
    });

    await handler(
      buildEvent({ sort: 'power', includeInactive: 'true', pageSize: '25', page: '0' }),
    );

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [tableName, opts] = mockQuery.mock.calls[0]!;
    expect(tableName).toBe('test-drep_directory');
    // The GSI name is the sparse-index that scopes to PROFILE rows.
    expect(opts.indexName).toBe('entityType-votingPower-index');
    // Partitioned on the constant `entityType` value.
    expect(opts.keyConditionExpression).toContain('entityType');
    expect(opts.expressionAttributeValues).toMatchObject({
      ':entityType': 'DREP_PROFILE',
    });
  });

  it('issues a follow-up Query with exclusiveStartKey when first page returns lastEvaluatedKey', async () => {
    const cursor = { drepId: 'cursor-x', SK: 'PROFILE' };
    mockQuery
      .mockResolvedValueOnce({
        items: [makeRow(0)],
        lastEvaluatedKey: cursor,
        count: 1,
      })
      .mockResolvedValueOnce({
        items: [makeRow(1)],
        count: 1,
      });

    await handler(
      buildEvent({ sort: 'power', includeInactive: 'true', pageSize: '25', page: '0' }),
    );

    expect(mockQuery).toHaveBeenCalledTimes(2);
    const [, secondOpts] = mockQuery.mock.calls[1]!;
    expect(secondOpts.exclusiveStartKey).toEqual(cursor);
  });

  it('does not include a FilterExpression when no filters apply (avoids DynamoDB rejecting empty FilterExpression)', async () => {
    mockQuery.mockResolvedValueOnce({
      items: [makeRow(0)],
      count: 1,
    });

    // includeInactive=true + no search => empty filter, must NOT be set.
    await handler(
      buildEvent({ sort: 'power', includeInactive: 'true', pageSize: '25', page: '0' }),
    );

    const [, opts] = mockQuery.mock.calls[0]!;
    expect(opts.filterExpression).toBeUndefined();
  });

  it('does include a FilterExpression when toggle is off (default view)', async () => {
    mockQuery.mockResolvedValueOnce({
      items: [makeRow(0)],
      count: 1,
    });

    // Default view (no includeInactive=true) => isActive + isRetired filter.
    await handler(
      buildEvent({ sort: 'power', pageSize: '25', page: '0' }),
    );

    const [, opts] = mockQuery.mock.calls[0]!;
    expect(opts.filterExpression).toBeDefined();
    expect(opts.filterExpression).toContain('#isActive = :true');
  });
});
