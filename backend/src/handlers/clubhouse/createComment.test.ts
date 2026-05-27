/**
 * Tests for the Clubhouse `createComment` handler depth-guard.
 *
 * The Clubhouse surface allows 2 levels of nesting:
 *   - top-level comment (no parentCommentId)
 *   - reply (parentCommentId points at a top-level comment)
 *   - sub-reply (parentCommentId points at a reply)
 *
 * The 3rd level — a reply targeting a sub-reply — is rejected with 400.
 *
 * This is ONE LEVEL DEEPER than the Public Comments surface (governed by
 * `handlers/comments/create.ts`), so we re-test the depth guard
 * explicitly here rather than reusing the comments tests.
 *
 * Why this matters: the depth guard is the only thing keeping clubhouse
 * comments from arbitrarily deep nesting in the UI. A regression that
 * silently allowed 3+ depth would surface in the UI as ever-more-indented
 * comment threads that wouldn't fit on screen — visible damage, but the
 * server is the authoritative source of truth (UI hides the affordance
 * but must not be trusted alone).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

vi.mock('../../lib/dynamodb', () => ({
  getItem: vi.fn(),
  putItem: vi.fn(),
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

import { getItem, putItem } from '../../lib/dynamodb';
import { handler } from './createComment';

const mockGet = vi.mocked(getItem);
const mockPut = vi.mocked(putItem);

const DREP_ID = 'drep1ygqgayvx8yzsaj9hprja3l6jy3v4px9z3u8uvecuvm3f92ce7mckx';
const POST_ID = 'auto-ga#abcd#0';
const WALLET = 'stake1uyvjdz9rxsfsmv44rtk75k2rqyqskrga96dgdfrqjvjjpwsefcjnp';

function buildEvent(opts: {
  drepId: string;
  postId: string;
  walletAddress: string;
  body: unknown;
}): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    body: JSON.stringify(opts.body),
    pathParameters: { drepId: opts.drepId, postId: opts.postId },
    requestContext: {
      authorizer: {
        lambda: {
          walletAddress: opts.walletAddress,
          roles: JSON.stringify(['delegator']),
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

/** Build a Clubhouse post with a comment graph. Provided as a list of
 *  (commentId, parentCommentId?) tuples, deepest-last for readability. */
function buildPostWithComments(
  graph: Array<{ commentId: string; parentCommentId?: string }>,
): unknown {
  return {
    drepId: DREP_ID,
    postId: POST_ID,
    authorWallet: '_system:governance_feed',
    authorDisplayName: 'drep.tools governance feed',
    isDRepPost: false,
    body: 'auto post body',
    title: 'GA: Test',
    comments: graph.map((g) => ({
      commentId: g.commentId,
      authorWallet: 'stake1othersigner',
      body: 'a comment',
      createdAt: '2026-05-20T00:00:00.000Z',
      ...(g.parentCommentId ? { parentCommentId: g.parentCommentId } : {}),
    })),
    createdAt: '2026-05-20T00:00:00.000Z',
    updatedAt: '2026-05-20T00:00:00.000Z',
    type: 'auto_ga',
    pinned: true,
  };
}

beforeEach(() => {
  // resetAllMocks clears BOTH call history AND any queued mock
  // implementations (mockResolvedValueOnce). clearAllMocks only
  // clears history — which would let a leftover queued return from a
  // previous test leak into this one.
  vi.resetAllMocks();
  mockPut.mockResolvedValue(undefined);
});

describe('clubhouse/createComment — depth guard', () => {
  it('allows top-level comment (no parentCommentId)', async () => {
    mockGet.mockResolvedValueOnce(buildPostWithComments([]) as never);

    const res = (await handler(
      buildEvent({
        drepId: DREP_ID,
        postId: POST_ID,
        walletAddress: WALLET,
        body: { body: 'hello' },
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 200 });
    expect(mockPut).toHaveBeenCalledTimes(1);
    const updatedPost = mockPut.mock.calls[0]![1] as { comments: unknown[] };
    expect(updatedPost.comments).toHaveLength(1);
  });

  it('allows reply to a top-level comment (depth 1)', async () => {
    mockGet.mockResolvedValueOnce(
      buildPostWithComments([{ commentId: 'top1' }]) as never,
    );

    const res = (await handler(
      buildEvent({
        drepId: DREP_ID,
        postId: POST_ID,
        walletAddress: WALLET,
        body: { body: 'reply', parentCommentId: 'top1' },
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 200 });
    expect(mockPut).toHaveBeenCalledTimes(1);
    const updatedPost = mockPut.mock.calls[0]![1] as {
      comments: Array<{ parentCommentId?: string }>;
    };
    const newComment = updatedPost.comments[updatedPost.comments.length - 1]!;
    expect(newComment.parentCommentId).toBe('top1');
  });

  it('allows sub-reply: reply to a reply (depth 2, the Clubhouse cap)', async () => {
    // Post has: top1 (top-level) + reply1 (reply to top1).
    // New comment targets reply1, which would land at depth 2 — allowed.
    mockGet.mockResolvedValueOnce(
      buildPostWithComments([
        { commentId: 'top1' },
        { commentId: 'reply1', parentCommentId: 'top1' },
      ]) as never,
    );

    const res = (await handler(
      buildEvent({
        drepId: DREP_ID,
        postId: POST_ID,
        walletAddress: WALLET,
        body: { body: 'sub-reply', parentCommentId: 'reply1' },
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 200 });
    expect(mockPut).toHaveBeenCalledTimes(1);
  });

  it('REJECTS reply to a sub-reply with 400 (would be depth 3)', async () => {
    // Chain: top1 → reply1 → subreply1.
    // New comment targets subreply1 (depth 2 already), would land at
    // depth 3 — the Clubhouse cap is 2, so reject.
    mockGet.mockResolvedValueOnce(
      buildPostWithComments([
        { commentId: 'top1' },
        { commentId: 'reply1', parentCommentId: 'top1' },
        { commentId: 'subreply1', parentCommentId: 'reply1' },
      ]) as never,
    );

    const res = (await handler(
      buildEvent({
        drepId: DREP_ID,
        postId: POST_ID,
        walletAddress: WALLET,
        body: { body: 'too deep', parentCommentId: 'subreply1' },
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 400 });
    // Must not write — depth guard fires BEFORE the Put.
    expect(mockPut).not.toHaveBeenCalled();
    const body = JSON.parse((res as { body: string }).body) as { message: string };
    expect(body.message).toMatch(/2 levels/);
  });

  it('returns 404 when parentCommentId points at a comment not on this post', async () => {
    mockGet.mockResolvedValueOnce(buildPostWithComments([{ commentId: 'top1' }]) as never);

    const res = (await handler(
      buildEvent({
        drepId: DREP_ID,
        postId: POST_ID,
        walletAddress: WALLET,
        body: { body: 'reply', parentCommentId: 'ghost' },
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 404 });
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('rejects empty body', async () => {
    mockGet.mockResolvedValueOnce(buildPostWithComments([]) as never);
    const res = (await handler(
      buildEvent({
        drepId: DREP_ID,
        postId: POST_ID,
        walletAddress: WALLET,
        body: { body: '   ' },
      }),
    )) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 400 });
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('rejects when post does not exist', async () => {
    mockGet.mockResolvedValueOnce(undefined);
    const res = (await handler(
      buildEvent({
        drepId: DREP_ID,
        postId: POST_ID,
        walletAddress: WALLET,
        body: { body: 'hi' },
      }),
    )) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 404 });
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('rejects non-string parentCommentId with 400', async () => {
    mockGet.mockResolvedValueOnce(buildPostWithComments([{ commentId: 'top1' }]) as never);
    const res = (await handler(
      buildEvent({
        drepId: DREP_ID,
        postId: POST_ID,
        walletAddress: WALLET,
        body: { body: 'hi', parentCommentId: 42 },
      }),
    )) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 400 });
    expect(mockPut).not.toHaveBeenCalled();
  });
});
