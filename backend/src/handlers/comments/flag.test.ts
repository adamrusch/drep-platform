/**
 * Tests for `comments/flag.ts` — the Sprint 4 community-flagging
 * primitive for governance-action comments.
 *
 * The test corpus proves the four critical claims in the brief:
 *
 *   (a) Three DISTINCT on-chain-verified flaggers hide the row; a
 *       4th flag is a no-op (counter keeps climbing, but `hidden`
 *       stays true and is not toggled off).
 *   (b) The same flagger flagging twice counts ONCE — duplicate
 *       insert is `'skipped'` by `putItemIfAbsent`, the counter is
 *       NOT bumped, and the response is 200 with
 *       `outcome: 'already_flagged'`.
 *   (c) A caller WITHOUT any on-chain role is REJECTED with 403 —
 *       `requireOnChainRole` is the per-flagger barrier-to-entry that
 *       gives the 3-distinct-flaggers threshold meaning.
 *   (d) The author cannot self-flag — a self-flag would defeat the
 *       threshold by letting one wallet contribute to its own hide.
 *
 * # Mocking strategy
 *
 * The handler's data plane lives on:
 *   - `getItem`         — read the comment to fetch its author.
 *   - `putItemIfAbsent` — insert the per-flagger row, idempotent.
 *   - `docClient.send`  — atomic ADD of the counter + conditional hide.
 *
 * We mock the data plane at the module boundary so the test exercises
 * only the orchestration logic. The audit module is the real
 * implementation; we mock the underlying `putItem` so audit writes
 * don't blow up (matches the pattern in `comments/create.test.ts`).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';

// Capture the calls the handler issues to `docClient.send`. We use a
// fixed mock so any `UpdateCommand` (counter ADD, hide SET) can be
// inspected by the test.
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
import { handler, HIDE_THRESHOLD } from './flag';

const mockGet = vi.mocked(getItem);
const mockPutIfAbsent = vi.mocked(putItemIfAbsent);
const mockPutItem = vi.mocked(putItem);

const ACTION_ID = 'aaaaaaaa#0';
const COMMENT_ID = 'cmt-01';
const AUTHOR_WALLET = 'stake1uauthorxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

function buildEvent(opts: {
  walletAddress: string;
  roles?: string[];
  onChainRoles?: string[];
}): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    body: null,
    pathParameters: { actionId: ACTION_ID, commentId: COMMENT_ID },
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
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
}

function commandInput(command: unknown): UpdateCommandInputMock {
  // The @aws-sdk command instances expose their input on `.input`.
  return (command as { input: UpdateCommandInputMock }).input;
}

describe('comments/flag', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPutIfAbsent.mockReset();
    mockPutItem.mockReset();
    mockPutItem.mockResolvedValue(undefined);
    mockSend.mockReset();
  });

  it('CRITICAL: HIDE_THRESHOLD is exactly 3 — locked product invariant', () => {
    // If this constant ever changes the entire community-shield
    // semantic changes with it; pin the value here so the test suite
    // catches any drift and surfaces it as an intentional product
    // decision.
    expect(HIDE_THRESHOLD).toBe(3);
  });

  it('claim (a) — 3 distinct flaggers hide the row (newCount=3 → hidden=true)', async () => {
    // The comment exists with a DIFFERENT author than the flagger.
    mockGet.mockResolvedValueOnce({
      actionId: ACTION_ID,
      commentId: COMMENT_ID,
      walletAddress: AUTHOR_WALLET,
      body: 'a comment',
      isPublic: true,
      isDRep: false,
      createdAt: '2026-05-25T00:00:00Z',
      updatedAt: '2026-05-25T00:00:00Z',
    } as never);
    // First insert is fresh (this is the THIRD flagger; the prior 2
    // are simulated by `newCount=3` from the counter update below).
    mockPutIfAbsent.mockResolvedValueOnce({ outcome: 'written' });
    // Atomic ADD returns the new counter value = 3 (threshold hit).
    mockSend.mockResolvedValueOnce({ Attributes: { flagCount: 3 } });
    // Conditional `SET hidden = :true` succeeds.
    mockSend.mockResolvedValueOnce({});

    const res = (await handler(
      buildEvent({
        walletAddress: 'stake1uflaggerthreexxxxxxxxxxxxxxxxxxxxxxxxxxx',
        onChainRoles: ['drep'],
      }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body ?? '{}') as { data: Record<string, unknown> };
    expect(parsed.data['outcome']).toBe('flagged');
    expect(parsed.data['flagCount']).toBe(3);
    expect(parsed.data['hidden']).toBe(true);

    // Verify the per-flagger row landed in `comment_flags` with the
    // flagger's stake address as the SK and the on-chain role bound on.
    expect(mockPutIfAbsent).toHaveBeenCalledTimes(1);
    const insertCall = mockPutIfAbsent.mock.calls[0]!;
    expect(insertCall[0]).toBe('test-comment_flags');
    const insertedRow = insertCall[1] as Record<string, unknown>;
    expect(insertedRow['commentId']).toBe(COMMENT_ID);
    expect(insertedRow['flaggerId']).toBe(
      'stake1uflaggerthreexxxxxxxxxxxxxxxxxxxxxxxxxxx',
    );
    expect(insertedRow['role']).toBe('drep');

    // Verify the counter ADD update fired against `comments`.
    expect(mockSend).toHaveBeenCalledTimes(2);
    const addCmd = commandInput(mockSend.mock.calls[0]![0]);
    expect(addCmd.TableName).toBe('test-comments');
    expect(addCmd.UpdateExpression).toContain('ADD #flagCount :one');

    // Verify the hide SET fired with the documented conditional shape.
    const hideCmd = commandInput(mockSend.mock.calls[1]![0]);
    expect(hideCmd.TableName).toBe('test-comments');
    expect(hideCmd.UpdateExpression).toContain('SET #hidden = :true');
    expect(hideCmd.ConditionExpression).toContain('attribute_not_exists(#hidden)');
  });

  it('claim (a) cont. — 1st and 2nd flaggers DO NOT hide (newCount < threshold)', async () => {
    mockGet.mockResolvedValueOnce({
      actionId: ACTION_ID,
      commentId: COMMENT_ID,
      walletAddress: AUTHOR_WALLET,
    } as never);
    mockPutIfAbsent.mockResolvedValueOnce({ outcome: 'written' });
    // newCount = 1 — below threshold.
    mockSend.mockResolvedValueOnce({ Attributes: { flagCount: 1 } });

    const res = (await handler(
      buildEvent({
        walletAddress: 'stake1uflaggeronexxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        onChainRoles: ['cc'],
      }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body ?? '{}') as { data: Record<string, unknown> };
    expect(parsed.data['flagCount']).toBe(1);
    expect(parsed.data['hidden']).toBe(false);
    // Only ONE send call (the ADD) — no hide SET when below threshold.
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('claim (a) cont. — a 4th flag is a no-op for the hide bit (counter climbs, hidden stays true)', async () => {
    mockGet.mockResolvedValueOnce({
      actionId: ACTION_ID,
      commentId: COMMENT_ID,
      walletAddress: AUTHOR_WALLET,
      // Pre-existing hidden=true (already hidden by 3 prior flaggers).
      hidden: true,
      flagCount: 3,
    } as never);
    mockPutIfAbsent.mockResolvedValueOnce({ outcome: 'written' });
    // Counter ADD returns 4.
    mockSend.mockResolvedValueOnce({ Attributes: { flagCount: 4 } });
    // Conditional `SET hidden = :true` FAILS the condition (already
    // hidden) — the handler must swallow this and treat as success.
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('cond fail'), {
        name: 'ConditionalCheckFailedException',
      }),
    );

    const res = (await handler(
      buildEvent({
        walletAddress: 'stake1uflaggerfourxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        onChainRoles: ['spo'],
      }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body ?? '{}') as { data: Record<string, unknown> };
    // hidden=true survives (it was already true, the conditional
    // ensured we don't accidentally clear it).
    expect(parsed.data['hidden']).toBe(true);
    expect(parsed.data['flagCount']).toBe(4);
  });

  it('claim (b) — the SAME flagger flagging twice counts ONCE', async () => {
    mockGet.mockResolvedValueOnce({
      actionId: ACTION_ID,
      commentId: COMMENT_ID,
      walletAddress: AUTHOR_WALLET,
      flagCount: 1,
    } as never);
    // putItemIfAbsent reports the row was already there.
    mockPutIfAbsent.mockResolvedValueOnce({ outcome: 'skipped' });

    const res = (await handler(
      buildEvent({
        walletAddress: 'stake1uflaggeronexxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        onChainRoles: ['drep'],
      }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body ?? '{}') as { data: Record<string, unknown> };
    expect(parsed.data['outcome']).toBe('already_flagged');
    // CRITICAL: zero `docClient.send` calls — the counter MUST NOT be
    // bumped on a duplicate flag. If this assertion ever flips, the
    // 3-distinct-flaggers semantic is broken.
    expect(mockSend).not.toHaveBeenCalled();
    // The duplicate path emits a distinct audit eventType so ops can
    // distinguish dup attempts from real ones.
    const auditCalls = mockPutItem.mock.calls.filter(
      (c) => c[0] === 'test-audit_log',
    );
    expect(auditCalls).toHaveLength(1);
    const auditRow = auditCalls[0]![1] as Record<string, unknown>;
    expect(auditRow['eventType']).toBe('comment.flag_dup');
  });

  it('claim (c) — a non-on-chain-writer is REJECTED with 403 (zero data-plane calls)', async () => {
    // Caller is authenticated (has a JWT, has the `delegator` role)
    // but has not proved any on-chain role. `requireOnChainRole`
    // must 403 BEFORE any DDB call.
    const res = (await handler(
      buildEvent({
        walletAddress: 'stake1uplainwalletxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        roles: ['delegator'],
        onChainRoles: [],
      }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(res).toMatchObject({ statusCode: 403 });
    // No data-plane work fired — the gate is the FIRST check.
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockPutIfAbsent).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('claim (d) — author cannot self-flag (400 BEFORE any write)', async () => {
    const SELF_FLAGGER = 'stake1uselfflagxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    mockGet.mockResolvedValueOnce({
      actionId: ACTION_ID,
      commentId: COMMENT_ID,
      // The author IS the flagger.
      walletAddress: SELF_FLAGGER,
    } as never);

    const res = (await handler(
      buildEvent({
        walletAddress: SELF_FLAGGER,
        onChainRoles: ['drep'],
      }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(res.statusCode).toBe(400);
    expect(res.body ?? '').toContain('your own');
    // No flag-row insert + no counter mutation.
    expect(mockPutIfAbsent).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns 404 when the comment does not exist', async () => {
    mockGet.mockResolvedValueOnce(undefined);

    const res = (await handler(
      buildEvent({
        walletAddress: 'stake1ughostflagxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        onChainRoles: ['drep'],
      }),
    )) as APIGatewayProxyStructuredResultV2;

    expect(res).toMatchObject({ statusCode: 404 });
    expect(mockPutIfAbsent).not.toHaveBeenCalled();
  });

  it('records the role the flagger proved onto the audit metadata + the per-flagger row', async () => {
    mockGet.mockResolvedValueOnce({
      actionId: ACTION_ID,
      commentId: COMMENT_ID,
      walletAddress: AUTHOR_WALLET,
    } as never);
    mockPutIfAbsent.mockResolvedValueOnce({ outcome: 'written' });
    mockSend.mockResolvedValueOnce({ Attributes: { flagCount: 1 } });

    const res = (await handler(
      buildEvent({
        walletAddress: 'stake1uproposerflagxxxxxxxxxxxxxxxxxxxxxxxxxx',
        // Caller carries TWO on-chain roles; the handler picks the
        // first and binds it onto the row. The 3-distinct-flaggers
        // semantic counts each WALLET once regardless of how many
        // roles they hold.
        onChainRoles: ['proposer', 'drep'],
      }),
    )) as APIGatewayProxyStructuredResultV2;
    expect(res.statusCode).toBe(200);
    const insertedRow = mockPutIfAbsent.mock.calls[0]![1] as Record<
      string,
      unknown
    >;
    expect(insertedRow['role']).toBe('proposer');

    const auditCalls = mockPutItem.mock.calls.filter(
      (c) => c[0] === 'test-audit_log',
    );
    expect(auditCalls).toHaveLength(1);
    const auditRow = auditCalls[0]![1] as Record<string, unknown>;
    expect(auditRow['eventType']).toBe('comment.flagged');
    expect((auditRow['metadata'] as Record<string, unknown>)['role']).toBe(
      'proposer',
    );
  });
});
