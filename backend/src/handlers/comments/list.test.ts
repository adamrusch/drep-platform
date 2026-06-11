/**
 * Tests for `comments/list.ts` — Sprint 4 community-flag hide
 * filter on the public list endpoint.
 *
 * Locks the visibility contract:
 *   - Anonymous read → hidden rows EXCLUDED.
 *   - Authenticated non-admin → hidden rows EXCLUDED.
 *   - `platform_admin` → hidden rows INCLUDED with the `hidden: true`
 *     marker so the moderation UI can render its distinct treatment.
 *   - Rows without a `hidden` field render normally for everyone
 *     (back-compat for pre-Sprint-4 rows).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

vi.mock('../../lib/dynamodb', () => ({
  queryItems: vi.fn(),
  tableNames: { comments: 'test-comments' },
}));

import { queryItems } from '../../lib/dynamodb';
import { handler } from './list';

const mockQuery = vi.mocked(queryItems);

function buildEvent(opts: {
  actionId: string;
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
    pathParameters: { actionId: opts.actionId },
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

describe('comments/list — community-flag visibility filter', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('EXCLUDES hidden rows for anonymous (unauthenticated) callers', async () => {
    mockQuery.mockResolvedValueOnce({
      items: [
        { actionId: 'aaaa#0', commentId: 'visible-1', body: 'fine' },
        { actionId: 'aaaa#0', commentId: 'hidden-1', body: 'bad', hidden: true },
        { actionId: 'aaaa#0', commentId: 'visible-2', body: 'fine 2' },
      ] as never,
      count: 3,
    });

    const res = (await handler(
      buildEvent({ actionId: 'aaaa#0' }),
    )) as APIGatewayProxyResultV2 & { body: string };
    const parsed = JSON.parse(res.body) as {
      data: { items: Array<{ commentId: string }> };
    };
    const ids = parsed.data.items.map((c) => c.commentId);
    expect(ids).toEqual(['visible-1', 'visible-2']);
    // Sanity: the hidden one is NOT in the response.
    expect(ids).not.toContain('hidden-1');
  });

  it('EXCLUDES hidden rows for authenticated non-admin callers', async () => {
    mockQuery.mockResolvedValueOnce({
      items: [
        { actionId: 'aaaa#0', commentId: 'visible-1', body: 'fine' },
        { actionId: 'aaaa#0', commentId: 'hidden-1', body: 'bad', hidden: true },
      ] as never,
      count: 2,
    });

    const res = (await handler(
      buildEvent({ actionId: 'aaaa#0', roles: ['delegator', 'lead_drep'] }),
    )) as APIGatewayProxyResultV2 & { body: string };
    const parsed = JSON.parse(res.body) as {
      data: { items: Array<{ commentId: string }> };
    };
    expect(parsed.data.items.map((c) => c.commentId)).toEqual(['visible-1']);
  });

  it('INCLUDES hidden rows for platform_admin (so the moderation UI can render them)', async () => {
    mockQuery.mockResolvedValueOnce({
      items: [
        { actionId: 'aaaa#0', commentId: 'visible-1' },
        { actionId: 'aaaa#0', commentId: 'hidden-1', hidden: true, flagCount: 3 },
      ] as never,
      count: 2,
    });

    const res = (await handler(
      buildEvent({ actionId: 'aaaa#0', roles: ['platform_admin'] }),
    )) as APIGatewayProxyResultV2 & { body: string };
    const parsed = JSON.parse(res.body) as {
      data: {
        items: Array<{ commentId: string; hidden?: boolean; flagCount?: number }>;
      };
    };
    // Both rows present. The hidden row carries its marker so the FE
    // can render the "FLAGGED — HIDDEN" treatment.
    expect(parsed.data.items).toHaveLength(2);
    const hidden = parsed.data.items.find((c) => c.commentId === 'hidden-1');
    expect(hidden?.hidden).toBe(true);
    expect(hidden?.flagCount).toBe(3);
  });

  it('rows WITHOUT a hidden field render for everyone (back-compat for pre-Sprint-4)', async () => {
    mockQuery.mockResolvedValueOnce({
      items: [
        { actionId: 'aaaa#0', commentId: 'no-flag-field' },
        { actionId: 'aaaa#0', commentId: 'hidden-false-explicit', hidden: false },
      ] as never,
      count: 2,
    });
    const res = (await handler(
      buildEvent({ actionId: 'aaaa#0' }),
    )) as APIGatewayProxyResultV2 & { body: string };
    const parsed = JSON.parse(res.body) as {
      data: { items: Array<{ commentId: string }> };
    };
    expect(parsed.data.items.map((c) => c.commentId)).toEqual([
      'no-flag-field',
      'hidden-false-explicit',
    ]);
  });
});
