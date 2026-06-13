/**
 * Tests for `moderation/listFlagged.ts` — the admin queue endpoint.
 *
 * Pins the behaviour required by the brief:
 *   - Returns flagged/hidden items from all three parent tables.
 *   - `?type=` narrows to one table.
 *   - Gated to `platform_admin` (non-admin 403'd before any DDB call).
 *   - Items projected to the queue-card shape with snippet + flagCount
 *     + hidden + createdAt.
 *
 * Mock surface: `scanItems` at the `dynamodb` module boundary so the
 * test exercises orchestration only.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';

vi.mock('../../lib/dynamodb', () => ({
  scanItems: vi.fn(),
  tableNames: {
    comments: 'test-comments',
    clubhousePosts: 'test-clubhouse_posts',
    clubhouseComments: 'test-clubhouse_comments',
  },
}));

import { scanItems } from '../../lib/dynamodb';
import { handler } from './listFlagged';

const mockScan = vi.mocked(scanItems);

const ADMIN_WALLET = 'stake1uadminxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

function buildEvent(opts: {
  walletAddress: string;
  roles?: string[];
  queryStringParameters?: Record<string, string>;
}): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    body: null,
    pathParameters: null,
    queryStringParameters: opts.queryStringParameters ?? null,
    requestContext: {
      authorizer: {
        lambda: {
          walletAddress: opts.walletAddress,
          roles: JSON.stringify(opts.roles ?? ['delegator']),
          sessionType: 'normal',
        },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer['requestContext'],
    rawPath: '',
    rawQueryString: '',
    headers: {},
    isBase64Encoded: false,
    routeKey: '',
    version: '2.0',
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

describe('moderation/listFlagged', () => {
  beforeEach(() => {
    mockScan.mockReset();
  });

  it('rejects a non-platform-admin with 403 before any DDB call', async () => {
    const res = (await handler(
      buildEvent({
        walletAddress: 'stake1unotanadminxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        roles: ['delegator'],
      }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(res.statusCode).toBe(403);
    expect(mockScan).not.toHaveBeenCalled();
  });

  it('returns flagged items from all three tables, sorted newest-first', async () => {
    mockScan
      .mockResolvedValueOnce({
        items: [
          {
            actionId: 'act-1',
            commentId: 'cmt-1',
            walletAddress: 'stake1ua-cmt-1',
            body: 'comment body 1',
            flagCount: 2,
            hidden: false,
            createdAt: '2026-05-25T00:00:00.000Z',
            isPublic: true,
            isDRep: false,
            updatedAt: '2026-05-25T00:00:00.000Z',
          },
        ],
        count: 1,
      } as never)
      .mockResolvedValueOnce({
        items: [
          {
            drepId: 'drep1',
            postId: 'post-1',
            authorWallet: 'stake1ua-post-1',
            body: 'post body 1',
            flagCount: 3,
            hidden: true,
            isDRepPost: false,
            createdAt: '2026-05-26T00:00:00.000Z',
            updatedAt: '2026-05-26T00:00:00.000Z',
          },
        ],
        count: 1,
      } as never)
      .mockResolvedValueOnce({
        items: [
          {
            postKey: 'drep1#post-1',
            commentId: 'ccmt-1',
            drepId: 'drep1',
            postId: 'post-1',
            authorWallet: 'stake1ua-ccmt-1',
            body: 'clubhouse-comment body 1',
            flagCount: 1,
            createdAt: '2026-05-27T00:00:00.000Z',
            depth: 0,
          },
        ],
        count: 1,
      } as never);

    const res = (await handler(
      buildEvent({
        walletAddress: ADMIN_WALLET,
        roles: ['platform_admin'],
      }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body ?? '{}') as {
      data: { items: Array<Record<string, unknown>>; count: number };
    };
    expect(parsed.data.count).toBe(3);
    expect(parsed.data.items[0]?.['type']).toBe('clubhouse_comment'); // newest
    expect(parsed.data.items[1]?.['type']).toBe('clubhouse_post');
    expect(parsed.data.items[2]?.['type']).toBe('comment');

    // The scan call to comments should use the flagged-OR-hidden filter.
    const firstCall = mockScan.mock.calls[0]!;
    expect(firstCall[0]).toBe('test-comments');
    const firstOpts = firstCall[1] as { filterExpression?: string };
    expect(firstOpts.filterExpression).toContain('flagCount');
    expect(firstOpts.filterExpression).toContain('hidden');
  });

  it('respects ?type=comment by scanning ONLY the comments table', async () => {
    mockScan.mockResolvedValueOnce({
      items: [
        {
          actionId: 'act-1',
          commentId: 'cmt-1',
          walletAddress: 'stake1ua-cmt-1',
          body: 'comment body',
          flagCount: 2,
          hidden: false,
          createdAt: '2026-05-25T00:00:00.000Z',
          isPublic: true,
          isDRep: false,
          updatedAt: '2026-05-25T00:00:00.000Z',
        },
      ],
      count: 1,
    } as never);

    const res = (await handler(
      buildEvent({
        walletAddress: ADMIN_WALLET,
        roles: ['platform_admin'],
        queryStringParameters: { type: 'comment' },
      }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(res.statusCode).toBe(200);
    expect(mockScan).toHaveBeenCalledTimes(1);
    expect(mockScan.mock.calls[0]![0]).toBe('test-comments');
    const parsed = JSON.parse(res.body ?? '{}') as {
      data: { items: Array<Record<string, unknown>>; type: string };
    };
    expect(parsed.data.type).toBe('comment');
    expect(parsed.data.items[0]?.['type']).toBe('comment');
    expect(parsed.data.items[0]?.['snippet']).toBe('comment body');
    expect(parsed.data.items[0]?.['flagCount']).toBe(2);
    expect(parsed.data.items[0]?.['hidden']).toBe(false);
  });

  it('rejects an unknown ?type= with 400', async () => {
    const res = (await handler(
      buildEvent({
        walletAddress: ADMIN_WALLET,
        roles: ['platform_admin'],
        queryStringParameters: { type: 'comments' }, // typo
      }),
    )) as APIGatewayProxyStructuredResultV2;
    expect(res.statusCode).toBe(400);
    expect(mockScan).not.toHaveBeenCalled();
  });

  it('truncates a long body to a snippet with an ellipsis', async () => {
    const longBody = 'x'.repeat(400);
    mockScan.mockResolvedValueOnce({
      items: [
        {
          actionId: 'a',
          commentId: 'c',
          walletAddress: 'w',
          body: longBody,
          flagCount: 1,
          hidden: false,
          createdAt: '2026-05-25T00:00:00.000Z',
          isPublic: true,
          isDRep: false,
          updatedAt: '2026-05-25T00:00:00.000Z',
        },
      ],
      count: 1,
    } as never);

    const res = (await handler(
      buildEvent({
        walletAddress: ADMIN_WALLET,
        roles: ['platform_admin'],
        queryStringParameters: { type: 'comment' },
      }),
    )) as APIGatewayProxyStructuredResultV2;

    const parsed = JSON.parse(res.body ?? '{}') as {
      data: { items: Array<Record<string, unknown>> };
    };
    const snippet = parsed.data.items[0]?.['snippet'] as string;
    expect(snippet.length).toBeLessThan(longBody.length);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('returns a hidden-but-not-yet-counted parent row (flagCount=0, hidden=true) — the manual-hide queue path', async () => {
    // An admin pre-hid a row before any community flag. flagCount=0,
    // hidden=true. The queue MUST still surface it so the admin can
    // later unhide.
    mockScan.mockResolvedValueOnce({
      items: [
        {
          actionId: 'a',
          commentId: 'c-manual-hide',
          walletAddress: 'w',
          body: 'manually hidden',
          flagCount: 0,
          hidden: true,
          createdAt: '2026-05-25T00:00:00.000Z',
          isPublic: true,
          isDRep: false,
          updatedAt: '2026-05-25T00:00:00.000Z',
        },
      ],
      count: 1,
    } as never);

    const res = (await handler(
      buildEvent({
        walletAddress: ADMIN_WALLET,
        roles: ['platform_admin'],
        queryStringParameters: { type: 'comment' },
      }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body ?? '{}') as {
      data: { items: Array<Record<string, unknown>> };
    };
    expect(parsed.data.items[0]?.['hidden']).toBe(true);
    expect(parsed.data.items[0]?.['flagCount']).toBe(0);
  });

  it('caps ?limit= at MAX_LIMIT and applies the cap to each parent scan', async () => {
    mockScan.mockResolvedValue({ items: [], count: 0 } as never);

    await handler(
      buildEvent({
        walletAddress: ADMIN_WALLET,
        roles: ['platform_admin'],
        queryStringParameters: { type: 'clubhouse_post', limit: '9999' },
      }),
    );

    const opts = mockScan.mock.calls[0]![1] as { limit?: number };
    expect(opts.limit).toBeLessThanOrEqual(100);
  });
});
