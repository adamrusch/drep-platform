/**
 * Handler-level tests for `GET /clubhouse/{drepId}/post/{postId}/comments`.
 *
 * Verifies:
 *   - the Query uses the right partition-key shape
 *     (postKey = `${drepId}#${postId}`)
 *   - response envelope (`{ data: { items: [...] }}`)
 *   - response items strip the partition-key bookkeeping (postKey,
 *     drepId, postId, depth) so the wire shape matches the legacy
 *     `ClubhouseComment` interface the FE already consumes
 *   - missing path parameters return 400
 *   - DDB errors surface as 500
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

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
    auditLog: 'test-audit_log',
    authNonces: 'test-auth_nonces',
  },
}));

import { queryItems } from '../../lib/dynamodb';
import { handler } from './listComments';

const mockQuery = vi.mocked(queryItems);

const DREP_ID = 'drep1ygqgayvx8yzsaj9hprja3l6jy3v4px9z3u8uvecuvm3f92ce7mckx';
const POST_ID = '01HDXY...';

function buildEvent(opts: { drepId?: string; postId?: string }): APIGatewayProxyEventV2 {
  return {
    pathParameters: {
      ...(opts.drepId ? { drepId: opts.drepId } : {}),
      ...(opts.postId ? { postId: opts.postId } : {}),
    },
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

beforeEach(() => {
  vi.resetAllMocks();
});

describe('GET /clubhouse/{drepId}/post/{postId}/comments', () => {
  it('returns 400 when drepId is missing', async () => {
    const res = (await handler(
      buildEvent({ postId: POST_ID }),
    )) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 400 });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 400 when postId is missing', async () => {
    const res = (await handler(
      buildEvent({ drepId: DREP_ID }),
    )) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 400 });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('queries by the composite postKey and returns stripped items', async () => {
    mockQuery.mockResolvedValueOnce({
      items: [
        {
          postKey: `${DREP_ID}#${POST_ID}`,
          commentId: '01HDXY-C1',
          drepId: DREP_ID,
          postId: POST_ID,
          authorWallet: 'stake1commenter1',
          authorDisplayName: 'Alice',
          body: 'top-level comment',
          createdAt: '2026-05-27T10:00:00.000Z',
          depth: 0,
        },
        {
          postKey: `${DREP_ID}#${POST_ID}`,
          commentId: '01HDXY-C2',
          drepId: DREP_ID,
          postId: POST_ID,
          authorWallet: 'stake1commenter2',
          body: 'reply to Alice',
          createdAt: '2026-05-27T10:30:00.000Z',
          parentCommentId: '01HDXY-C1',
          depth: 1,
        },
      ],
      count: 2,
    });

    const res = (await handler(
      buildEvent({ drepId: DREP_ID, postId: POST_ID }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 200 });

    // Query shape: single-partition on `postKey`.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const queryArgs = mockQuery.mock.calls[0]!;
    expect(queryArgs[0]).toBe('test-clubhouse_comments');
    expect(queryArgs[1]).toMatchObject({
      keyConditionExpression: '#pk = :v',
      expressionAttributeNames: { '#pk': 'postKey' },
      expressionAttributeValues: { ':v': `${DREP_ID}#${POST_ID}` },
    });

    const body = parseBody(res);
    expect(body.items).toHaveLength(2);
    // Stripped: no postKey, no drepId, no postId, no depth.
    expect(body.items[0]).toEqual({
      commentId: '01HDXY-C1',
      authorWallet: 'stake1commenter1',
      authorDisplayName: 'Alice',
      body: 'top-level comment',
      createdAt: '2026-05-27T10:00:00.000Z',
    });
    expect(body.items[1]).toEqual({
      commentId: '01HDXY-C2',
      authorWallet: 'stake1commenter2',
      body: 'reply to Alice',
      createdAt: '2026-05-27T10:30:00.000Z',
      parentCommentId: '01HDXY-C1',
    });
  });

  it('returns an empty list for a post with no comments', async () => {
    mockQuery.mockResolvedValueOnce({ items: [], count: 0 });

    const res = (await handler(
      buildEvent({ drepId: DREP_ID, postId: POST_ID }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 200 });
    expect(parseBody(res).items).toEqual([]);
  });

  it('returns 500 when the DDB Query throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('ddb boom'));
    const res = (await handler(
      buildEvent({ drepId: DREP_ID, postId: POST_ID }),
    )) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 500 });
  });

  it('paginates through multiple DDB pages defensively', async () => {
    // First page returns 2 items + LastEvaluatedKey; second page
    // returns 1 item + undefined LastEvaluatedKey → loop terminates.
    mockQuery
      .mockResolvedValueOnce({
        items: [
          {
            postKey: `${DREP_ID}#${POST_ID}`,
            commentId: 'page1-c1',
            drepId: DREP_ID,
            postId: POST_ID,
            authorWallet: 'w1',
            body: 'b1',
            createdAt: '2026-05-27T10:00:00.000Z',
            depth: 0,
          },
        ],
        count: 1,
        lastEvaluatedKey: { postKey: `${DREP_ID}#${POST_ID}`, commentId: 'page1-c1' },
      })
      .mockResolvedValueOnce({
        items: [
          {
            postKey: `${DREP_ID}#${POST_ID}`,
            commentId: 'page2-c1',
            drepId: DREP_ID,
            postId: POST_ID,
            authorWallet: 'w2',
            body: 'b2',
            createdAt: '2026-05-27T11:00:00.000Z',
            depth: 0,
          },
        ],
        count: 1,
      });

    const res = (await handler(
      buildEvent({ drepId: DREP_ID, postId: POST_ID }),
    )) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 200 });
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const body = parseBody(res);
    expect(body.items.map((i) => i['commentId'])).toEqual(['page1-c1', 'page2-c1']);
  });
});
