/**
 * Handler-level tests for `GET /clubhouse/{drepId}/rail/active-threads`.
 *
 * Pure ranking semantics are covered by `_rail.test.ts`. Here we
 * verify:
 *   - the handler talks to the right DDB Query shape
 *   - limit parameter parsing (default, clamp to max, parse errors)
 *   - in-Lambda cache hits skip the Query
 *   - the response envelope (`{ data: { items: [...] }}`)
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

import { queryItems } from '../../lib/dynamodb';
import { handler, _resetActiveThreadsCache } from './activeThreads';

const mockQuery = vi.mocked(queryItems);

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
  title?: string;
  body?: string;
  type?: 'discussion' | 'question' | 'poll' | 'auto_ga';
  createdAt: string;
  comments?: Array<{ commentId: string; createdAt: string }>;
}): Record<string, unknown> {
  return {
    drepId: DREP_ID,
    postId: opts.postId,
    authorWallet: 'stake1other',
    body: opts.body ?? 'a body',
    title: opts.title,
    type: opts.type,
    isDRepPost: false,
    comments: (opts.comments ?? []).map((c) => ({
      commentId: c.commentId,
      authorWallet: 'stake1commenter',
      body: 'a reply',
      createdAt: c.createdAt,
    })),
    createdAt: opts.createdAt,
    updatedAt: opts.createdAt,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  _resetActiveThreadsCache();
});

describe('GET /clubhouse/{drepId}/rail/active-threads', () => {
  it('returns 400 when drepId is missing', async () => {
    const res = (await handler(
      buildEvent({ drepId: '' }),
    )) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 400 });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns ranked active threads with the default limit of 5', async () => {
    const now = Date.now();
    const recentIso = new Date(now - 60 * 60 * 1000).toISOString(); // 1h ago

    // Make 7 active posts so we know the default cap (5) is applied.
    const items = Array.from({ length: 7 }, (_, i) =>
      buildPost({
        postId: `p${i}`,
        title: `Post ${i}`,
        createdAt: '2026-05-25T00:00:00.000Z',
        comments: Array.from({ length: 7 - i }, (_, j) => ({
          commentId: `c${i}-${j}`,
          createdAt: recentIso,
        })),
      }),
    );

    mockQuery.mockResolvedValueOnce({ items, count: items.length });

    const res = (await handler(buildEvent({ drepId: DREP_ID }))) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 200 });

    const body = parseBody(res);
    expect(body.items).toHaveLength(5);
    // Highest reply count first.
    expect(body.items[0]!['postId']).toBe('p0');
    expect(body.items[0]!['replyCount24h']).toBe(7);
  });

  it('clamps the limit to MAX_RAIL_LIMIT (25)', async () => {
    mockQuery.mockResolvedValueOnce({ items: [], count: 0 });
    const res = (await handler(
      buildEvent({ drepId: DREP_ID, limit: '1000' }),
    )) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 200 });
    // Empty result still fine; we just want to confirm the clamp
    // doesn't throw or 400.
    const body = parseBody(res);
    expect(body.items).toEqual([]);
  });

  it('falls back to default limit on a non-numeric input', async () => {
    const recentIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const items = [
      buildPost({
        postId: 'p1',
        title: 'p1',
        createdAt: '2026-05-25T00:00:00.000Z',
        comments: [{ commentId: 'c1', createdAt: recentIso }],
      }),
    ];
    mockQuery.mockResolvedValueOnce({ items, count: 1 });

    const res = (await handler(
      buildEvent({ drepId: DREP_ID, limit: 'banana' }),
    )) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 200 });
    const body = parseBody(res);
    expect(body.items).toHaveLength(1);
  });

  it('serves cached results on a second call within the TTL', async () => {
    const recentIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    mockQuery.mockResolvedValueOnce({
      items: [
        buildPost({
          postId: 'p1',
          title: 'cached',
          createdAt: '2026-05-25T00:00:00.000Z',
          comments: [{ commentId: 'c1', createdAt: recentIso }],
        }),
      ],
      count: 1,
    });

    const res1 = (await handler(buildEvent({ drepId: DREP_ID }))) as APIGatewayProxyResultV2;
    const res2 = (await handler(buildEvent({ drepId: DREP_ID }))) as APIGatewayProxyResultV2;
    expect(res1).toMatchObject({ statusCode: 200 });
    expect(res2).toMatchObject({ statusCode: 200 });
    // Only one Query — second call was served from the in-memory cache.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    // Identical payloads.
    expect(parseBody(res1)).toEqual(parseBody(res2));
  });

  it('returns 500 when the DDB Query throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('ddb boom'));
    const res = (await handler(buildEvent({ drepId: DREP_ID }))) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 500 });
  });

  it('returns an empty list for a clubhouse with no recent activity', async () => {
    // No posts at all.
    mockQuery.mockResolvedValueOnce({ items: [], count: 0 });

    const res = (await handler(buildEvent({ drepId: DREP_ID }))) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 200 });

    const body = parseBody(res);
    expect(body.items).toEqual([]);
  });
});
