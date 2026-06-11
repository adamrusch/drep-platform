/**
 * Regression tests for `clubhouse/deletePost.ts` — specifically the
 * 2026-05-28 P0-4 fix that scoped the `lead_drep` override to the
 * SPECIFIC committee that owns this post's clubhouse.
 *
 * # The bug this guards against
 *
 * Before the fix, the handler used `requireOwnerOrRole(authCtx,
 * existing.authorWallet, 'lead_drep')`. `lead_drep` was honored
 * GLOBALLY — a caller who held the role in ANY committee could
 * delete a post in ANY clubhouse, including:
 *
 *   - The DRep's own committee's posts (where the override makes
 *     sense).
 *   - **Some other DRep's committee's posts (privilege escalation).**
 *   - **System-generated `auto_ga` posts owned by the governance
 *     feed.** Any registered DRep could moderate the auto-feed.
 *
 * The fix replaces the gate with
 * `requireOwnerOrCommitteeLead(authCtx, owner, committee)`, which
 * resolves the committee for THIS post's drepId and only honors the
 * override when the caller actually leads THAT committee.
 *
 * # What we lock in
 *
 *   1. **Cross-clubhouse moderation blocked.** A wallet that leads
 *      DRep X tries to delete a post in DRep Y's clubhouse → 403.
 *      This is the exact exploit; it MUST fail closed.
 *   2. **Owner can always delete.** The author's own posts delete
 *      regardless of any role.
 *   3. **Own-clubhouse lead can moderate.** A wallet that leads
 *      THIS clubhouse's committee can delete other authors' posts in
 *      their clubhouse.
 *   4. **`lead_drep` listed in `committee.members` also moderates.**
 *      The committee row's `members` array can grant `lead_drep`
 *      semantics beyond the single `leadWallet`.
 *   5. **`committee_member` / `trusted_delegator` do NOT moderate.**
 *      They have posting rights, not deletion rights.
 *   6. **No committee row → owner-only.** When the post's drepId
 *      has no committee row (auto-post clubhouses), the override has
 *      no effect.
 *   7. **DDB committee-Get failure → owner-only fallback** (no
 *      silent privilege escalation on transient outage).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

vi.mock('../../lib/dynamodb', () => ({
  getItem: vi.fn(),
  deleteItem: vi.fn(),
  // P0-3 Phase 6+ (2026-05-28): deletePost now cascades to comment
  // rows in `clubhouse_comments` via a Query. Default to an empty
  // page so existing tests that don't care about the cascade keep
  // their semantics; cascade-specific tests override per-test.
  queryItems: vi.fn().mockResolvedValue({ items: [], count: 0 }),
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

// Audit-log writes are side-channel — stub to a no-op so test
// expectations focus on the delete behaviour. See `lib/audit.test.ts`
// for the audit module's own coverage.
vi.mock('../../lib/audit', () => ({
  writeAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

import { getItem, deleteItem, queryItems } from '../../lib/dynamodb';
import { writeAuditEvent } from '../../lib/audit';
import { handler } from './deletePost';

const mockGet = vi.mocked(getItem);
const mockDelete = vi.mocked(deleteItem);
const mockQuery = vi.mocked(queryItems);
const mockAudit = vi.mocked(writeAuditEvent);

// Two distinct DReps: X (the post's owner clubhouse) and Y (the
// attacker's clubhouse — they lead Y but not X).
const DREP_X = 'drep1xownerclub1234567890abcdef1234567890abcdef1234567890';
const _DREP_Y = 'drep1yattackerclub567890abcdef1234567890abcdef1234567890';

const X_LEAD = 'stake1x_lead_wallet_for_drep_x';
const X_MEMBER_AS_LEAD =
  'stake1x_member_wallet_with_lead_drep_role_in_committee_members';
const X_PLAIN_MEMBER = 'stake1x_plain_committee_member_no_moderation_rights';
const X_TRUSTED = 'stake1x_trusted_delegator';
const Y_LEAD = 'stake1y_lead_wallet_for_drep_y_this_is_the_attacker';

const POST_AUTHOR = 'stake1somebody_who_wrote_a_post_in_X_clubhouse';
const POST_ID = 'post-01HABC123';

function buildEvent(opts: {
  walletAddress: string;
  roles: string[];
  drepId: string;
  postId: string;
}): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    pathParameters: { drepId: opts.drepId, postId: opts.postId },
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

function buildPost(authorWallet: string, drepId: string = DREP_X): unknown {
  return {
    drepId,
    postId: POST_ID,
    authorWallet,
    authorDisplayName: 'Author Name',
    isDRepPost: false,
    body: 'post body',
    comments: [],
    createdAt: '2026-05-20T00:00:00Z',
    updatedAt: '2026-05-20T00:00:00Z',
  };
}

function buildXCommittee(): unknown {
  // X's committee. X_LEAD is the platform-level leadWallet. The
  // `members` array also lists X_MEMBER_AS_LEAD with role `lead_drep`
  // (so we can prove the members[].role check works), plus a plain
  // committee_member and trusted_delegator.
  return {
    drepId: DREP_X,
    SK: 'COMMITTEE',
    leadWallet: X_LEAD,
    committeeName: 'X Committee',
    description: '',
    members: [
      { walletAddress: X_LEAD, role: 'lead_drep', joinedAt: '2026-01-01T00:00:00Z' },
      {
        walletAddress: X_MEMBER_AS_LEAD,
        role: 'lead_drep',
        joinedAt: '2026-01-01T00:00:00Z',
      },
      {
        walletAddress: X_PLAIN_MEMBER,
        role: 'committee_member',
        joinedAt: '2026-01-01T00:00:00Z',
      },
      {
        walletAddress: X_TRUSTED,
        role: 'trusted_delegator',
        joinedAt: '2026-01-01T00:00:00Z',
      },
    ],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('clubhouse/deletePost — P0-4 scope of lead_drep override', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockDelete.mockReset();
    mockDelete.mockResolvedValue(undefined);
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ items: [], count: 0 });
    mockAudit.mockReset();
    mockAudit.mockResolvedValue(undefined);
  });

  it('REJECTS the exploit: caller leads DRep Y, tries to delete a post in DRep X\'s clubhouse → 403', async () => {
    // The exact bug. Y_LEAD has `lead_drep` in their JWT claims
    // because they registered DRep Y. Before P0-4, this returned
    // 204 and deleted X's post. After P0-4, the gate looks up X's
    // committee, sees Y_LEAD is not in it, and rejects.
    mockGet
      // Get #1: the post we're trying to delete.
      .mockResolvedValueOnce(buildPost(POST_AUTHOR, DREP_X) as never)
      // Get #2: the committee row for DRep X.
      .mockResolvedValueOnce(buildXCommittee() as never);

    const res = (await handler(
      buildEvent({
        walletAddress: Y_LEAD,
        roles: ['lead_drep'], // global JWT role — IRRELEVANT, scope matters
        drepId: DREP_X,
        postId: POST_ID,
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 403 });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('allows the post author to delete their own post regardless of role', async () => {
    mockGet
      .mockResolvedValueOnce(buildPost(POST_AUTHOR, DREP_X) as never)
      .mockResolvedValueOnce(buildXCommittee() as never);

    const res = (await handler(
      buildEvent({
        walletAddress: POST_AUTHOR,
        roles: [], // no roles needed — author can always delete
        drepId: DREP_X,
        postId: POST_ID,
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 204 });
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });

  it('allows the lead DRep of THIS clubhouse\'s committee to delete posts', async () => {
    mockGet
      .mockResolvedValueOnce(buildPost(POST_AUTHOR, DREP_X) as never)
      .mockResolvedValueOnce(buildXCommittee() as never);

    const res = (await handler(
      buildEvent({
        walletAddress: X_LEAD, // matches committee.leadWallet
        roles: ['lead_drep'],
        drepId: DREP_X,
        postId: POST_ID,
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 204 });
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });

  it('allows a wallet listed in committee.members with role `lead_drep` to delete', async () => {
    mockGet
      .mockResolvedValueOnce(buildPost(POST_AUTHOR, DREP_X) as never)
      .mockResolvedValueOnce(buildXCommittee() as never);

    const res = (await handler(
      buildEvent({
        walletAddress: X_MEMBER_AS_LEAD,
        roles: ['lead_drep'],
        drepId: DREP_X,
        postId: POST_ID,
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 204 });
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });

  it('REJECTS a `committee_member` of this clubhouse trying to delete someone else\'s post', async () => {
    // committee_member is a posting role, not a moderation role.
    mockGet
      .mockResolvedValueOnce(buildPost(POST_AUTHOR, DREP_X) as never)
      .mockResolvedValueOnce(buildXCommittee() as never);

    const res = (await handler(
      buildEvent({
        walletAddress: X_PLAIN_MEMBER,
        roles: ['committee_member'],
        drepId: DREP_X,
        postId: POST_ID,
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 403 });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('REJECTS a `trusted_delegator` of this clubhouse trying to delete someone else\'s post', async () => {
    mockGet
      .mockResolvedValueOnce(buildPost(POST_AUTHOR, DREP_X) as never)
      .mockResolvedValueOnce(buildXCommittee() as never);

    const res = (await handler(
      buildEvent({
        walletAddress: X_TRUSTED,
        roles: ['trusted_delegator'],
        drepId: DREP_X,
        postId: POST_ID,
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 403 });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('falls back to owner-only when no committee row exists (e.g. auto-post clubhouses)', async () => {
    mockGet
      .mockResolvedValueOnce(buildPost(POST_AUTHOR, DREP_X) as never)
      // Get #2: no committee row.
      .mockResolvedValueOnce(undefined);

    // Non-author with global lead_drep claim → 403.
    const exploitRes = (await handler(
      buildEvent({
        walletAddress: Y_LEAD,
        roles: ['lead_drep'],
        drepId: DREP_X,
        postId: POST_ID,
      }),
    )) as APIGatewayProxyResultV2;
    expect(exploitRes).toMatchObject({ statusCode: 403 });

    // Reset for the author check.
    mockGet.mockReset();
    mockDelete.mockReset();
    mockDelete.mockResolvedValue(undefined);
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ items: [], count: 0 });
    mockGet
      .mockResolvedValueOnce(buildPost(POST_AUTHOR, DREP_X) as never)
      .mockResolvedValueOnce(undefined);

    const authorRes = (await handler(
      buildEvent({
        walletAddress: POST_AUTHOR,
        roles: [],
        drepId: DREP_X,
        postId: POST_ID,
      }),
    )) as APIGatewayProxyResultV2;
    expect(authorRes).toMatchObject({ statusCode: 204 });
  });

  it('falls back to owner-only on a transient committee-Get failure (no silent promotion to global override)', async () => {
    mockGet
      .mockResolvedValueOnce(buildPost(POST_AUTHOR, DREP_X) as never)
      // Get #2: committee lookup throws.
      .mockRejectedValueOnce(new Error('DDB transient failure'));

    const res = (await handler(
      buildEvent({
        walletAddress: Y_LEAD, // non-owner, would-be cross-committee mod
        roles: ['lead_drep'],
        drepId: DREP_X,
        postId: POST_ID,
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 403 });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('returns 404 when the post does not exist', async () => {
    mockGet.mockResolvedValueOnce(undefined);

    const res = (await handler(
      buildEvent({
        walletAddress: X_LEAD,
        roles: ['lead_drep'],
        drepId: DREP_X,
        postId: 'no-such-post',
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 404 });
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

describe('clubhouse/deletePost — P0-3 Phase 6+ comment-row cascade (2026-05-28)', () => {
  // Now that comments live in the per-row `clubhouse_comments` table
  // (PK=postKey=`drepId#postId`, SK=commentId), deleting a post MUST
  // remove its comment rows too — otherwise the rows orphan with no
  // way to re-attach or surface them.
  beforeEach(() => {
    mockGet.mockReset();
    mockDelete.mockReset();
    mockDelete.mockResolvedValue(undefined);
    mockQuery.mockReset();
    mockAudit.mockReset();
    mockAudit.mockResolvedValue(undefined);
  });

  it('cascades to delete every clubhouse_comments row under the post (one Query → N deletes)', async () => {
    mockGet
      .mockResolvedValueOnce(buildPost(POST_AUTHOR, DREP_X) as never)
      .mockResolvedValueOnce(buildXCommittee() as never);
    // Query against clubhouse_comments returns 3 rows on a single page.
    mockQuery.mockResolvedValueOnce({
      items: [
        { postKey: `${DREP_X}#${POST_ID}`, commentId: 'c1' },
        { postKey: `${DREP_X}#${POST_ID}`, commentId: 'c2' },
        { postKey: `${DREP_X}#${POST_ID}`, commentId: 'c3' },
      ],
      count: 3,
    });

    const res = (await handler(
      buildEvent({
        walletAddress: POST_AUTHOR,
        roles: [],
        drepId: DREP_X,
        postId: POST_ID,
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 204 });
    // 1 delete for the post + 3 for the comment rows = 4 total.
    expect(mockDelete).toHaveBeenCalledTimes(4);
    // The post delete fires first.
    expect(mockDelete.mock.calls[0]![0]).toBe('test-clubhouse_posts');
    // The cascade deletes go to clubhouse_comments with the right keys.
    const cascadeCalls = mockDelete.mock.calls.filter(
      (c) => c[0] === 'test-clubhouse_comments',
    );
    expect(cascadeCalls).toHaveLength(3);
    expect(cascadeCalls.map((c) => (c[1] as Record<string, unknown>)['commentId'])).toEqual(
      ['c1', 'c2', 'c3'],
    );
    // The Query used the partition-key shape we expect.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const queryArgs = mockQuery.mock.calls[0]![1] as { expressionAttributeValues: Record<string, unknown> };
    expect(queryArgs.expressionAttributeValues[':pk']).toBe(`${DREP_X}#${POST_ID}`);
  });

  it('cascades across paginated Query pages (LastEvaluatedKey loop)', async () => {
    // First page returns 2 rows + a continuation key; second page
    // returns 1 row + no continuation. Total 3 cascade deletes.
    mockGet
      .mockResolvedValueOnce(buildPost(POST_AUTHOR, DREP_X) as never)
      .mockResolvedValueOnce(buildXCommittee() as never);
    mockQuery
      .mockResolvedValueOnce({
        items: [
          { postKey: `${DREP_X}#${POST_ID}`, commentId: 'c1' },
          { postKey: `${DREP_X}#${POST_ID}`, commentId: 'c2' },
        ],
        count: 2,
        lastEvaluatedKey: { postKey: `${DREP_X}#${POST_ID}`, commentId: 'c2' },
      })
      .mockResolvedValueOnce({
        items: [{ postKey: `${DREP_X}#${POST_ID}`, commentId: 'c3' }],
        count: 1,
      });

    const res = (await handler(
      buildEvent({
        walletAddress: POST_AUTHOR,
        roles: [],
        drepId: DREP_X,
        postId: POST_ID,
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 204 });
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const cascadeCalls = mockDelete.mock.calls.filter(
      (c) => c[0] === 'test-clubhouse_comments',
    );
    expect(cascadeCalls).toHaveLength(3);
  });

  it('204 even when zero comments exist on the post (no-comments cascade is a no-op)', async () => {
    mockGet
      .mockResolvedValueOnce(buildPost(POST_AUTHOR, DREP_X) as never)
      .mockResolvedValueOnce(buildXCommittee() as never);
    mockQuery.mockResolvedValueOnce({ items: [], count: 0 });

    const res = (await handler(
      buildEvent({
        walletAddress: POST_AUTHOR,
        roles: [],
        drepId: DREP_X,
        postId: POST_ID,
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 204 });
    // Post delete fires. No cascade deletes — there's nothing to
    // delete.
    const cascadeCalls = mockDelete.mock.calls.filter(
      (c) => c[0] === 'test-clubhouse_comments',
    );
    expect(cascadeCalls).toHaveLength(0);
  });

  it('continues + logs when a single comment-row delete fails (idempotent — re-run picks it up)', async () => {
    mockGet
      .mockResolvedValueOnce(buildPost(POST_AUTHOR, DREP_X) as never)
      .mockResolvedValueOnce(buildXCommittee() as never);
    mockQuery.mockResolvedValueOnce({
      items: [
        { postKey: `${DREP_X}#${POST_ID}`, commentId: 'c1' },
        { postKey: `${DREP_X}#${POST_ID}`, commentId: 'c2' },
      ],
      count: 2,
    });
    // The post delete (first call) succeeds; c1 delete fails; c2
    // succeeds. The handler still returns 204.
    mockDelete
      .mockResolvedValueOnce(undefined) // post delete
      .mockRejectedValueOnce(new Error('throttled')) // c1 delete fails
      .mockResolvedValueOnce(undefined); // c2 delete OK

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = (await handler(
      buildEvent({
        walletAddress: POST_AUTHOR,
        roles: [],
        drepId: DREP_X,
        postId: POST_ID,
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 204 });
    // The failure is logged; the cascade continues.
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('post delete still happens even if the cascade Query throws (idempotent re-run cleans up later)', async () => {
    mockGet
      .mockResolvedValueOnce(buildPost(POST_AUTHOR, DREP_X) as never)
      .mockResolvedValueOnce(buildXCommittee() as never);
    mockQuery.mockRejectedValueOnce(new Error('DDB Query failed'));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = (await handler(
      buildEvent({
        walletAddress: POST_AUTHOR,
        roles: [],
        drepId: DREP_X,
        postId: POST_ID,
      }),
    )) as APIGatewayProxyResultV2;

    // Post is GONE; the cascade Query failure is logged but doesn't
    // roll back the post delete (the cleanup is left for a future
    // re-run, which is idempotent).
    expect(res).toMatchObject({ statusCode: 204 });
    expect(mockDelete).toHaveBeenCalledWith(
      'test-clubhouse_posts',
      expect.objectContaining({ postId: POST_ID }),
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
