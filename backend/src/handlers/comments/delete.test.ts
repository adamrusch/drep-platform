/**
 * Regression tests for `comments/delete.ts` — specifically the
 * 2026-05-28 P0-4 fix that removed the GLOBAL `lead_drep` override
 * from the action-comment deletion gate.
 *
 * # The bug this guards against
 *
 * Before the fix, `requireOwnerOrRole(authCtx, existing.walletAddress,
 * 'lead_drep')` allowed any caller holding `lead_drep` ANYWHERE to
 * delete any action comment. Action comments are scoped to a
 * governance ACTION (not a DRep), so there's no natural "owning
 * committee" to which the override could be re-scoped. We picked
 * option (a) from the audit brief: author-only deletion, no platform
 * moderator. If product later wants moderation, it should be an
 * explicit per-action role (audited via the audit_log), not piggy-
 * backed on an existing unrelated committee role.
 *
 * # What we lock in
 *
 *   1. **Author can delete.** Owner of the comment can always delete.
 *   2. **`lead_drep` from elsewhere CANNOT delete.** This is the
 *      exact privilege-escalation the fix closes.
 *   3. **`committee_member` and `trusted_delegator` CANNOT delete**
 *      (defense in depth — these roles never had override semantics,
 *      but we pin the contract).
 *   4. **404 for non-existent comments.**
 *
 * # Mocking strategy
 *
 * The handler does a cascade cleanup (queries vote rows, deletes
 * sibling replies, etc.) after the auth check. We don't care about
 * those internals for the auth tests — we just stub them out and
 * focus on whether the handler 403s before any mutation, or 204s
 * after the cascade.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

vi.mock('../../lib/dynamodb', () => ({
  getItem: vi.fn(),
  deleteItem: vi.fn(),
  queryItems: vi.fn(),
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

import { getItem, deleteItem, queryItems } from '../../lib/dynamodb';
import { handler } from './delete';

const mockGet = vi.mocked(getItem);
const mockDelete = vi.mocked(deleteItem);
const mockQuery = vi.mocked(queryItems);

const ACTION_ID = 'aaaaaaaa#0';
const COMMENT_ID = '01HXMHTEST123ABCDEF';
const AUTHOR = 'stake1uyvjdz9rxsfsmv44rtk75k2rqyqskrga96dgdfrqjvjjpwsefcjnp';
const OUTSIDER_LEAD =
  'stake1uy0xrh7g8q0eg7e63srdvcqqxnvjvqzhk3fnkflfx5g3dxgrx2hsh';

function buildEvent(opts: {
  walletAddress: string;
  roles: string[];
}): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    pathParameters: { actionId: ACTION_ID, commentId: COMMENT_ID },
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

function buildComment(): unknown {
  return {
    actionId: ACTION_ID,
    commentId: COMMENT_ID,
    walletAddress: AUTHOR,
    body: 'a comment',
    isPublic: true,
    isDRep: false,
    createdAt: '2026-05-25T00:00:00Z',
    updatedAt: '2026-05-25T00:00:00Z',
    supportLovelace: 0n,
    upvoteCount: 1,
    downvoteCount: 0,
  };
}

describe('comments/delete — P0-4 author-only authorization', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockDelete.mockReset();
    mockDelete.mockResolvedValue(undefined);
    mockQuery.mockReset();
    // The cascade-cleanup query results: zero votes, zero replies.
    mockQuery.mockResolvedValue({ items: [], count: 0 });
  });

  it('allows the comment author to delete their own comment', async () => {
    mockGet.mockResolvedValueOnce(buildComment() as never);

    const res = (await handler(
      buildEvent({ walletAddress: AUTHOR, roles: [] }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 204 });
    // The cascade should have called deleteItem at least for the
    // comment itself. The exact number depends on internal cleanup
    // (vote rows, replies); at minimum the parent must be gone.
    expect(mockDelete).toHaveBeenCalled();
  });

  it('REJECTS a caller holding global `lead_drep` who is NOT the author (the P0-4 exploit)', async () => {
    // The exact privilege-escalation closed by P0-4. Before the fix,
    // this returned 204 and silently deleted someone else's comment.
    mockGet.mockResolvedValueOnce(buildComment() as never);

    const res = (await handler(
      buildEvent({
        walletAddress: OUTSIDER_LEAD,
        roles: ['lead_drep'], // global JWT role — must NOT override
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 403 });
    // No delete should have happened — author-only is enforced.
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('REJECTS a `committee_member` who is not the author', async () => {
    mockGet.mockResolvedValueOnce(buildComment() as never);

    const res = (await handler(
      buildEvent({
        walletAddress: OUTSIDER_LEAD,
        roles: ['committee_member'],
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 403 });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('REJECTS a `trusted_delegator` who is not the author', async () => {
    mockGet.mockResolvedValueOnce(buildComment() as never);

    const res = (await handler(
      buildEvent({
        walletAddress: OUTSIDER_LEAD,
        roles: ['trusted_delegator'],
      }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 403 });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('returns 404 when the comment does not exist', async () => {
    mockGet.mockResolvedValueOnce(undefined);

    const res = (await handler(
      buildEvent({ walletAddress: AUTHOR, roles: [] }),
    )) as APIGatewayProxyResultV2;

    expect(res).toMatchObject({ statusCode: 404 });
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
