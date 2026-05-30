/**
 * Tests for `comments/create.ts` — covers the new comment-vote feature
 * touchpoints:
 *
 *   1. Seed-upvote: on a fresh comment, the create handler writes a vote
 *      row keyed by (commentId, authorStakeAddress) with `vote: 'up'`
 *      and `lovelace` snapshotted from `lookupStake`. The seed lovelace
 *      is also written onto the comment row as the initial
 *      `supportLovelace`.
 *   2. Atomic two-write: `transactWrite` is called with BOTH the comment
 *      Put and the vote Put — never one without the other (the comment
 *      claiming +stake support without a matching vote row would be a
 *      lie).
 *   3. Reply-depth guard: replying to a top-level comment is allowed;
 *      replying to a reply is rejected with 400.
 *   4. `parentCommentId` is persisted verbatim when supplied.
 *   5. Stake-lookup failure (both providers down) does NOT fail the
 *      comment write — the comment goes through with supportLovelace=0
 *      and the seed vote row also carries 0. We deliberately don't
 *      hard-fail comment creation on upstream outage (different policy
 *      from the vote handler).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

vi.mock('../../lib/dynamodb', () => ({
  getItem: vi.fn(),
  transactWrite: vi.fn(),
  // `putItem` is mocked separately so the audit-best-effort tests at the
  // bottom of this file can drive it directly without going through the
  // audit module's own mock. The other comments/create tests don't touch
  // `putItem` — only the audit-helper does.
  putItem: vi.fn().mockResolvedValue(undefined),
  tableNames: {
    users: 'test-users',
    drepCommittees: 'test-drep_committees',
    drepDirectory: 'test-drep_directory',
    governanceActions: 'test-governance_actions',
    governanceVotes: 'test-governance_votes',
    comments: 'test-comments',
    commentVotes: 'test-comment_votes',
    commentVoters: 'test-comment_voters',
    clubhousePosts: 'test-clubhouse_posts',
    auditLog: 'test-audit_log',
    authNonces: 'test-auth_nonces',
  },
}));

vi.mock('../../lib/recognition', () => ({
  lookupRecognition: vi.fn(),
  lookupStake: vi.fn(),
}));

// Batch REVAL (2026-05-29): the create handler now upserts the author
// (via the implicit seed-upvote) into the `comment_voters` registry.
// Stub the upsert at the module boundary so existing tests don't have
// to thread the side-effect through. `comment-voters.test.ts` covers
// the upsert in isolation; the registry-wiring test below verifies
// the create handler does call it.
vi.mock('../../lib/comment-voters', () => ({
  upsertCommentVoter: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/auth', async () => {
  // Use a thin pass-through so we still get the real `buildMutationMessage`
  // shape, but stub validation + signature verification so the test
  // doesn't need to produce real Ed25519 signatures.
  const actual = await vi.importActual<typeof import('../../lib/auth')>('../../lib/auth');
  return {
    ...actual,
    validateMutationNonce: vi.fn(),
    verifyWalletSignature: vi.fn(),
  };
});

import { getItem, transactWrite, putItem } from '../../lib/dynamodb';
import { lookupRecognition, lookupStake } from '../../lib/recognition';
import { validateMutationNonce, verifyWalletSignature } from '../../lib/auth';
import { upsertCommentVoter } from '../../lib/comment-voters';
import { handler } from './create';

const mockGet = vi.mocked(getItem);
const mockTransact = vi.mocked(transactWrite);
const mockPutItem = vi.mocked(putItem);
const mockRecognition = vi.mocked(lookupRecognition);
const mockStake = vi.mocked(lookupStake);
const mockNonce = vi.mocked(validateMutationNonce);
const mockSig = vi.mocked(verifyWalletSignature);
const mockUpsertVoter = vi.mocked(upsertCommentVoter);

const ACTION_ID = 'aaaaaaaa#0';
const WALLET = 'stake1uyvjdz9rxsfsmv44rtk75k2rqyqskrga96dgdfrqjvjjpwsefcjnp';
const STAKE_LOVELACE = '5000000000000'; // 5M ADA

function buildEvent(opts: {
  walletAddress: string;
  roles: string[];
  actionId: string;
  body: unknown;
}): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    body: JSON.stringify(opts.body),
    pathParameters: { actionId: opts.actionId },
    requestContext: {
      authorizer: {
        lambda: {
          walletAddress: opts.walletAddress,
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

const validBody = {
  body: 'I support this proposal because…',
  isPublic: true,
  mutationNonce: 'nonce-abc',
  mutationSignature: 'sig-abc',
  mutationKey: 'key-abc',
};

describe('comments/create', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockTransact.mockReset();
    mockTransact.mockResolvedValue(undefined);
    mockPutItem.mockReset();
    mockPutItem.mockResolvedValue(undefined);
    mockRecognition.mockReset();
    mockRecognition.mockResolvedValue({});
    mockStake.mockReset();
    mockStake.mockResolvedValue({ lovelace: STAKE_LOVELACE, source: 'koios' });
    mockNonce.mockReset();
    mockNonce.mockResolvedValue({ valid: true });
    mockSig.mockReset();
    mockSig.mockReturnValue({ valid: true });
    mockUpsertVoter.mockReset();
    mockUpsertVoter.mockResolvedValue(undefined);
  });

  it('writes the comment + seed vote atomically with the correct lovelace snapshot', async () => {
    // First Get is the governance-action existence check.
    mockGet.mockResolvedValueOnce({ actionId: ACTION_ID, SK: 'ACTION' } as never);

    const res = (await handler(
      buildEvent({
        walletAddress: WALLET,
        roles: ['delegator'],
        actionId: ACTION_ID,
        body: validBody,
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 201 });

    // transactWrite called once with exactly TWO items — the comment Put
    // and the seed-vote Put. Order matters because the test below pulls
    // the comment from index 0 and the vote from index 1.
    expect(mockTransact).toHaveBeenCalledTimes(1);
    const items = mockTransact.mock.calls[0]![0];
    expect(items).toHaveLength(2);

    const commentPut = (items as Array<{ Put?: { TableName: string; Item: Record<string, unknown> } }>)[0]!.Put!;
    expect(commentPut.TableName).toBe('test-comments');
    const comment = commentPut.Item;
    expect(comment['actionId']).toBe(ACTION_ID);
    expect(comment['walletAddress']).toBe(WALLET);
    // P0-2 (2026-05-28): supportLovelace is now written as a JS `bigint`
    // so the doc-client marshals it to DDB `N` (the type the vote
    // handler's `ADD :delta` requires). Compare as bigint, not string.
    expect(comment['supportLovelace']).toBe(BigInt(STAKE_LOVELACE));
    expect(typeof comment['supportLovelace']).toBe('bigint');
    expect(comment['upvoteCount']).toBe(1);
    expect(comment['downvoteCount']).toBe(0);
    expect(comment['parentCommentId']).toBeUndefined();

    const votePut = (items as Array<{ Put?: { TableName: string; Item: Record<string, unknown> } }>)[1]!.Put!;
    expect(votePut.TableName).toBe('test-comment_votes');
    const vote = votePut.Item;
    expect(vote['commentId']).toBe(comment['commentId']);
    expect(vote['stakeAddress']).toBe(WALLET);
    expect(vote['vote']).toBe('up');
    // Seed lovelace must match the comment's initial supportLovelace
    // EXACTLY — the two together are the snapshot of authorship.
    expect(vote['lovelace']).toBe(STAKE_LOVELACE);
    expect(vote['actionId']).toBe(ACTION_ID);
  });

  it('persists parentCommentId when the parent is top-level', async () => {
    // Existence check + parent lookup — both succeed.
    mockGet.mockResolvedValueOnce({ actionId: ACTION_ID, SK: 'ACTION' } as never);
    mockGet.mockResolvedValueOnce({
      actionId: ACTION_ID,
      commentId: 'parent-id',
      walletAddress: 'stake1otherone',
      body: 'parent body',
      isPublic: true,
      isDRep: false,
      createdAt: '2026-05-25T00:00:00Z',
      updatedAt: '2026-05-25T00:00:00Z',
      // parentCommentId is ABSENT — this is a top-level comment.
    } as never);

    const res = (await handler(
      buildEvent({
        walletAddress: WALLET,
        roles: ['delegator'],
        actionId: ACTION_ID,
        body: { ...validBody, parentCommentId: 'parent-id' },
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 201 });
    const items = mockTransact.mock.calls[0]![0];
    const commentPut = (items as Array<{ Put: { Item: Record<string, unknown> } }>)[0]!.Put;
    expect(commentPut.Item['parentCommentId']).toBe('parent-id');
  });

  it('rejects replying to a reply with 400 (reply-depth guard)', async () => {
    mockGet.mockResolvedValueOnce({ actionId: ACTION_ID, SK: 'ACTION' } as never);
    mockGet.mockResolvedValueOnce({
      actionId: ACTION_ID,
      commentId: 'reply-id',
      walletAddress: 'stake1other',
      body: 'I am already a reply',
      isPublic: true,
      isDRep: false,
      createdAt: '2026-05-25T00:00:00Z',
      updatedAt: '2026-05-25T00:00:00Z',
      // KEY: this parent IS a reply itself. The handler must reject.
      parentCommentId: 'top-level-id',
    } as never);

    const res = (await handler(
      buildEvent({
        walletAddress: WALLET,
        roles: ['delegator'],
        actionId: ACTION_ID,
        body: { ...validBody, parentCommentId: 'reply-id' },
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 400 });
    // No write at all — the depth guard must come before transactWrite.
    expect(mockTransact).not.toHaveBeenCalled();
  });

  it('returns 404 when the parent comment does not exist', async () => {
    mockGet.mockResolvedValueOnce({ actionId: ACTION_ID, SK: 'ACTION' } as never);
    mockGet.mockResolvedValueOnce(undefined);

    const res = (await handler(
      buildEvent({
        walletAddress: WALLET,
        roles: ['delegator'],
        actionId: ACTION_ID,
        body: { ...validBody, parentCommentId: 'ghost-id' },
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 404 });
    expect(mockTransact).not.toHaveBeenCalled();
  });

  it('still writes when stake lookup fails (lovelace defaults to "0")', async () => {
    // Both upstreams down — the seed vote falls back to zero weight
    // rather than failing the post. Comment creation must not be hostage
    // to an upstream outage.
    mockGet.mockResolvedValueOnce({ actionId: ACTION_ID, SK: 'ACTION' } as never);
    mockStake.mockResolvedValueOnce({ lovelace: null, source: null });

    const res = (await handler(
      buildEvent({
        walletAddress: WALLET,
        roles: ['delegator'],
        actionId: ACTION_ID,
        body: validBody,
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 201 });
    const items = mockTransact.mock.calls[0]![0];
    const comment = (items as Array<{ Put: { Item: Record<string, unknown> } }>)[0]!.Put.Item;
    const vote = (items as Array<{ Put: { Item: Record<string, unknown> } }>)[1]!.Put.Item;
    // P0-2 fix: comment.supportLovelace is BigInt(0) (DDB N); the per-
    // vote row's lovelace stays as the string snapshot.
    expect(comment['supportLovelace']).toBe(0n);
    expect(vote['lovelace']).toBe('0');
  });

  it('rejects when the governance action does not exist (404)', async () => {
    mockGet.mockResolvedValueOnce(undefined);

    const res = (await handler(
      buildEvent({
        walletAddress: WALLET,
        roles: ['delegator'],
        actionId: ACTION_ID,
        body: validBody,
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 404 });
    expect(mockTransact).not.toHaveBeenCalled();
  });

  // ---- Audit-log wiring (Oracle's #1 credibility item, 2026-05-28) ----

  it('writes an audit-log row to the audit_log table on a successful comment', async () => {
    // The audit module's `writeAuditEvent` is the real implementation
    // in this file (NOT mocked) — it routes through `putItem` which
    // IS mocked. We verify the `putItem(auditLog, ...)` call fires
    // with the expected shape AFTER the mutation `transactWrite` lands.
    mockGet.mockResolvedValueOnce({ actionId: ACTION_ID, SK: 'ACTION' } as never);

    const res = (await handler(
      buildEvent({
        walletAddress: WALLET,
        roles: ['delegator'],
        actionId: ACTION_ID,
        body: validBody,
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 201 });
    // Find the audit-log putItem call. There MAY in theory be other
    // putItem calls in some handlers, but comments/create only fires
    // ONE putItem (the audit write) — the mutation goes through
    // transactWrite.
    const auditCalls = mockPutItem.mock.calls.filter(
      (c) => c[0] === 'test-audit_log',
    );
    expect(auditCalls).toHaveLength(1);
    const row = auditCalls[0]![1] as Record<string, unknown>;
    expect(row['entityType']).toBe('comment');
    expect(typeof row['entityId']).toBe('string');
    expect(row['eventType']).toBe('comment.created');
    expect(row['actorWallet']).toBe(WALLET);
    // pk + sk + ttl follow the schema-pinned shape.
    expect(row['pk']).toBe(`comment#${row['entityId'] as string}`);
    expect(typeof row['sk']).toBe('string');
    expect((row['sk'] as string).endsWith('#comment.created')).toBe(true);
    expect(typeof row['ttl']).toBe('number');
    // Metadata is the documented minimal/non-sensitive shape — IDs +
    // flags only, NEVER the body.
    const metadata = row['metadata'] as Record<string, unknown>;
    expect(metadata['actionId']).toBe(ACTION_ID);
    expect(metadata['isPublic']).toBe(true);
    // Body field MUST NOT appear in the audit metadata.
    expect(metadata).not.toHaveProperty('body');
  });

  it('CRITICAL: a thrown error from the audit-log putItem does NOT change the handler\'s 201 response (best-effort guarantee)', async () => {
    // This is THE handler-integration test that proves the load-bearing
    // invariant called out in the brief: an audit-write failure MUST
    // NEVER fail or 5xx the underlying mutation. If this test ever
    // flakes back to expecting a 5xx, the entire mutation surface
    // becomes takedown-able via DDB partition throttling on
    // `audit_log`.
    //
    // We arrange the underlying mutation (transactWrite) to SUCCEED,
    // and the trailing audit putItem to REJECT. The handler must still
    // return 201 with the created comment.
    mockGet.mockResolvedValueOnce({ actionId: ACTION_ID, SK: 'ACTION' } as never);
    mockPutItem.mockRejectedValueOnce(
      new Error('audit_log partition throttled'),
    );
    // Silence the warn from the audit helper so the test output stays
    // clean. We assert the warn was called (= audit error path
    // exercised) below.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = (await handler(
      buildEvent({
        walletAddress: WALLET,
        roles: ['delegator'],
        actionId: ACTION_ID,
        body: validBody,
      }),
    )) as APIGatewayProxyResultV2;

    // The mutation succeeded — the handler MUST still return 201.
    expect(res).toMatchObject({ statusCode: 201 });
    // The mutation transactWrite IS the source of truth. It fired.
    expect(mockTransact).toHaveBeenCalledTimes(1);
    // The audit putItem WAS attempted (so this test actually exercises
    // the path under question; if it had been skipped, the test would
    // be vacuously passing).
    const auditCalls = mockPutItem.mock.calls.filter(
      (c) => c[0] === 'test-audit_log',
    );
    expect(auditCalls).toHaveLength(1);
    // The failure was logged (via console.warn) but swallowed.
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // ---- Batch REVAL (2026-05-29) — registry upsert wiring ----

  it('REVAL: upserts the author into the comment_voters registry after a successful create (seed-upvote)', async () => {
    mockGet.mockResolvedValueOnce({ actionId: ACTION_ID, SK: 'ACTION' } as never);

    const res = (await handler(
      buildEvent({
        walletAddress: WALLET,
        roles: ['delegator'],
        actionId: ACTION_ID,
        body: validBody,
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 201 });
    // The author becomes a voter via the implicit seed-upvote; the
    // registry must carry them from the moment of creation so the
    // 3-hourly sweep doesn't miss them until they cast an explicit
    // separate vote.
    expect(mockUpsertVoter).toHaveBeenCalledTimes(1);
    expect(mockUpsertVoter).toHaveBeenCalledWith({
      stakeAddress: WALLET,
      lovelace: STAKE_LOVELACE,
    });
  });
});
