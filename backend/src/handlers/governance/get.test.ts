/**
 * Handler-level tests for `GET /governance/{actionId}`.
 *
 * Two integration concerns to lock in (the supersede-dedupe rule itself
 * is unit-tested in `lib/votes.test.ts`):
 *
 *   1. The handler returns the persisted action row with a `voteList`
 *      array attached. Order matches the votes-lib output (newest-first,
 *      superseded flag set).
 *   2. When the votes lookup fails (DDB outage / Koios timeout in the
 *      directory join), the handler does NOT 500 — it serves the action
 *      row with an empty `voteList`. The Votes tab is additive; a failure
 *      there must not break the rest of the page.
 *   3. When the action row is missing, the handler returns 404 even if
 *      the votes query succeeded.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

vi.mock('../../lib/dynamodb', () => ({
  getItem: vi.fn(),
  tableNames: {
    users: 'test-users',
    drepCommittees: 'test-drep_committees',
    drepDirectory: 'test-drep_directory',
    governanceActions: 'test-governance_actions',
    governanceVotes: 'test-governance_votes',
    comments: 'test-comments',
    clubhousePosts: 'test-clubhouse_posts',
    auditLog: 'test-audit_log',
    authNonces: 'test-auth_nonces',
  },
}));

vi.mock('../../lib/votes', () => ({
  getVotesForAction: vi.fn(),
}));

import { getItem } from '../../lib/dynamodb';
import { getVotesForAction } from '../../lib/votes';
import { handler } from './get';

const mockGet = vi.mocked(getItem);
const mockGetVotes = vi.mocked(getVotesForAction);

const ACTION_ID = 'abc123#0';

function buildEvent(actionId: string | undefined): APIGatewayProxyEventV2 {
  return {
    pathParameters: actionId ? { actionId } : undefined,
  } as unknown as APIGatewayProxyEventV2;
}

function parseBody(body: string | undefined): Record<string, unknown> {
  return JSON.parse(body ?? '{}') as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('governance/get handler', () => {
  it('returns 400 when actionId is missing', async () => {
    const res = await handler(buildEvent(undefined));
    expect((res as { statusCode: number }).statusCode).toBe(400);
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockGetVotes).not.toHaveBeenCalled();
  });

  it('returns 404 when the action row is not in DDB', async () => {
    mockGet.mockResolvedValueOnce(undefined);
    mockGetVotes.mockResolvedValueOnce([]);
    const res = await handler(buildEvent(ACTION_ID));
    expect((res as { statusCode: number }).statusCode).toBe(404);
  });

  it('returns the action row with voteList attached, newest-first', async () => {
    mockGet.mockResolvedValueOnce({
      actionId: ACTION_ID,
      SK: 'ACTION',
      actionType: 'InfoAction',
      description: '',
      submittedAt: '2026-01-01T00:00:00.000Z',
      epochDeadline: 500,
      status: 'active',
    });
    mockGetVotes.mockResolvedValueOnce([
      {
        voterRole: 'DRep',
        voterId: 'drep1a',
        vote: 'Yes',
        votedAt: '2026-02-01T00:00:00.000Z',
        blockTime: 1_700_000_300,
        voteTxHash: 'newer',
        superseded: false,
      },
      {
        voterRole: 'DRep',
        voterId: 'drep1a',
        vote: 'No',
        votedAt: '2026-01-15T00:00:00.000Z',
        blockTime: 1_700_000_100,
        voteTxHash: 'older',
        superseded: true,
      },
    ]);

    const res = await handler(buildEvent(ACTION_ID));
    expect((res as { statusCode: number }).statusCode).toBe(200);
    const body = parseBody((res as { body?: string }).body);
    const data = body['data'] as Record<string, unknown>;
    expect(data['actionId']).toBe(ACTION_ID);
    const voteList = data['voteList'] as Array<Record<string, unknown>>;
    expect(voteList).toHaveLength(2);
    expect(voteList[0]).toMatchObject({ voteTxHash: 'newer', superseded: false });
    expect(voteList[1]).toMatchObject({ voteTxHash: 'older', superseded: true });
  });

  it('returns the action row with an empty voteList when votes lookup fails', async () => {
    mockGet.mockResolvedValueOnce({
      actionId: ACTION_ID,
      SK: 'ACTION',
      actionType: 'InfoAction',
      description: '',
      submittedAt: '2026-01-01T00:00:00.000Z',
      epochDeadline: 500,
      status: 'active',
    });
    mockGetVotes.mockRejectedValueOnce(new Error('DDB transient outage'));

    const res = await handler(buildEvent(ACTION_ID));
    expect((res as { statusCode: number }).statusCode).toBe(200);
    const body = parseBody((res as { body?: string }).body);
    const data = body['data'] as Record<string, unknown>;
    expect(data['actionId']).toBe(ACTION_ID);
    expect(data['voteList']).toEqual([]);
  });

  it('returns 500 when the action lookup itself fails', async () => {
    mockGet.mockRejectedValueOnce(new Error('DDB outage'));
    mockGetVotes.mockResolvedValueOnce([]);

    const res = await handler(buildEvent(ACTION_ID));
    expect((res as { statusCode: number }).statusCode).toBe(500);
  });
});
