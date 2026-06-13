/**
 * Tests for `clubhouse/list.ts` — Sprint 4 community-flag hide
 * filter on the clubhouse post list. Same visibility contract as
 * `comments/list.test.ts`, applied at the post level.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

vi.mock('../../lib/dynamodb', () => ({
  queryItems: vi.fn(),
  tableNames: { clubhousePosts: 'test-clubhouse_posts' },
}));

import { queryItems } from '../../lib/dynamodb';
import { handler } from './list';

const mockQuery = vi.mocked(queryItems);

function buildEvent(opts: {
  drepId: string;
  roles?: string[];
}): APIGatewayProxyEventV2 {
  const authorizer = opts.roles
    ? {
        lambda: {
          roles: JSON.stringify(opts.roles),
          walletAddress: 'stake1uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        },
      }
    : undefined;
  return {
    pathParameters: { drepId: opts.drepId },
    queryStringParameters: {},
    requestContext: { authorizer } as unknown as APIGatewayProxyEventV2['requestContext'],
    rawPath: '',
    rawQueryString: '',
    headers: {},
    body: null,
    isBase64Encoded: false,
    routeKey: '',
    version: '2.0',
  } as unknown as APIGatewayProxyEventV2;
}

describe('clubhouse/list — community-flag visibility filter', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('EXCLUDES hidden posts for anonymous callers', async () => {
    mockQuery.mockResolvedValueOnce({
      items: [
        { drepId: 'drep1', postId: 'p1', body: 'fine' },
        { drepId: 'drep1', postId: 'p-hidden', body: 'bad', hidden: true },
      ] as never,
      count: 2,
    });

    const res = (await handler(
      buildEvent({ drepId: 'drep1' }),
    )) as APIGatewayProxyResultV2 & { body: string };
    const parsed = JSON.parse(res.body) as {
      data: { items: Array<{ postId: string }> };
    };
    expect(parsed.data.items.map((p) => p.postId)).toEqual(['p1']);
  });

  it('INCLUDES hidden posts for platform_admin with the marker intact', async () => {
    mockQuery.mockResolvedValueOnce({
      items: [
        { drepId: 'drep1', postId: 'p1' },
        { drepId: 'drep1', postId: 'p-hidden', hidden: true, flagCount: 5 },
      ] as never,
      count: 2,
    });

    const res = (await handler(
      buildEvent({ drepId: 'drep1', roles: ['platform_admin'] }),
    )) as APIGatewayProxyResultV2 & { body: string };
    const parsed = JSON.parse(res.body) as {
      data: {
        items: Array<{
          postId: string;
          hidden?: boolean;
          flagCount?: number;
        }>;
      };
    };
    expect(parsed.data.items).toHaveLength(2);
    const hidden = parsed.data.items.find((p) => p.postId === 'p-hidden');
    expect(hidden?.hidden).toBe(true);
    expect(hidden?.flagCount).toBe(5);
  });

  it('projection list includes the new flagCount + hidden fields so the filter has data to act on', async () => {
    mockQuery.mockResolvedValueOnce({ items: [], count: 0 });
    await handler(buildEvent({ drepId: 'drep1' }));

    // The mock captured the query options. Verify the new fields
    // appear in the projection — if the projection regresses, the
    // FE moderation UI would see undefined `hidden` on every row.
    const call = mockQuery.mock.calls[0]!;
    const opts = call[1] as { expressionAttributeNames?: Record<string, string> };
    const projectedFields = Object.values(opts.expressionAttributeNames ?? {});
    expect(projectedFields).toContain('flagCount');
    expect(projectedFields).toContain('hidden');
  });
});
