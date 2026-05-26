/**
 * Tests for `comments/vote.ts` — the stake-weighted up/downvote handler.
 *
 * What we lock in:
 *   1. Anonymous rejected (the route is auth-only; we still test for
 *      missing `walletAddress` in the authorizer context, which surfaces
 *      as 401).
 *   2. Authors cannot vote on their OWN comment — blocked at 400 with a
 *      "delete to retract" hint.
 *   3. First-time vote: lovelace is snapshotted from `lookupStake` and
 *      written to a new vote row; comment counters move by the right
 *      delta.
 *   4. Recast (up → down): vote row is overwritten with the new
 *      direction + a FRESH lovelace snapshot (not the prior value);
 *      counter delta = `-prior - new`.
 *   5. Stake-lookup both-failed: vote handler hard-rejects with 500.
 *      (Different policy from create.ts because a zero-weight recast
 *      from a real wallet would distort the displayed support level.)
 *   6. Idempotent same-vote: voting the same direction twice is a
 *      no-op; transactWrite is NOT called.
 *
 * # Mocking strategy
 *
 * `transactWrite` is the single mutation. We grab the first call's items
 * array and inspect the Put + Update payloads. The lovelace delta on the
 * Update is the most load-bearing assertion — that's what powers the
 * displayed "Support Level: ±X ADA."
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

vi.mock('../../lib/dynamodb', () => ({
  getItem: vi.fn(),
  transactWrite: vi.fn(),
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

vi.mock('../../lib/recognition', () => ({
  lookupStake: vi.fn(),
}));

import { getItem, transactWrite } from '../../lib/dynamodb';
import { lookupStake } from '../../lib/recognition';
import { handler } from './vote';

const mockGet = vi.mocked(getItem);
const mockTransact = vi.mocked(transactWrite);
const mockStake = vi.mocked(lookupStake);

const ACTION_ID = 'aaaaaaaa#0';
const COMMENT_ID = '01HXMHTEST123ABCDEF';
const VOTER = 'stake1uy0xrh7g8q0eg7e63srdvcqqxnvjvqzhk3fnkflfx5g3dxgrx2hsh';
const AUTHOR = 'stake1uyvjdz9rxsfsmv44rtk75k2rqyqskrga96dgdfrqjvjjpwsefcjnp';
const VOTER_LOVELACE = '2000000000000'; // 2M ADA
const VOTER_LOVELACE_AFTER_RECAST = '2100000000000'; // 2.1M ADA — different snapshot

function buildEvent(opts: {
  walletAddress: string | null;
  roles: string[];
  actionId: string;
  commentId: string;
  body: unknown;
}): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    body: JSON.stringify(opts.body),
    pathParameters: { actionId: opts.actionId, commentId: opts.commentId },
    requestContext: {
      authorizer: {
        lambda: {
          // Some tests want to omit walletAddress entirely (anonymous path).
          ...(opts.walletAddress ? { walletAddress: opts.walletAddress } : {}),
          roles: JSON.stringify(opts.roles),
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

function buildComment(authorWallet: string, supportLovelace: string): unknown {
  return {
    actionId: ACTION_ID,
    commentId: COMMENT_ID,
    walletAddress: authorWallet,
    body: 'a comment',
    isPublic: true,
    isDRep: false,
    createdAt: '2026-05-25T00:00:00Z',
    updatedAt: '2026-05-25T00:00:00Z',
    supportLovelace,
    upvoteCount: 1,
    downvoteCount: 0,
  };
}

describe('comments/vote', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockTransact.mockReset();
    mockTransact.mockResolvedValue(undefined);
    mockStake.mockReset();
    mockStake.mockResolvedValue({ lovelace: VOTER_LOVELACE, source: 'koios' });
  });

  it('rejects anonymous calls with 401', async () => {
    // No walletAddress in the authorizer context — the role-guard
    // middleware throws an AuthorizationError which `handleError`
    // converts to 401.
    const res = (await handler(
      buildEvent({
        walletAddress: null,
        roles: [],
        actionId: ACTION_ID,
        commentId: COMMENT_ID,
        body: { vote: 'up' },
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 401 });
    expect(mockTransact).not.toHaveBeenCalled();
  });

  it('rejects voting on your own comment with 400', async () => {
    mockGet.mockResolvedValueOnce(buildComment(VOTER, '1000000000') as never);

    const res = (await handler(
      buildEvent({
        walletAddress: VOTER, // voter === author
        roles: ['delegator'],
        actionId: ACTION_ID,
        commentId: COMMENT_ID,
        body: { vote: 'up' },
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 400 });
    expect(mockTransact).not.toHaveBeenCalled();
  });

  it('casts a first-time upvote with the snapshotted lovelace', async () => {
    // Get #1: the comment row. Get #2: the prior vote (none).
    mockGet.mockResolvedValueOnce(buildComment(AUTHOR, '5000000000000') as never);
    mockGet.mockResolvedValueOnce(undefined); // no prior vote
    // Get #3 (after transactWrite): re-read for response.
    mockGet.mockResolvedValueOnce({
      ...(buildComment(AUTHOR, '7000000000000') as Record<string, unknown>),
      upvoteCount: 2,
    } as never);

    const res = (await handler(
      buildEvent({
        walletAddress: VOTER,
        roles: ['delegator'],
        actionId: ACTION_ID,
        commentId: COMMENT_ID,
        body: { vote: 'up' },
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 200 });

    // The transactWrite items array shape:
    //   [0] ConditionCheck (attribute_not_exists on prior vote)
    //   [1] Put new vote row
    //   [2] Update comment counter
    const items = mockTransact.mock.calls[0]![0];
    expect(items).toHaveLength(3);

    type T = Array<{
      Put?: { TableName: string; Item: Record<string, unknown> };
      Update?: {
        TableName: string;
        Key: Record<string, unknown>;
        ExpressionAttributeValues: Record<string, unknown>;
      };
      ConditionCheck?: { TableName: string };
    }>;
    const t = items as T;

    // Vote row carries the snapshot.
    const votePut = t[1]!.Put!;
    expect(votePut.TableName).toBe('test-comment_votes');
    expect(votePut.Item['vote']).toBe('up');
    expect(votePut.Item['lovelace']).toBe(VOTER_LOVELACE);
    expect(votePut.Item['stakeAddress']).toBe(VOTER);

    // Counter delta on the comment row.
    const update = t[2]!.Update!;
    expect(update.TableName).toBe('test-comments');
    // Positive delta for an upvote (new contribution +VOTER_LOVELACE, no prior).
    expect(update.ExpressionAttributeValues[':delta']).toBe(VOTER_LOVELACE);
    expect(update.ExpressionAttributeValues[':upD']).toBe(1);
    expect(update.ExpressionAttributeValues[':downD']).toBe(0);
  });

  it('recasts up → down with a FRESH lovelace snapshot and correct delta', async () => {
    // Prior upvote at the old lovelace amount. Recast to down. The new
    // row carries the FRESH snapshot, not the prior one.
    mockGet.mockResolvedValueOnce(buildComment(AUTHOR, '5000000000000') as never);
    mockGet.mockResolvedValueOnce({
      commentId: COMMENT_ID,
      stakeAddress: VOTER,
      actionId: ACTION_ID,
      vote: 'up',
      lovelace: VOTER_LOVELACE, // prior snapshot
      votedAt: '2026-05-25T00:00:00Z',
    } as never);
    // Mock the fresh stake snapshot to differ from the prior — proves
    // the handler used the live read, not the persisted prior.
    mockStake.mockResolvedValueOnce({
      lovelace: VOTER_LOVELACE_AFTER_RECAST,
      source: 'koios',
    });
    mockGet.mockResolvedValueOnce({
      ...(buildComment(AUTHOR, '900000000000') as Record<string, unknown>),
      upvoteCount: 0,
      downvoteCount: 1,
    } as never);

    const res = (await handler(
      buildEvent({
        walletAddress: VOTER,
        roles: ['delegator'],
        actionId: ACTION_ID,
        commentId: COMMENT_ID,
        body: { vote: 'down' },
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 200 });

    const items = mockTransact.mock.calls[0]![0];
    type T = Array<{
      Put?: { TableName: string; Item: Record<string, unknown> };
      Update?: { ExpressionAttributeValues: Record<string, unknown> };
      ConditionCheck?: {
        TableName: string;
        ExpressionAttributeValues?: Record<string, unknown>;
      };
    }>;
    const t = items as T;

    // ConditionCheck must reference the prior vote's row exactly — this
    // is the optimistic-concurrency guard against a racing recast.
    const cc = t[0]!.ConditionCheck!;
    expect(cc.TableName).toBe('test-comment_votes');
    expect(cc.ExpressionAttributeValues![':prevVote']).toBe('up');
    expect(cc.ExpressionAttributeValues![':prevLov']).toBe(VOTER_LOVELACE);

    // New vote row uses the FRESH snapshot, not the prior.
    const votePut = t[1]!.Put!;
    expect(votePut.Item['vote']).toBe('down');
    expect(votePut.Item['lovelace']).toBe(VOTER_LOVELACE_AFTER_RECAST);

    // Counter delta: `new - prior` = `-VOTER_LOVELACE_AFTER_RECAST - VOTER_LOVELACE`
    // (the upvote was +prior, the new downvote is -new, so we go from
    // +prior to -new, a net change of -(prior + new)).
    const update = t[2]!.Update!;
    const expectedDelta = (
      BigInt(0) -
      BigInt(VOTER_LOVELACE_AFTER_RECAST) -
      BigInt(VOTER_LOVELACE)
    ).toString();
    expect(update.ExpressionAttributeValues[':delta']).toBe(expectedDelta);
    // Headcount: -1 up, +1 down.
    expect(update.ExpressionAttributeValues[':upD']).toBe(-1);
    expect(update.ExpressionAttributeValues[':downD']).toBe(1);
  });

  it('rejects with 500 when stake lookup fails on both providers', async () => {
    // Comment exists, no prior vote, and lookup is down. We must NOT
    // record a zero-weight vote silently — that would distort the
    // support level. Surface the outage instead.
    mockGet.mockResolvedValueOnce(buildComment(AUTHOR, '5000000000000') as never);
    mockGet.mockResolvedValueOnce(undefined);
    mockStake.mockResolvedValueOnce({ lovelace: null, source: null });

    const res = (await handler(
      buildEvent({
        walletAddress: VOTER,
        roles: ['delegator'],
        actionId: ACTION_ID,
        commentId: COMMENT_ID,
        body: { vote: 'up' },
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 500 });
    expect(mockTransact).not.toHaveBeenCalled();
  });

  it('is idempotent: voting the same direction twice does NOT re-write', async () => {
    // Prior upvote exists. Voting "up" again is a no-op — don't burn a
    // transact + write a new timestamp / re-snapshot lovelace.
    mockGet.mockResolvedValueOnce(buildComment(AUTHOR, '5000000000000') as never);
    mockGet.mockResolvedValueOnce({
      commentId: COMMENT_ID,
      stakeAddress: VOTER,
      actionId: ACTION_ID,
      vote: 'up',
      lovelace: VOTER_LOVELACE,
      votedAt: '2026-05-25T00:00:00Z',
    } as never);
    mockGet.mockResolvedValueOnce(buildComment(AUTHOR, '7000000000000') as never);

    const res = (await handler(
      buildEvent({
        walletAddress: VOTER,
        roles: ['delegator'],
        actionId: ACTION_ID,
        commentId: COMMENT_ID,
        body: { vote: 'up' },
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 200 });
    // No mutation — the early-return short-circuit hit.
    expect(mockTransact).not.toHaveBeenCalled();
  });

  it('removes a vote with the right negative delta', async () => {
    mockGet.mockResolvedValueOnce(buildComment(AUTHOR, '7000000000000') as never);
    mockGet.mockResolvedValueOnce({
      commentId: COMMENT_ID,
      stakeAddress: VOTER,
      actionId: ACTION_ID,
      vote: 'up',
      lovelace: VOTER_LOVELACE,
      votedAt: '2026-05-25T00:00:00Z',
    } as never);
    mockGet.mockResolvedValueOnce(buildComment(AUTHOR, '5000000000000') as never);

    const res = (await handler(
      buildEvent({
        walletAddress: VOTER,
        roles: ['delegator'],
        actionId: ACTION_ID,
        commentId: COMMENT_ID,
        body: { vote: 'none' },
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 200 });
    const items = mockTransact.mock.calls[0]![0];
    type T = Array<{
      Delete?: { TableName: string };
      Update?: { ExpressionAttributeValues: Record<string, unknown> };
      ConditionCheck?: { TableName: string };
    }>;
    const t = items as T;

    // Order: ConditionCheck, Delete, Update.
    expect(t[1]!.Delete!.TableName).toBe('test-comment_votes');
    // Removing an upvote → counter goes DOWN by the prior lovelace.
    const update = t[2]!.Update!;
    expect(update.ExpressionAttributeValues[':delta']).toBe(
      (-BigInt(VOTER_LOVELACE)).toString(),
    );
    expect(update.ExpressionAttributeValues[':upD']).toBe(-1);
    expect(update.ExpressionAttributeValues[':downD']).toBe(0);
  });

  it('rejects malformed vote value with 400', async () => {
    // No DB access required — the validation runs before any reads.
    const res = (await handler(
      buildEvent({
        walletAddress: VOTER,
        roles: ['delegator'],
        actionId: ACTION_ID,
        commentId: COMMENT_ID,
        body: { vote: 'sideways' },
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 400 });
    expect(mockTransact).not.toHaveBeenCalled();
  });
});
