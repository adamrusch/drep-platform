/**
 * Tests for the Clubhouse `createComment` handler.
 *
 * # Post-P0-3 dual-write contract (2026-05-28)
 *
 * The handler writes THREE things on a successful comment:
 *   (1) New per-row comment to `clubhouse_comments` table — `putItem`
 *       with `attribute_not_exists(commentId)` for idempotency.
 *   (2) Atomic counter bump on the parent post — `updateItem`:
 *         `ADD commentCount :one SET lastReplyAt = :now, updatedAt = :now`.
 *   (3) LEGACY inline append on the post's `comments[]` array —
 *       `updateItem` with `ConditionExpression: updatedAt = :prev`
 *       (and a single retry on conflict). Kept alive during rotation
 *       so the dual-write is a safe rollback target.
 *
 * # Depth guard (Clubhouse: 2 levels)
 *
 *   - top-level comment (no parentCommentId)
 *   - reply (parentCommentId points at a top-level comment)
 *   - sub-reply (parentCommentId points at a reply)
 *
 * The 3rd level — a reply targeting a sub-reply — is rejected with 400.
 *
 * # Membership gate
 *
 *   - role-holder (lead / committee_member / trusted_delegator) →
 *     comment allowed.
 *   - current delegator → comment allowed.
 *   - both false (definitive) → 403.
 *   - both upstreams failed → soft-allow.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

vi.mock('../../lib/dynamodb', () => ({
  getItem: vi.fn(),
  putItem: vi.fn(),
  updateItem: vi.fn(),
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

vi.mock('../../lib/recognition', () => ({
  lookupCurrentDrep: vi.fn(),
}));

import { getItem, putItem, updateItem } from '../../lib/dynamodb';
import { lookupCurrentDrep } from '../../lib/recognition';
import { handler } from './createComment';

const mockGet = vi.mocked(getItem);
const mockPut = vi.mocked(putItem);
const mockUpdate = vi.mocked(updateItem);
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
    commentCount: graph.length,
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
 * Wire the three getItem call shapes that `createComment` makes:
 *   1. getItem(clubhousePosts, {drepId, postId})  — the post being commented on
 *   2. getItem(clubhouseComments, {postKey, commentId}) — parent depth lookup
 *      (only when replying; not all tests trigger this path)
 *   3. getItem(drepCommittees, {drepId, SK:'COMMITTEE'}) — membership lookup
 *
 * We wire by Key shape (in-parallel calls don't have a deterministic
 * order between (1) and (3)).
 */
function wireDdbMocks(opts: {
  post: unknown | undefined;
  committee: unknown | undefined;
  /** Override per-parent depth lookup in the new table — keyed by
   *  the parent commentId. Pre-backfill scenarios omit this entirely
   *  and the handler falls back to the inline-array walk. */
  parentDepthsByCommentId?: Record<string, number>;
}): void {
  mockGet.mockImplementation(async (tableName: string, key: Record<string, unknown>) => {
    if (key['SK'] === 'COMMITTEE') return opts.committee as never;
    if (tableName === 'test-clubhouse_comments' && key['commentId']) {
      const depth = opts.parentDepthsByCommentId?.[key['commentId'] as string];
      if (depth === undefined) return undefined as never;
      return { depth, commentId: key['commentId'] } as never;
    }
    if (key['postId']) return opts.post as never;
    return undefined;
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mockPut.mockResolvedValue(undefined);
  mockUpdate.mockResolvedValue(undefined);
  // Default to a wallet that IS delegated to this DRep — the easiest
  // baseline that lets the depth-guard tests focus on depth semantics
  // without re-asserting the membership gate.
  mockLookup.mockResolvedValue({ drepId: DREP_ID, source: 'koios' });
});

// Helper: extract the table name + item from the per-row write that
// goes to the NEW `clubhouse_comments` table. Returns undefined if no
// such call was made.
function findCommentsTablePut(): undefined | { table: string; item: Record<string, unknown> } {
  for (const call of mockPut.mock.calls) {
    const table = call[0] as string;
    const item = call[1] as Record<string, unknown>;
    if (table === 'test-clubhouse_comments') return { table, item };
  }
  return undefined;
}

// Helper: extract the counter Update (ADD commentCount). Returns
// undefined if no such call was made. Matches by ExpressionAttributeNames
// values rather than substring in the UpdateExpression — the handler uses
// `#cc` aliases, so the string `commentCount` doesn't appear there.
function findCounterUpdate(): undefined | {
  table: string;
  updateExpression: string;
  names: Record<string, string>;
} {
  for (const call of mockUpdate.mock.calls) {
    const table = call[0] as string;
    const updateExpression = call[2] as string;
    const names = call[3] as Record<string, string>;
    if (
      table === 'test-clubhouse_posts' &&
      updateExpression.includes('ADD') &&
      Object.values(names).includes('commentCount')
    ) {
      return { table, updateExpression, names };
    }
  }
  return undefined;
}

// Helper: extract the legacy inline-array append Update. Returns
// undefined if no such call was made.
function findInlineUpdate(): undefined | {
  table: string;
  updateExpression: string;
  conditionExpression: string | undefined;
  values: Record<string, unknown>;
} {
  for (const call of mockUpdate.mock.calls) {
    const table = call[0] as string;
    const updateExpression = call[2] as string;
    const values = call[4] as Record<string, unknown>;
    if (
      table === 'test-clubhouse_posts' &&
      updateExpression.includes('SET') &&
      Object.prototype.hasOwnProperty.call(values, ':comments')
    ) {
      return {
        table,
        updateExpression,
        conditionExpression: call[5] as string | undefined,
        values,
      };
    }
  }
  return undefined;
}

describe('clubhouse/createComment — depth guard', () => {
  it('allows top-level comment (no parentCommentId): dual-write fires', async () => {
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

    // (1) New per-row write fired.
    const newRowPut = findCommentsTablePut();
    expect(newRowPut).toBeDefined();
    expect(newRowPut!.item['depth']).toBe(0);
    expect(newRowPut!.item['parentCommentId']).toBeUndefined();
    expect(newRowPut!.item['postKey']).toBe(`${DREP_ID}#${POST_ID}`);

    // (2) Counter incremented on the post row.
    const counter = findCounterUpdate();
    expect(counter).toBeDefined();

    // (3) Legacy inline write fired (version-guarded on updatedAt).
    const inline = findInlineUpdate();
    expect(inline).toBeDefined();
    // ConditionExpression uses an alias (#u) — the bare field name
    // never appears in the expression. Assert the `:prev` value is
    // present and resolves to the previous post's updatedAt.
    expect(inline!.conditionExpression).toMatch(/:prev/);
    expect(inline!.values[':prev']).toBe('2026-05-20T00:00:00.000Z');
  });

  it('allows reply to a top-level comment (depth 1): new row has depth=1', async () => {
    wireDdbMocks({
      post: buildPostWithComments([{ commentId: 'top1' }]),
      committee: buildCommittee(),
      parentDepthsByCommentId: { top1: 0 },
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
    const newRowPut = findCommentsTablePut();
    expect(newRowPut).toBeDefined();
    expect(newRowPut!.item['depth']).toBe(1);
    expect(newRowPut!.item['parentCommentId']).toBe('top1');
  });

  it('allows sub-reply: reply to a reply (depth 2, the Clubhouse cap)', async () => {
    wireDdbMocks({
      post: buildPostWithComments([
        { commentId: 'top1' },
        { commentId: 'reply1', parentCommentId: 'top1' },
      ]),
      committee: buildCommittee(),
      parentDepthsByCommentId: { reply1: 1 },
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
    const newRowPut = findCommentsTablePut();
    expect(newRowPut).toBeDefined();
    expect(newRowPut!.item['depth']).toBe(2);
  });

  it('REJECTS reply to a sub-reply with 400 (would be depth 3)', async () => {
    // Parent (subreply1) is already at depth 2 — a new reply would
    // land at depth 3, which the Clubhouse cap rejects.
    wireDdbMocks({
      post: buildPostWithComments([
        { commentId: 'top1' },
        { commentId: 'reply1', parentCommentId: 'top1' },
        { commentId: 'subreply1', parentCommentId: 'reply1' },
      ]),
      committee: buildCommittee(),
      parentDepthsByCommentId: { subreply1: 2 },
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
    // Depth guard fires BEFORE any writes.
    expect(mockPut).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    const body = JSON.parse((res as { body: string }).body) as { message: string };
    expect(body.message).toMatch(/2 levels/);
  });

  it('falls back to inline-array walk when the new table has no row for the parent (pre-backfill)', async () => {
    // No `parentDepthsByCommentId` — getItem(clubhouse_comments)
    // returns undefined. The handler must fall back to walking the
    // post's inline `comments[]` array to determine depth.
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
        body: { body: 'sub-reply via fallback', parentCommentId: 'reply1' },
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 200 });
    const newRowPut = findCommentsTablePut();
    expect(newRowPut!.item['depth']).toBe(2);
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
    expect(mockUpdate).not.toHaveBeenCalled();
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
    expect(mockUpdate).not.toHaveBeenCalled();
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
    expect(mockUpdate).not.toHaveBeenCalled();
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
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe('clubhouse/createComment — dual-write semantics', () => {
  it('counter Update uses ADD commentCount :one SET lastReplyAt = :now', async () => {
    wireDdbMocks({ post: buildPostWithComments([]), committee: buildCommittee() });

    const res = (await handler(
      buildEvent({
        drepId: DREP_ID,
        postId: POST_ID,
        walletAddress: WALLET,
        body: { body: 'count me' },
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 200 });
    const counter = findCounterUpdate();
    expect(counter).toBeDefined();
    expect(counter!.updateExpression).toMatch(/ADD/);
    expect(counter!.updateExpression).toMatch(/SET/);
    // The named attributes carry `commentCount` + `lastReplyAt` + `updatedAt`.
    expect(Object.values(counter!.names)).toEqual(
      expect.arrayContaining(['commentCount', 'lastReplyAt', 'updatedAt']),
    );
  });

  it('still succeeds when the new-row put fails with ConditionalCheckFailedException (idempotent retry)', async () => {
    wireDdbMocks({ post: buildPostWithComments([]), committee: buildCommittee() });
    // First call (per-row write to clubhouse_comments) fails CCFE —
    // simulating a retried Lambda invocation. The handler must swallow
    // this and continue, NOT 5xx the user.
    mockPut.mockRejectedValueOnce(
      Object.assign(new Error('CCFE'), { name: 'ConditionalCheckFailedException' }),
    );

    const res = (await handler(
      buildEvent({
        drepId: DREP_ID,
        postId: POST_ID,
        walletAddress: WALLET,
        body: { body: 'idempotent retry' },
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 200 });
    // Counter still bumps; we treat the failed Put as success-equivalent.
    expect(findCounterUpdate()).toBeDefined();
  });

  it('5xx if the per-row write fails with a non-CCFE error', async () => {
    wireDdbMocks({ post: buildPostWithComments([]), committee: buildCommittee() });
    mockPut.mockRejectedValueOnce(new Error('DDB outage'));

    const res = (await handler(
      buildEvent({
        drepId: DREP_ID,
        postId: POST_ID,
        walletAddress: WALLET,
        body: { body: 'ddb is down' },
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 500 });
    // Counter MUST NOT bump if the per-row write failed for a non-CCFE
    // reason — otherwise the counter would lie.
    expect(findCounterUpdate()).toBeUndefined();
  });

  it('200 even when the counter Update fails (comment is still persisted)', async () => {
    wireDdbMocks({ post: buildPostWithComments([]), committee: buildCommittee() });
    // The counter Update is best-effort — a failure here is logged
    // but the user sees a 200 because the per-row comment IS written
    // to clubhouse_comments. The counter will resync on the next
    // backfill pass.
    let calls = 0;
    mockUpdate.mockImplementation(async () => {
      calls++;
      // First Update call is the counter ADD — fail it. Subsequent
      // calls (the legacy inline append) succeed.
      if (calls === 1) throw new Error('throttled');
      return undefined;
    });

    const res = (await handler(
      buildEvent({
        drepId: DREP_ID,
        postId: POST_ID,
        walletAddress: WALLET,
        body: { body: 'best effort counter' },
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 200 });
    expect(findCommentsTablePut()).toBeDefined();
  });

  it('legacy inline write retries ONCE on version conflict, then accepts silent loss', async () => {
    wireDdbMocks({ post: buildPostWithComments([]), committee: buildCommittee() });
    // Inline writes are the SECOND and THIRD updateItem calls (after
    // the counter ADD). Both fail with CCFE — first triggers a
    // re-read + retry, second confirms the silent-loss branch.
    let inlineAttempts = 0;
    mockUpdate.mockImplementation(async (
      _t: string,
      _k: Record<string, unknown>,
      updateExpression: string,
      _names: Record<string, string>,
      values: Record<string, unknown>,
    ) => {
      const isInline =
        updateExpression.includes('SET') &&
        Object.prototype.hasOwnProperty.call(values, ':comments');
      if (isInline) {
        inlineAttempts++;
        // Fail every inline attempt with CCFE.
        throw Object.assign(new Error('CCFE'), {
          name: 'ConditionalCheckFailedException',
        });
      }
      // Counter ADD succeeds.
      return undefined;
    });

    const res = (await handler(
      buildEvent({
        drepId: DREP_ID,
        postId: POST_ID,
        walletAddress: WALLET,
        body: { body: 'racey inline write' },
      }),
    )) as APIGatewayProxyResultV2;

    // User still sees success — the per-row write is the
    // authoritative copy; the legacy inline write is best-effort.
    expect(res).toMatchObject({ statusCode: 200 });
    // Exactly two inline attempts: initial + one retry after re-read.
    expect(inlineAttempts).toBe(2);
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
    expect(findCommentsTablePut()).toBeDefined();
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
    expect(mockUpdate).not.toHaveBeenCalled();
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
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('allows the LEAD DRep of this committee even if delegated elsewhere', async () => {
    wireDdbMocks({
      post: buildPostWithComments([]),
      committee: buildCommittee({ leadWallet: WALLET }),
    });
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
    expect(findCommentsTablePut()).toBeDefined();
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
    expect(findCommentsTablePut()).toBeDefined();
  });

  it('fails CLOSED with 503 when Koios+Blockfrost both fail (source: null) AND caller is not a role-holder', async () => {
    // SEC-2 (2026-05-28): the previous behavior was to soft-allow on
    // dual-upstream outage. Oracle flagged that as fail-open. New
    // posture: 503 the write so an attacker who can degrade the
    // delegation lookup can't post into any clubhouse. Role-holders
    // are exempt (separate test below).
    wireDdbMocks({ post: buildPostWithComments([]), committee: buildCommittee() });
    mockLookup.mockResolvedValueOnce({ drepId: null, source: null });

    const res = (await handler(
      buildEvent({
        drepId: DREP_ID,
        postId: POST_ID,
        walletAddress: WALLET,
        body: { body: 'koios is down — I should NOT be allowed through' },
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 503 });
    const parsed = JSON.parse((res as { body: string }).body) as {
      error: string;
      message: string;
    };
    expect(parsed.error).toBe('ServiceUnavailable');
    expect(parsed.message).toMatch(/verify your delegation|retry/i);
    // CRITICAL: no write should have happened on the fail-closed path.
    expect(findCommentsTablePut()).toBeUndefined();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('role-holder BYPASS: lead DRep still comments during a dual-upstream outage', async () => {
    // The fail-closed change above MUST NOT lock out role-holders. A
    // lead is identified via the local DDB committee Get, which has
    // no upstream dependency — they can comment even during a Koios
    // + Blockfrost outage.
    wireDdbMocks({
      post: buildPostWithComments([]),
      committee: buildCommittee({ leadWallet: WALLET }),
    });
    mockLookup.mockResolvedValueOnce({ drepId: null, source: null });

    const res = (await handler(
      buildEvent({
        drepId: DREP_ID,
        postId: POST_ID,
        walletAddress: WALLET,
        body: { body: 'lead chime-in during outage' },
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 200 });
    expect(findCommentsTablePut()).toBeDefined();
  });

  it('role-holder BYPASS: committee_member still comments during a dual-upstream outage', async () => {
    wireDdbMocks({
      post: buildPostWithComments([]),
      committee: buildCommittee({ memberWallets: [WALLET] }),
    });
    mockLookup.mockResolvedValueOnce({ drepId: null, source: null });

    const res = (await handler(
      buildEvent({
        drepId: DREP_ID,
        postId: POST_ID,
        walletAddress: WALLET,
        body: { body: 'committee voice during outage' },
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 200 });
    expect(findCommentsTablePut()).toBeDefined();
  });

  it('rejects a wallet that is delegated to a different DRep even when the committee row is missing', async () => {
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
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
