/**
 * Tests for `comments/myVotes.ts` — per-action map of the caller's
 * comment votes.
 *
 * The 2026-05-28 rewrite replaced N parallel Queries (one per comment)
 * with a single `batchGetItems` against the composite-key `comment_votes`
 * table. These tests lock in:
 *
 *   1. The N+1 path is gone — we observe exactly ONE `batchGetItems`
 *      call regardless of how many comments are under the action, and
 *      ZERO per-comment queries against `comment_votes`.
 *   2. The response shape (`{ votes: { [commentId]: 'up' | 'down' } }`)
 *      is preserved byte-for-byte. Missing votes are absent from the
 *      map; existing votes carry the correct direction.
 *   3. Empty action → empty map without any DDB calls past the
 *      initial comment Query.
 *   4. The composite key sent to BatchGet is `{ commentId, stakeAddress
 *      = authCtx.walletAddress }`. Hardcoded — a regression here would
 *      either leak someone else's votes or return an empty map.
 *   5. Missing `actionId` path parameter → 400.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
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
import { handler } from './myVotes';

const mockQuery = vi.mocked(queryItems);
const mockBatchGet = vi.mocked(batchGetItems);

const ACTION_ID = 'aaaaaaaaaaaaaaaa#0';
const VOTER = 'stake1uy0xrh7g8q0eg7e63srdvcqqxnvjvqzhk3fnkflfx5g3dxgrx2hsh';

function buildEvent(opts: {
  walletAddress: string;
  actionId?: string;
}): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    body: null,
    pathParameters: opts.actionId ? { actionId: opts.actionId } : {},
    requestContext: {
      authorizer: {
        lambda: {
          walletAddress: opts.walletAddress,
          roles: JSON.stringify([]),
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

/** Build a fake comment row — only the fields the handler reads. */
function buildComment(commentId: string): Record<string, unknown> {
  return {
    actionId: ACTION_ID,
    commentId,
    walletAddress: 'stake1other',
    body: 'comment text',
    isPublic: true,
    isDRep: false,
    createdAt: '2026-05-25T00:00:00Z',
    updatedAt: '2026-05-25T00:00:00Z',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('comments/myVotes — single BatchGet replaces N+1', () => {
  it('returns an empty map without calling BatchGet when the action has no comments', async () => {
    mockQuery.mockResolvedValueOnce({ items: [], count: 0 });

    const res = (await handler(
      buildEvent({ walletAddress: VOTER, actionId: ACTION_ID }),
    )) as APIGatewayProxyResultV2 as { statusCode: number; body: string };

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ data: { votes: {} } });
    // The whole point: zero BatchGet calls when there's nothing to look up.
    expect(mockBatchGet).not.toHaveBeenCalled();
  });

  it('issues EXACTLY ONE batchGetItems call for an action with many comments', async () => {
    // Realistic shape: 50 comments under a busy action. The previous
    // implementation made 50 Query calls in parallel; we now make 1
    // BatchGet. Whether the user has voted on all / some / none of them
    // is independent — the count is fixed at 1.
    const comments = Array.from({ length: 50 }, (_, i) =>
      buildComment(`01HXM${i.toString().padStart(15, '0')}`),
    );
    mockQuery.mockResolvedValueOnce({ items: comments, count: 50 });
    // BatchGet finds votes on a subset (comments 0, 5, 10) — the rest
    // are missing keys (absent from the result, not present-with-null).
    mockBatchGet.mockResolvedValueOnce([
      { commentId: comments[0]!.commentId, stakeAddress: VOTER, actionId: ACTION_ID, vote: 'up', lovelace: '1', votedAt: '2026' },
      { commentId: comments[5]!.commentId, stakeAddress: VOTER, actionId: ACTION_ID, vote: 'down', lovelace: '1', votedAt: '2026' },
      { commentId: comments[10]!.commentId, stakeAddress: VOTER, actionId: ACTION_ID, vote: 'up', lovelace: '1', votedAt: '2026' },
    ]);

    const res = (await handler(
      buildEvent({ walletAddress: VOTER, actionId: ACTION_ID }),
    )) as APIGatewayProxyResultV2 as { statusCode: number; body: string };

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: { votes: Record<string, string> } };
    expect(body.data.votes[comments[0]!.commentId as string]).toBe('up');
    expect(body.data.votes[comments[5]!.commentId as string]).toBe('down');
    expect(body.data.votes[comments[10]!.commentId as string]).toBe('up');
    // No vote on the other 47 comments — absent, not null.
    expect(Object.keys(body.data.votes)).toHaveLength(3);

    // ONE call to BatchGet, ONE Query for the comments. No per-comment
    // queries against the votes table (the regression we're guarding).
    expect(mockBatchGet).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledWith('test-comments', expect.anything());
  });

  it('passes the composite { commentId, stakeAddress } key to BatchGet for every comment', async () => {
    // Lock the key shape — a regression that flipped the stakeAddress
    // would either leak another user's votes (using a fixed address) or
    // return nothing (using a malformed key).
    const comments = [buildComment('01ABC'), buildComment('01DEF'), buildComment('01GHI')];
    mockQuery.mockResolvedValueOnce({ items: comments, count: 3 });
    mockBatchGet.mockResolvedValueOnce([]);

    await handler(buildEvent({ walletAddress: VOTER, actionId: ACTION_ID }));

    expect(mockBatchGet).toHaveBeenCalledTimes(1);
    const [tableName, keys] = mockBatchGet.mock.calls[0] as [string, Array<Record<string, unknown>>];
    expect(tableName).toBe('test-comment_votes');
    expect(keys).toHaveLength(3);
    expect(keys).toEqual([
      { commentId: '01ABC', stakeAddress: VOTER },
      { commentId: '01DEF', stakeAddress: VOTER },
      { commentId: '01GHI', stakeAddress: VOTER },
    ]);
  });

  it('coerces an unknown vote value to "down" (preserves prior behavior)', async () => {
    // The CommentVoteItem type says `vote: 'up' | 'down'` but at the
    // wire we defensively coerce anything not === 'up' to 'down'. This
    // matches the pre-rewrite ternary on the per-Query path.
    const comments = [buildComment('01ABC'), buildComment('01DEF')];
    mockQuery.mockResolvedValueOnce({ items: comments, count: 2 });
    mockBatchGet.mockResolvedValueOnce([
      { commentId: '01ABC', stakeAddress: VOTER, actionId: ACTION_ID, vote: 'down', lovelace: '1', votedAt: '2026' },
      // Garbage value — coerces to 'down'.
      { commentId: '01DEF', stakeAddress: VOTER, actionId: ACTION_ID, vote: 'unknown', lovelace: '1', votedAt: '2026' },
    ]);

    const res = (await handler(
      buildEvent({ walletAddress: VOTER, actionId: ACTION_ID }),
    )) as APIGatewayProxyResultV2 as { statusCode: number; body: string };

    const body = JSON.parse(res.body) as { data: { votes: Record<string, string> } };
    expect(body.data.votes['01ABC']).toBe('down');
    expect(body.data.votes['01DEF']).toBe('down');
  });

  it('returns 400 when actionId path parameter is missing', async () => {
    const res = (await handler(
      buildEvent({ walletAddress: VOTER }),
    )) as APIGatewayProxyResultV2 as { statusCode: number };

    expect(res.statusCode).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockBatchGet).not.toHaveBeenCalled();
  });
});
