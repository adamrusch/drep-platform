/**
 * Handler-level tests for `GET /clubhouse/{drepId}/rail/top-contributors`.
 *
 * Pure ranking semantics are covered by `_rail.test.ts`. Here we
 * verify:
 *   - the handler talks to the right DDB Query shape
 *   - displayName batchGet against the `users` table
 *   - cache hits skip both Query and BatchGet
 *   - degraded path when `users` BatchGet errors (return contributors
 *     without `displayName`, no 5xx)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

vi.mock('../../lib/dynamodb', () => ({
  queryItems: vi.fn(),
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

import { queryItems, batchGetItems } from '../../lib/dynamodb';
import { handler, _resetTopContributorsCache } from './topContributors';

const mockQuery = vi.mocked(queryItems);
const mockBatchGet = vi.mocked(batchGetItems);

const DREP_ID = 'drep1ygqgayvx8yzsaj9hprja3l6jy3v4px9z3u8uvecuvm3f92ce7mckx';

function buildEvent(opts: {
  drepId: string;
  limit?: string;
}): APIGatewayProxyEventV2 {
  return {
    pathParameters: { drepId: opts.drepId },
    queryStringParameters: opts.limit !== undefined ? { limit: opts.limit } : null,
    rawPath: '',
    rawQueryString: '',
    headers: {},
    isBase64Encoded: false,
    routeKey: '',
    version: '2.0',
    requestContext: {} as never,
  } as unknown as APIGatewayProxyEventV2;
}

function parseBody(res: APIGatewayProxyResultV2): { items: Array<Record<string, unknown>> } {
  if (typeof res !== 'object' || res === null) throw new Error('expected object response');
  const r = res as { body?: string };
  if (typeof r.body !== 'string') throw new Error('expected body string');
  const wrapper = JSON.parse(r.body) as { data: { items: Array<Record<string, unknown>> } };
  return wrapper.data;
}

function buildPost(opts: {
  postId: string;
  authorWallet: string;
  createdAt: string;
  comments?: Array<{ commentId: string; authorWallet: string; createdAt: string }>;
}): Record<string, unknown> {
  return {
    drepId: DREP_ID,
    postId: opts.postId,
    authorWallet: opts.authorWallet,
    body: 'a body',
    isDRepPost: false,
    comments: (opts.comments ?? []).map((c) => ({
      commentId: c.commentId,
      authorWallet: c.authorWallet,
      body: 'a reply',
      createdAt: c.createdAt,
    })),
    createdAt: opts.createdAt,
    updatedAt: opts.createdAt,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  _resetTopContributorsCache();
});

describe('GET /clubhouse/{drepId}/rail/top-contributors', () => {
  it('returns 400 when drepId is missing', async () => {
    const res = (await handler(
      buildEvent({ drepId: '' }),
    )) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 400 });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns top N contributors with resolved display names', async () => {
    mockQuery.mockResolvedValueOnce({
      items: [
        buildPost({
          postId: 'p1',
          authorWallet: 'walletA',
          createdAt: '2026-05-20T00:00:00.000Z',
          comments: [
            { commentId: 'c1', authorWallet: 'walletB', createdAt: '2026-05-21T00:00:00.000Z' },
            { commentId: 'c2', authorWallet: 'walletA', createdAt: '2026-05-22T00:00:00.000Z' },
          ],
        }),
      ],
      count: 1,
    });
    mockBatchGet.mockResolvedValueOnce([
      { walletAddress: 'walletA', SK: 'PROFILE', displayName: 'Alice' } as never,
      // walletB has no displayName attribute set → undefined in the row
      { walletAddress: 'walletB', SK: 'PROFILE' } as never,
    ]);

    const res = (await handler(buildEvent({ drepId: DREP_ID }))) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 200 });

    const body = parseBody(res);
    expect(body.items).toHaveLength(2);
    // walletA: 1 post + 1 comment = 2
    expect(body.items[0]).toMatchObject({
      walletAddress: 'walletA',
      contributionCount: 2,
      displayName: 'Alice',
    });
    // walletB: 1 comment, no displayName resolved
    expect(body.items[1]).toMatchObject({ walletAddress: 'walletB', contributionCount: 1 });
    expect('displayName' in body.items[1]!).toBe(false);
  });

  it('serves contributors without displayName when BatchGet throws', async () => {
    mockQuery.mockResolvedValueOnce({
      items: [
        buildPost({
          postId: 'p1',
          authorWallet: 'walletA',
          createdAt: '2026-05-20T00:00:00.000Z',
        }),
      ],
      count: 1,
    });
    mockBatchGet.mockRejectedValueOnce(new Error('users table boom'));

    const res = (await handler(buildEvent({ drepId: DREP_ID }))) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 200 });

    const body = parseBody(res);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ walletAddress: 'walletA', contributionCount: 1 });
    expect('displayName' in body.items[0]!).toBe(false);
  });

  it('serves cached results on a second call within the TTL', async () => {
    mockQuery.mockResolvedValueOnce({
      items: [
        buildPost({
          postId: 'p1',
          authorWallet: 'walletA',
          createdAt: '2026-05-20T00:00:00.000Z',
        }),
      ],
      count: 1,
    });
    mockBatchGet.mockResolvedValueOnce([]);

    const res1 = (await handler(buildEvent({ drepId: DREP_ID }))) as APIGatewayProxyResultV2;
    const res2 = (await handler(buildEvent({ drepId: DREP_ID }))) as APIGatewayProxyResultV2;
    expect(res1).toMatchObject({ statusCode: 200 });
    expect(res2).toMatchObject({ statusCode: 200 });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockBatchGet).toHaveBeenCalledTimes(1);
    expect(parseBody(res1)).toEqual(parseBody(res2));
  });

  it('returns empty items when the clubhouse has no posts', async () => {
    mockQuery.mockResolvedValueOnce({ items: [], count: 0 });

    const res = (await handler(buildEvent({ drepId: DREP_ID }))) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 200 });

    const body = parseBody(res);
    expect(body.items).toEqual([]);
    // No need to BatchGet when there are zero contributors.
    expect(mockBatchGet).not.toHaveBeenCalled();
  });

  it('returns 500 when the DDB Query throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('ddb boom'));
    const res = (await handler(buildEvent({ drepId: DREP_ID }))) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 500 });
  });

  it('respects an explicit limit param', async () => {
    mockQuery.mockResolvedValueOnce({
      items: [
        buildPost({
          postId: 'p1',
          authorWallet: 'walletA',
          createdAt: '2026-05-20T00:00:00.000Z',
        }),
        buildPost({
          postId: 'p2',
          authorWallet: 'walletB',
          createdAt: '2026-05-21T00:00:00.000Z',
        }),
        buildPost({
          postId: 'p3',
          authorWallet: 'walletC',
          createdAt: '2026-05-22T00:00:00.000Z',
        }),
      ],
      count: 3,
    });
    mockBatchGet.mockResolvedValueOnce([]);

    const res = (await handler(
      buildEvent({ drepId: DREP_ID, limit: '2' }),
    )) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 200 });

    const body = parseBody(res);
    expect(body.items).toHaveLength(2);
  });
});
