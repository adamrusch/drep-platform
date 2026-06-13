/**
 * Tests for `clubhouse/flagPost.ts` — the Sprint 4 community-flagging
 * primitive for clubhouse posts.
 *
 * Sibling of `comments/flag.test.ts` — same four claims (a/b/c/d),
 * different resource. The full design rationale lives at the top of
 * `comments/flag.ts`; this corpus pins the clubhouse-specific shape:
 *
 *   - `postKey` = `${drepId}#${postId}` partitioning matches the
 *     existing `clubhouse_comments` table format.
 *   - `flagCount` / `hidden` denormalised onto `clubhouse_posts` rows.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';

const mockSend = vi.fn();

vi.mock('../../lib/dynamodb', () => ({
  getItem: vi.fn(),
  putItemIfAbsent: vi.fn(),
  putItem: vi.fn().mockResolvedValue(undefined),
  docClient: { send: (...args: unknown[]) => mockSend(...args) },
  tableNames: {
    comments: 'test-comments',
    commentFlags: 'test-comment_flags',
    clubhousePosts: 'test-clubhouse_posts',
    clubhousePostFlags: 'test-clubhouse_post_flags',
    auditLog: 'test-audit_log',
  },
}));

import { getItem, putItemIfAbsent, putItem } from '../../lib/dynamodb';
import { handler } from './flagPost';

const mockGet = vi.mocked(getItem);
const mockPutIfAbsent = vi.mocked(putItemIfAbsent);
const mockPutItem = vi.mocked(putItem);

const DREP_ID = 'drep1yqclubhousexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const POST_ID = 'post-ulid-01';
const AUTHOR_WALLET = 'stake1upostauthorxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

function buildEvent(opts: {
  walletAddress: string;
  roles?: string[];
  onChainRoles?: string[];
}): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    body: null,
    pathParameters: { drepId: DREP_ID, postId: POST_ID },
    requestContext: {
      authorizer: {
        lambda: {
          walletAddress: opts.walletAddress,
          roles: JSON.stringify(opts.roles ?? ['delegator']),
          onChainRoles: JSON.stringify(opts.onChainRoles ?? []),
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

interface UpdateCommandInputMock {
  TableName: string;
  Key: Record<string, unknown>;
  UpdateExpression?: string;
  ConditionExpression?: string;
}

function commandInput(command: unknown): UpdateCommandInputMock {
  return (command as { input: UpdateCommandInputMock }).input;
}

describe('clubhouse/flagPost', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPutIfAbsent.mockReset();
    mockPutItem.mockReset();
    mockPutItem.mockResolvedValue(undefined);
    mockSend.mockReset();
  });

  it('claim (a) — 3 distinct flaggers hide the post (newCount=3 → hidden=true)', async () => {
    mockGet.mockResolvedValueOnce({
      drepId: DREP_ID,
      postId: POST_ID,
      authorWallet: AUTHOR_WALLET,
      body: 'a post',
    } as never);
    mockPutIfAbsent.mockResolvedValueOnce({ outcome: 'written' });
    mockSend.mockResolvedValueOnce({ Attributes: { flagCount: 3 } });
    mockSend.mockResolvedValueOnce({});

    const res = (await handler(
      buildEvent({
        walletAddress: 'stake1uflaggerthreexxxxxxxxxxxxxxxxxxxxxxxxxxx',
        onChainRoles: ['cc'],
      }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body ?? '{}') as { data: Record<string, unknown> };
    expect(parsed.data['outcome']).toBe('flagged');
    expect(parsed.data['flagCount']).toBe(3);
    expect(parsed.data['hidden']).toBe(true);

    // The per-flagger row landed in `clubhouse_post_flags` with the
    // composite `postKey`.
    expect(mockPutIfAbsent).toHaveBeenCalledTimes(1);
    const insertCall = mockPutIfAbsent.mock.calls[0]!;
    expect(insertCall[0]).toBe('test-clubhouse_post_flags');
    const insertedRow = insertCall[1] as Record<string, unknown>;
    expect(insertedRow['postKey']).toBe(`${DREP_ID}#${POST_ID}`);
    expect(insertedRow['flaggerId']).toBe(
      'stake1uflaggerthreexxxxxxxxxxxxxxxxxxxxxxxxxxx',
    );
    expect(insertedRow['role']).toBe('cc');

    // Counter ADD + hide SET both fired on `clubhouse_posts`.
    expect(mockSend).toHaveBeenCalledTimes(2);
    const addCmd = commandInput(mockSend.mock.calls[0]![0]);
    expect(addCmd.TableName).toBe('test-clubhouse_posts');
    expect(addCmd.UpdateExpression).toContain('ADD #flagCount :one');

    const hideCmd = commandInput(mockSend.mock.calls[1]![0]);
    expect(hideCmd.TableName).toBe('test-clubhouse_posts');
    expect(hideCmd.UpdateExpression).toContain('SET #hidden = :true');
    expect(hideCmd.ConditionExpression).toContain('attribute_not_exists(#hidden)');
  });

  it('claim (b) — duplicate flag from same wallet is idempotent (200 + already_flagged + no counter mutation)', async () => {
    mockGet.mockResolvedValueOnce({
      drepId: DREP_ID,
      postId: POST_ID,
      authorWallet: AUTHOR_WALLET,
    } as never);
    mockPutIfAbsent.mockResolvedValueOnce({ outcome: 'skipped' });

    const res = (await handler(
      buildEvent({
        walletAddress: 'stake1udupflaggerxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        onChainRoles: ['drep'],
      }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body ?? '{}') as { data: Record<string, unknown> };
    expect(parsed.data['outcome']).toBe('already_flagged');
    expect(mockSend).not.toHaveBeenCalled();
    const auditCalls = mockPutItem.mock.calls.filter(
      (c) => c[0] === 'test-audit_log',
    );
    expect(auditCalls).toHaveLength(1);
    const auditRow = auditCalls[0]![1] as Record<string, unknown>;
    expect(auditRow['eventType']).toBe('clubhouse.post.flag_dup');
  });

  it('claim (c) — non-on-chain-writer is rejected with 403 (no data-plane calls)', async () => {
    const res = (await handler(
      buildEvent({
        walletAddress: 'stake1uplainxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        roles: ['delegator'],
        onChainRoles: [],
      }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(res).toMatchObject({ statusCode: 403 });
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockPutIfAbsent).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('claim (d) — post author cannot self-flag (400 before any write)', async () => {
    const SELF = 'stake1uselfpostxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    mockGet.mockResolvedValueOnce({
      drepId: DREP_ID,
      postId: POST_ID,
      authorWallet: SELF,
    } as never);

    const res = (await handler(
      buildEvent({
        walletAddress: SELF,
        onChainRoles: ['drep'],
      }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(res.statusCode).toBe(400);
    expect(res.body ?? '').toContain('your own');
    expect(mockPutIfAbsent).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns 404 when the post does not exist', async () => {
    mockGet.mockResolvedValueOnce(undefined);
    const res = (await handler(
      buildEvent({
        walletAddress: 'stake1ughostxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        onChainRoles: ['drep'],
      }),
    )) as APIGatewayProxyStructuredResultV2;
    expect(res).toMatchObject({ statusCode: 404 });
  });

  it('1st flagger only — counter < threshold, no hide SET fires', async () => {
    mockGet.mockResolvedValueOnce({
      drepId: DREP_ID,
      postId: POST_ID,
      authorWallet: AUTHOR_WALLET,
    } as never);
    mockPutIfAbsent.mockResolvedValueOnce({ outcome: 'written' });
    mockSend.mockResolvedValueOnce({ Attributes: { flagCount: 1 } });

    const res = (await handler(
      buildEvent({
        walletAddress: 'stake1uflaggeronexxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        onChainRoles: ['spo'],
      }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body ?? '{}') as { data: Record<string, unknown> };
    expect(parsed.data['hidden']).toBe(false);
    // Only the counter ADD ran; no second send for the hide SET.
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});
