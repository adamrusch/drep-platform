/**
 * Tests for `moderation/setHidden.ts` — the admin override.
 *
 * Pins the contract from the brief:
 *   - `platform_admin` gate: non-admin gets 403 before any DDB call.
 *   - Conditional update sets `hidden` true/false on the right parent
 *     table for each of the three content types.
 *   - The mutation is audit-logged on success
 *     (`moderation.hidden.set` with old/new/target metadata).
 *   - Validates body shape (type, hidden boolean, optional reason).
 *   - Returns 404 / 409 on conditional-check failures.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';

const mockSend = vi.fn();

vi.mock('../../lib/dynamodb', () => ({
  docClient: { send: (...args: unknown[]) => mockSend(...args) },
  putItem: vi.fn().mockResolvedValue(undefined),
  tableNames: {
    comments: 'test-comments',
    clubhousePosts: 'test-clubhouse_posts',
    clubhouseComments: 'test-clubhouse_comments',
    auditLog: 'test-audit_log',
  },
}));

import { putItem } from '../../lib/dynamodb';
import { handler } from './setHidden';

const mockPutItem = vi.mocked(putItem);

const ADMIN_WALLET = 'stake1uadminxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

interface UpdateCommandInputMock {
  TableName: string;
  Key: Record<string, unknown>;
  UpdateExpression?: string;
  ConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
}

function commandInput(command: unknown): UpdateCommandInputMock {
  return (command as { input: UpdateCommandInputMock }).input;
}

function buildEvent(opts: {
  walletAddress: string;
  roles?: string[];
  body?: Record<string, unknown> | string;
}): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    body:
      typeof opts.body === 'string'
        ? opts.body
        : opts.body
          ? JSON.stringify(opts.body)
          : null,
    pathParameters: null,
    queryStringParameters: null,
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
    headers: { 'Content-Type': 'application/json' },
    isBase64Encoded: false,
    routeKey: '',
    version: '2.0',
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

describe('moderation/setHidden', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockPutItem.mockReset();
    mockPutItem.mockResolvedValue(undefined);
  });

  it('rejects a non-platform-admin with 403 BEFORE any DDB call', async () => {
    const res = (await handler(
      buildEvent({
        walletAddress: 'stake1unotanadminxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        roles: ['delegator'],
        body: { type: 'comment', actionId: 'a', commentId: 'c', hidden: false },
      }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(res.statusCode).toBe(403);
    expect(mockSend).not.toHaveBeenCalled();
    // The audit-log write only fires on a successful mutation.
    const auditCalls = mockPutItem.mock.calls.filter(
      (c) => c[0] === 'test-audit_log',
    );
    expect(auditCalls).toHaveLength(0);
  });

  it('sets hidden=false on a comment, audits the transition, returns old/new', async () => {
    // The UpdateCommand returns the prior row in `Attributes` (we
    // requested `ALL_OLD`). The prior `hidden` was true.
    mockSend.mockResolvedValueOnce({ Attributes: { hidden: true } });

    const res = (await handler(
      buildEvent({
        walletAddress: ADMIN_WALLET,
        roles: ['platform_admin'],
        body: {
          type: 'comment',
          actionId: 'act-1',
          commentId: 'cmt-1',
          hidden: false,
          reason: 'Reviewed; community decision overturned.',
        },
      }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body ?? '{}') as {
      data: { type: string; oldHidden: boolean; newHidden: boolean };
    };
    expect(parsed.data.type).toBe('comment');
    expect(parsed.data.oldHidden).toBe(true);
    expect(parsed.data.newHidden).toBe(false);

    // The mutation targeted the comments table with the right key.
    expect(mockSend).toHaveBeenCalledTimes(1);
    const cmd = commandInput(mockSend.mock.calls[0]![0]);
    expect(cmd.TableName).toBe('test-comments');
    expect(cmd.Key).toEqual({ actionId: 'act-1', commentId: 'cmt-1' });
    expect(cmd.UpdateExpression).toContain('SET #hidden = :new');
    expect(cmd.ExpressionAttributeValues?.[':new']).toBe(false);

    // Audit-log row written with the documented eventType + metadata.
    const auditCalls = mockPutItem.mock.calls.filter(
      (c) => c[0] === 'test-audit_log',
    );
    expect(auditCalls).toHaveLength(1);
    const auditRow = auditCalls[0]![1] as Record<string, unknown>;
    expect(auditRow['entityType']).toBe('moderation');
    expect(auditRow['entityId']).toBe('cmt-1');
    expect(auditRow['eventType']).toBe('moderation.hidden.set');
    expect(auditRow['actorWallet']).toBe(ADMIN_WALLET);
    const meta = auditRow['metadata'] as Record<string, unknown>;
    expect(meta['targetType']).toBe('comment');
    expect(meta['actionId']).toBe('act-1');
    expect(meta['commentId']).toBe('cmt-1');
    expect(meta['oldHidden']).toBe(true);
    expect(meta['newHidden']).toBe(false);
    expect(meta['reason']).toBe('Reviewed; community decision overturned.');
  });

  it('sets hidden=true on a clubhouse post and targets the right table/key', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: { hidden: false } });

    const res = (await handler(
      buildEvent({
        walletAddress: ADMIN_WALLET,
        roles: ['platform_admin'],
        body: {
          type: 'clubhouse_post',
          drepId: 'drep1',
          postId: 'post-1',
          hidden: true,
        },
      }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(res.statusCode).toBe(200);
    const cmd = commandInput(mockSend.mock.calls[0]![0]);
    expect(cmd.TableName).toBe('test-clubhouse_posts');
    expect(cmd.Key).toEqual({ drepId: 'drep1', postId: 'post-1' });
    expect(cmd.ExpressionAttributeValues?.[':new']).toBe(true);

    const auditCalls = mockPutItem.mock.calls.filter(
      (c) => c[0] === 'test-audit_log',
    );
    expect(auditCalls).toHaveLength(1);
    const meta = (auditCalls[0]![1] as Record<string, unknown>)[
      'metadata'
    ] as Record<string, unknown>;
    expect(meta['targetType']).toBe('clubhouse_post');
    expect(meta['drepId']).toBe('drep1');
    expect(meta['postId']).toBe('post-1');
  });

  it('sets hidden=true on a clubhouse comment with the composite postKey', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: {} });

    const res = (await handler(
      buildEvent({
        walletAddress: ADMIN_WALLET,
        roles: ['platform_admin'],
        body: {
          type: 'clubhouse_comment',
          drepId: 'drep1',
          postId: 'post-1',
          commentId: 'ccmt-1',
          hidden: true,
        },
      }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(res.statusCode).toBe(200);
    const cmd = commandInput(mockSend.mock.calls[0]![0]);
    expect(cmd.TableName).toBe('test-clubhouse_comments');
    expect(cmd.Key).toEqual({ postKey: 'drep1#post-1', commentId: 'ccmt-1' });
  });

  it('uses an expected-precondition on the conditional update when `expected` is supplied', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: { hidden: true } });

    await handler(
      buildEvent({
        walletAddress: ADMIN_WALLET,
        roles: ['platform_admin'],
        body: {
          type: 'comment',
          actionId: 'a',
          commentId: 'c',
          hidden: false,
          expected: true,
        },
      }),
    );

    const cmd = commandInput(mockSend.mock.calls[0]![0]);
    expect(cmd.ConditionExpression).toContain('#hidden = :expected');
    expect(cmd.ExpressionAttributeValues?.[':expected']).toBe(true);
  });

  it('returns 409 on conditional-check failure when an `expected` precondition is supplied', async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('cond fail'), {
        name: 'ConditionalCheckFailedException',
      }),
    );

    const res = (await handler(
      buildEvent({
        walletAddress: ADMIN_WALLET,
        roles: ['platform_admin'],
        body: {
          type: 'comment',
          actionId: 'a',
          commentId: 'c',
          hidden: false,
          expected: true,
        },
      }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(res.statusCode).toBe(409);
    // No audit row when the mutation didn't land.
    const auditCalls = mockPutItem.mock.calls.filter(
      (c) => c[0] === 'test-audit_log',
    );
    expect(auditCalls).toHaveLength(0);
  });

  it('returns 404 on conditional-check failure when no `expected` was supplied (row missing)', async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('cond fail'), {
        name: 'ConditionalCheckFailedException',
      }),
    );

    const res = (await handler(
      buildEvent({
        walletAddress: ADMIN_WALLET,
        roles: ['platform_admin'],
        body: {
          type: 'comment',
          actionId: 'a',
          commentId: 'c-missing',
          hidden: false,
        },
      }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(res.statusCode).toBe(404);
  });

  it('400s on a non-JSON body', async () => {
    const res = (await handler(
      buildEvent({
        walletAddress: ADMIN_WALLET,
        roles: ['platform_admin'],
        body: 'not-json',
      }),
    )) as APIGatewayProxyStructuredResultV2;
    expect(res.statusCode).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('400s when `hidden` is not a boolean', async () => {
    const res = (await handler(
      buildEvent({
        walletAddress: ADMIN_WALLET,
        roles: ['platform_admin'],
        body: { type: 'comment', actionId: 'a', commentId: 'c', hidden: 'yes' },
      }),
    )) as APIGatewayProxyStructuredResultV2;
    expect(res.statusCode).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('400s when `type` is missing or unknown', async () => {
    const res = (await handler(
      buildEvent({
        walletAddress: ADMIN_WALLET,
        roles: ['platform_admin'],
        body: { hidden: true },
      }),
    )) as APIGatewayProxyStructuredResultV2;
    expect(res.statusCode).toBe(400);
  });

  it('400s when a target id is missing for the requested type', async () => {
    const res = (await handler(
      buildEvent({
        walletAddress: ADMIN_WALLET,
        roles: ['platform_admin'],
        body: { type: 'clubhouse_comment', drepId: 'd', postId: 'p', hidden: true },
      }),
    )) as APIGatewayProxyStructuredResultV2;
    expect(res.statusCode).toBe(400);
  });

  it('400s on an overlong reason', async () => {
    const res = (await handler(
      buildEvent({
        walletAddress: ADMIN_WALLET,
        roles: ['platform_admin'],
        body: {
          type: 'comment',
          actionId: 'a',
          commentId: 'c',
          hidden: false,
          reason: 'x'.repeat(600),
        },
      }),
    )) as APIGatewayProxyStructuredResultV2;
    expect(res.statusCode).toBe(400);
  });
});
