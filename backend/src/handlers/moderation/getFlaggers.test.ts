/**
 * Tests for `moderation/getFlaggers.ts` — the per-item flagger list.
 *
 * Pins:
 *   - `platform_admin` gate before any DDB call (non-admin → 403).
 *   - `?type=comment` queries `commentFlags` by `commentId`.
 *   - `?type=clubhouse_post` queries `clubhousePostFlags` by `postKey`.
 *   - `?type=clubhouse_comment` queries `clubhouseCommentFlags` by
 *     `postKey` AND in-memory filters to the matching `commentId`.
 *   - Each returned row exposes `flaggerId`, `role`, `createdAt`.
 *   - Missing required params → 400.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';

vi.mock('../../lib/dynamodb', () => ({
  queryItems: vi.fn(),
  tableNames: {
    commentFlags: 'test-comment_flags',
    clubhousePostFlags: 'test-clubhouse_post_flags',
    clubhouseCommentFlags: 'test-clubhouse_comment_flags',
  },
}));

import { queryItems } from '../../lib/dynamodb';
import { handler } from './getFlaggers';

const mockQuery = vi.mocked(queryItems);

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

describe('moderation/getFlaggers', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('rejects a non-platform-admin with 403 before any DDB call', async () => {
    const res = (await handler(
      buildEvent({
        walletAddress: 'stake1unotanadminxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        roles: ['delegator'],
        queryStringParameters: { type: 'comment', commentId: 'c1' },
      }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(res.statusCode).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns the flaggers of a comment via Query(commentFlags, PK=commentId)', async () => {
    mockQuery.mockResolvedValueOnce({
      items: [
        {
          commentId: 'cmt-1',
          flaggerId: 'stake1uflagger-a',
          role: 'drep',
          createdAt: '2026-05-25T00:00:00Z',
        },
        {
          commentId: 'cmt-1',
          flaggerId: 'stake1uflagger-b',
          role: 'cc',
          createdAt: '2026-05-26T00:00:00Z',
        },
      ],
      count: 2,
    } as never);

    const res = (await handler(
      buildEvent({
        walletAddress: ADMIN_WALLET,
        roles: ['platform_admin'],
        queryStringParameters: { type: 'comment', commentId: 'cmt-1' },
      }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(res.statusCode).toBe(200);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const call = mockQuery.mock.calls[0]!;
    expect(call[0]).toBe('test-comment_flags');
    const opts = call[1] as {
      keyConditionExpression: string;
      expressionAttributeValues: Record<string, unknown>;
    };
    expect(opts.keyConditionExpression).toContain('commentId');
    expect(opts.expressionAttributeValues[':commentId']).toBe('cmt-1');

    const parsed = JSON.parse(res.body ?? '{}') as {
      data: {
        type: string;
        count: number;
        flaggers: Array<Record<string, unknown>>;
      };
    };
    expect(parsed.data.type).toBe('comment');
    expect(parsed.data.count).toBe(2);
    // Sorted newest-first.
    expect(parsed.data.flaggers[0]?.['flaggerId']).toBe('stake1uflagger-b');
    expect(parsed.data.flaggers[1]?.['flaggerId']).toBe('stake1uflagger-a');
  });

  it('returns the flaggers of a clubhouse post via Query(clubhousePostFlags, PK=postKey)', async () => {
    mockQuery.mockResolvedValueOnce({
      items: [
        {
          postKey: 'drep1#post-1',
          flaggerId: 'stake1uflagger-a',
          role: 'spo',
          createdAt: '2026-05-25T00:00:00Z',
        },
      ],
      count: 1,
    } as never);

    const res = (await handler(
      buildEvent({
        walletAddress: ADMIN_WALLET,
        roles: ['platform_admin'],
        queryStringParameters: {
          type: 'clubhouse_post',
          drepId: 'drep1',
          postId: 'post-1',
        },
      }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(res.statusCode).toBe(200);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const call = mockQuery.mock.calls[0]!;
    expect(call[0]).toBe('test-clubhouse_post_flags');
    const opts = call[1] as { expressionAttributeValues: Record<string, unknown> };
    expect(opts.expressionAttributeValues[':postKey']).toBe('drep1#post-1');
  });

  it('returns the flaggers of a clubhouse comment, filtering by commentId in-memory', async () => {
    mockQuery.mockResolvedValueOnce({
      items: [
        // Flag on the target comment.
        {
          postKey: 'drep1#post-1',
          commentFlagKey: 'ccmt-1#stake1uflagger-a',
          commentId: 'ccmt-1',
          flaggerId: 'stake1uflagger-a',
          role: 'drep',
          createdAt: '2026-05-25T00:00:00Z',
        },
        // Flag on a SIBLING comment under the same post — must be
        // filtered out.
        {
          postKey: 'drep1#post-1',
          commentFlagKey: 'ccmt-2#stake1uflagger-z',
          commentId: 'ccmt-2',
          flaggerId: 'stake1uflagger-z',
          role: 'cc',
          createdAt: '2026-05-26T00:00:00Z',
        },
      ],
      count: 2,
    } as never);

    const res = (await handler(
      buildEvent({
        walletAddress: ADMIN_WALLET,
        roles: ['platform_admin'],
        queryStringParameters: {
          type: 'clubhouse_comment',
          drepId: 'drep1',
          postId: 'post-1',
          commentId: 'ccmt-1',
        },
      }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body ?? '{}') as {
      data: { count: number; flaggers: Array<Record<string, unknown>> };
    };
    expect(parsed.data.count).toBe(1);
    expect(parsed.data.flaggers[0]?.['flaggerId']).toBe('stake1uflagger-a');
  });

  it('400s when ?type= is missing or unknown', async () => {
    const r1 = (await handler(
      buildEvent({
        walletAddress: ADMIN_WALLET,
        roles: ['platform_admin'],
        queryStringParameters: {},
      }),
    )) as APIGatewayProxyStructuredResultV2;
    expect(r1.statusCode).toBe(400);

    const r2 = (await handler(
      buildEvent({
        walletAddress: ADMIN_WALLET,
        roles: ['platform_admin'],
        queryStringParameters: { type: 'something-else' },
      }),
    )) as APIGatewayProxyStructuredResultV2;
    expect(r2.statusCode).toBe(400);
  });

  it('400s when type=comment is missing commentId', async () => {
    const res = (await handler(
      buildEvent({
        walletAddress: ADMIN_WALLET,
        roles: ['platform_admin'],
        queryStringParameters: { type: 'comment' },
      }),
    )) as APIGatewayProxyStructuredResultV2;
    expect(res.statusCode).toBe(400);
  });

  it('400s when type=clubhouse_comment is missing one of drepId/postId/commentId', async () => {
    const res = (await handler(
      buildEvent({
        walletAddress: ADMIN_WALLET,
        roles: ['platform_admin'],
        queryStringParameters: {
          type: 'clubhouse_comment',
          drepId: 'd1',
          postId: 'p1',
          // commentId omitted
        },
      }),
    )) as APIGatewayProxyStructuredResultV2;
    expect(res.statusCode).toBe(400);
  });
});
