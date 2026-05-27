/**
 * Tests for the Clubhouse `createComment` handler.
 *
 * # Depth guard (Clubhouse: 2 levels)
 *
 *   - top-level comment (no parentCommentId)
 *   - reply (parentCommentId points at a top-level comment)
 *   - sub-reply (parentCommentId points at a reply)
 *
 * The 3rd level — a reply targeting a sub-reply — is rejected with 400.
 * This is ONE LEVEL DEEPER than the Public Comments surface.
 *
 * # Membership gate (added 2026-05-27, Batch E)
 *
 * The handler now resolves the caller's membership in this clubhouse:
 *   1. role-holder: lead DRep / committee_member / trusted_delegator
 *      listed on the `DRepCommittee` row for `drepId`. Resolved by a
 *      DDB Get.
 *   2. current delegator: their stake currently delegates to THIS
 *      DRep, resolved via Koios primary + Blockfrost fallback (the
 *      same `lookupCurrentDrep` flow used by `/auth/me`).
 *
 * Cases:
 *   - Either condition true → comment allowed.
 *   - Both conditions false (definitive answer from upstream) → 403.
 *   - Both upstreams failed → soft-allow (we don't 503 the entire
 *     comment surface during a Koios outage; the role-holder branch
 *     still works since it's a DDB lookup).
 *
 * The depth guard runs BEFORE the membership gate (a depth-3 comment
 * is malformed regardless of who's submitting it), so the original
 * 8 depth-guard tests still cover the depth logic. The new
 * "membership" describe block below adds the gate coverage.
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

vi.mock('../../lib/recognition', () => ({
  lookupCurrentDrep: vi.fn(),
}));

import { getItem, putItem } from '../../lib/dynamodb';
import { lookupCurrentDrep } from '../../lib/recognition';
import { handler } from './createComment';

const mockGet = vi.mocked(getItem);
const mockPut = vi.mocked(putItem);
const mockLookup = vi.mocked(lookupCurrentDrep);

const DREP_ID = 'drep1ygqgayvx8yzsaj9hprja3l6jy3v4px9z3u8uvecuvm3f92ce7mckx';
const POST_ID = 'auto-ga#abcd#0';
const WALLET = 'stake1uyvjdz9rxsfsmv44rtk75k2rqyqskrga96dgdfrqjvjjpwsefcjnp';
const OTHER_DREP_ID = 'drep1somebodyelse';

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

/** Build a `DRepCommitteeItem` row. Defaults to a clubhouse owned by
 *  someone OTHER than `WALLET`, so the caller is not a role-holder
 *  unless overridden. */
function buildCommittee(opts?: {
  leadWallet?: string;
  memberWallets?: string[];
}): unknown {
  return {
    drepId: DREP_ID,
    SK: 'COMMITTEE',
    leadWallet: opts?.leadWallet ?? 'stake1someotherlead',
    committeeName: 'test committee',
    description: 'd',
    members: (opts?.memberWallets ?? []).map((w) => ({
      walletAddress: w,
      joinedAt: '2026-01-01T00:00:00Z',
      role: 'committee_member',
    })),
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
  };
}

/**
 * Wire the two getItem call shapes that `createComment` makes after the
 * membership gate landed:
 *   1. getItem(clubhousePosts, {drepId, postId})  → the post being commented on
 *   2. getItem(drepCommittees, {drepId, SK:'COMMITTEE'})  → membership lookup
 *
 * The order isn't deterministic (they run in parallel via Promise.all),
 * so we set up mocks by Implementation rather than by call-order.
 */
function wireDdbMocks(opts: {
  post: unknown | undefined;
  committee: unknown | undefined;
}): void {
  mockGet.mockImplementation(async (_tableName: string, key: Record<string, unknown>) => {
    if (key['SK'] === 'COMMITTEE') return opts.committee as never;
    if (key['postId']) return opts.post as never;
    return undefined;
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mockPut.mockResolvedValue(undefined);
  // Default to a wallet that IS delegated to this DRep — the easiest
  // baseline that lets the depth-guard tests focus on depth semantics
  // without re-asserting the membership gate.
  mockLookup.mockResolvedValue({ drepId: DREP_ID, source: 'koios' });
});

describe('clubhouse/createComment — depth guard', () => {
  it('allows top-level comment (no parentCommentId)', async () => {
    wireDdbMocks({ post: buildPostWithComments([]), committee: buildCommittee() });

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
    wireDdbMocks({
      post: buildPostWithComments([{ commentId: 'top1' }]),
      committee: buildCommittee(),
    });

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
    wireDdbMocks({
      post: buildPostWithComments([
        { commentId: 'top1' },
        { commentId: 'reply1', parentCommentId: 'top1' },
      ]),
      committee: buildCommittee(),
    });

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
    wireDdbMocks({
      post: buildPostWithComments([
        { commentId: 'top1' },
        { commentId: 'reply1', parentCommentId: 'top1' },
        { commentId: 'subreply1', parentCommentId: 'reply1' },
      ]),
      committee: buildCommittee(),
    });

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
    wireDdbMocks({
      post: buildPostWithComments([{ commentId: 'top1' }]),
      committee: buildCommittee(),
    });

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
    wireDdbMocks({ post: buildPostWithComments([]), committee: buildCommittee() });
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
    wireDdbMocks({ post: undefined, committee: buildCommittee() });
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
    wireDdbMocks({
      post: buildPostWithComments([{ commentId: 'top1' }]),
      committee: buildCommittee(),
    });
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

describe('clubhouse/createComment — membership gate', () => {
  it('allows a delegator currently delegated to THIS DRep', async () => {
    wireDdbMocks({ post: buildPostWithComments([]), committee: buildCommittee() });
    mockLookup.mockResolvedValueOnce({ drepId: DREP_ID, source: 'koios' });

    const res = (await handler(
      buildEvent({
        drepId: DREP_ID,
        postId: POST_ID,
        walletAddress: WALLET,
        body: { body: 'hi from a delegator' },
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 200 });
    expect(mockPut).toHaveBeenCalledTimes(1);
  });

  it('REJECTS with 403 a delegator delegated to a DIFFERENT DRep', async () => {
    wireDdbMocks({ post: buildPostWithComments([]), committee: buildCommittee() });
    mockLookup.mockResolvedValueOnce({ drepId: OTHER_DREP_ID, source: 'koios' });

    const res = (await handler(
      buildEvent({
        drepId: DREP_ID,
        postId: POST_ID,
        walletAddress: WALLET,
        body: { body: 'I should not be allowed here' },
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 403 });
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('REJECTS with 403 a wallet that is undelegated AND not a role-holder', async () => {
    wireDdbMocks({ post: buildPostWithComments([]), committee: buildCommittee() });
    mockLookup.mockResolvedValueOnce({ drepId: null, source: 'koios' });

    const res = (await handler(
      buildEvent({
        drepId: DREP_ID,
        postId: POST_ID,
        walletAddress: WALLET,
        body: { body: 'random stranger' },
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 403 });
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('allows the LEAD DRep of this committee even if delegated elsewhere', async () => {
    wireDdbMocks({
      post: buildPostWithComments([]),
      committee: buildCommittee({ leadWallet: WALLET }),
    });
    // Lead is delegated to some other DRep (or undelegated) — doesn't
    // matter, the role-holder branch wins.
    mockLookup.mockResolvedValueOnce({ drepId: OTHER_DREP_ID, source: 'koios' });

    const res = (await handler(
      buildEvent({
        drepId: DREP_ID,
        postId: POST_ID,
        walletAddress: WALLET,
        body: { body: 'lead chime-in' },
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 200 });
    expect(mockPut).toHaveBeenCalledTimes(1);
  });

  it('allows a committee_member of this committee even if delegated elsewhere', async () => {
    wireDdbMocks({
      post: buildPostWithComments([]),
      committee: buildCommittee({ memberWallets: [WALLET] }),
    });
    mockLookup.mockResolvedValueOnce({ drepId: null, source: 'koios' });

    const res = (await handler(
      buildEvent({
        drepId: DREP_ID,
        postId: POST_ID,
        walletAddress: WALLET,
        body: { body: 'committee member voice' },
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 200 });
    expect(mockPut).toHaveBeenCalledTimes(1);
  });

  it('soft-allows when Koios+Blockfrost both fail (source: null)', async () => {
    // Documented behavior: if we can't determine the caller's
    // delegation, we don't 503 — we fall through to "allow" so the
    // surface keeps working during a transient upstream outage.
    wireDdbMocks({ post: buildPostWithComments([]), committee: buildCommittee() });
    mockLookup.mockResolvedValueOnce({ drepId: null, source: null });

    const res = (await handler(
      buildEvent({
        drepId: DREP_ID,
        postId: POST_ID,
        walletAddress: WALLET,
        body: { body: 'koios is down' },
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 200 });
    expect(mockPut).toHaveBeenCalledTimes(1);
  });

  it('rejects a wallet that is delegated to a different DRep even when the committee row is missing', async () => {
    // No committee row → no role-holder match available, but the
    // wallet is definitively delegated to a different DRep, so reject.
    wireDdbMocks({ post: buildPostWithComments([]), committee: undefined });
    mockLookup.mockResolvedValueOnce({ drepId: OTHER_DREP_ID, source: 'koios' });

    const res = (await handler(
      buildEvent({
        drepId: DREP_ID,
        postId: POST_ID,
        walletAddress: WALLET,
        body: { body: 'no committee, wrong drep' },
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 403 });
    expect(mockPut).not.toHaveBeenCalled();
  });
});
