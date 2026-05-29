/**
 * Regression tests for the Clubhouse `createPost` handler.
 *
 * # What we're verifying (per Adam's request: "Delegator Clubhouse must
 * be verified working end-to-end")
 *
 *   - Authorization gates: only role-bearing members of the DRep's own
 *     committee can post.
 *   - Body validation: empty / oversized bodies are rejected.
 *   - Post-type matrix: discussion / question / poll all persist
 *     correctly with the right defaults.
 *   - Poll validation: <2 options rejected, >8 options rejected,
 *     duplicate IDs rejected, empty labels rejected, label-length cap
 *     enforced.
 *   - `isDRepPost` flag: true for lead-DRep + committee-member authors,
 *     false for trusted-delegator authors.
 *   - Recognition pills: stake + drep pills are populated best-effort
 *     and a recognition lookup failure does NOT fail the write.
 *
 * # Why this matters for the bug
 *
 * Before this fix lands the Clubhouse path was only ever exercised by
 * Adam clicking buttons in production. There's no QA harness around
 * the post-creation flow. A regression in `requireRole` or in the
 * committee-lookup gate would silently let non-members post (security
 * regression) or block legitimate members (UX regression). This file
 * pins the contract end-to-end through the handler.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';

// Mock the DynamoDB layer + recognition lookup BEFORE importing the SUT.
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
    clubhousePosts: 'test-clubhouse_posts',
    auditLog: 'test-audit_log',
    authNonces: 'test-auth_nonces',
  },
}));

vi.mock('../../lib/recognition', () => ({
  lookupRecognition: vi.fn(),
  lookupCurrentDrep: vi.fn(),
}));

import { getItem, putItem } from '../../lib/dynamodb';
import { lookupRecognition, lookupCurrentDrep } from '../../lib/recognition';
import { handler } from './createPost';

const mockGet = vi.mocked(getItem);
const mockPut = vi.mocked(putItem);
const mockRecognition = vi.mocked(lookupRecognition);
const mockLookupCurrentDrep = vi.mocked(lookupCurrentDrep);

// ---- Test fixtures ----

const DREP_ID = 'drep1ygqgayvx8yzsaj9hprja3l6jy3v4px9z3u8uvecuvm3f92ce7mckx';
const LEAD_WALLET = 'stake1uyvjdz9rxsfsmv44rtk75k2rqyqskrga96dgdfrqjvjjpwsefcjnp';
const COMMITTEE_MEMBER_WALLET = 'stake1uy0xrh7g8q0eg7e63srdvcqqxnvjvqzhk3fnkflfx5g3dxgrx2hsh';
const TRUSTED_DELEGATOR_WALLET = 'stake1ux7mmwcsdcyqj88kuxk8xx2tjyvfm8h62vcjngm6plrx4lstr9sj4';
const OUTSIDER_WALLET = 'stake1u9z8q9j5z9q5z9q5z9q5z9q5z9q5z9q5z9q5z9q5z9q5z9q5z9q5';

/** Build a minimal authorizer context shape that matches what API Gateway
 *  delivers from the Lambda authorizer. The role-guard middleware reads
 *  `event.requestContext.authorizer.lambda` and pulls fields from there. */
function buildEvent(opts: {
  walletAddress: string;
  roles: string[];
  drepId: string;
  body: unknown;
}): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    body: JSON.stringify(opts.body),
    pathParameters: { drepId: opts.drepId },
    requestContext: {
      authorizer: {
        lambda: {
          walletAddress: opts.walletAddress,
          roles: JSON.stringify(opts.roles),
          sessionType: 'normal',
        },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer['requestContext'],
    // Empty fields not exercised by createPost.ts — cast through unknown
    // rather than build the entire HTTP API v2 event shape.
    rawPath: '',
    rawQueryString: '',
    headers: {},
    isBase64Encoded: false,
    routeKey: '',
    version: '2.0',
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

/** Build the `DRepCommittees` row the handler reads to verify membership. */
function buildCommittee(): unknown {
  return {
    drepId: DREP_ID,
    SK: 'COMMITTEE',
    leadWallet: LEAD_WALLET,
    committeeName: 'Test Committee',
    description: '',
    members: [
      { walletAddress: LEAD_WALLET, role: 'lead_drep', joinedAt: '2026-01-01T00:00:00Z' },
      { walletAddress: COMMITTEE_MEMBER_WALLET, role: 'committee_member', joinedAt: '2026-01-01T00:00:00Z' },
      { walletAddress: TRUSTED_DELEGATOR_WALLET, role: 'trusted_delegator', joinedAt: '2026-01-01T00:00:00Z' },
    ],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function parseResponseBody(res: APIGatewayProxyResultV2): Record<string, unknown> {
  if (typeof res !== 'object' || res === null) throw new Error('expected object response');
  const r = res as { body?: string };
  if (typeof r.body !== 'string') throw new Error('expected body string');
  return JSON.parse(r.body) as Record<string, unknown>;
}

describe('clubhouse/createPost', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPut.mockReset();
    mockRecognition.mockReset();
    mockLookupCurrentDrep.mockReset();
    // Default: recognition succeeds with mock pills.
    mockRecognition.mockResolvedValue({
      stakeAda: '1.0M ₳',
      drep: 'drep1mock',
    });
    // Default: caller is currently delegated to THIS DRep. Most tests
    // exercise role-holder paths (where this lookup doesn't matter for
    // the allow/reject decision) so a "delegated correctly" default is
    // the least-surprising baseline. Tests covering the non-delegator
    // path override this per-test.
    mockLookupCurrentDrep.mockResolvedValue({ drepId: DREP_ID, source: 'koios' });
    mockPut.mockResolvedValue(undefined);
  });

  // ---- Authorization gates ----
  //
  // Updated 2026-05-28: the Clubhouse posting gate was unified with the
  // comment gate under `resolveClubhouseMembership`. The gate now
  // accepts EITHER role-holders (committee members of THIS drep) OR
  // wallets currently delegating to THIS drep. The legacy JWT-role-only
  // gate ("rejects callers without lead_drep/etc.") is gone — that gate
  // didn't match what users expected from a "clubhouse" surface (their
  // own DRep's clubhouse should let them post, not just the committee).

  it('rejects callers who are neither delegated to THIS DRep nor role-holders', async () => {
    // Committee exists, caller isn't in it. Caller is delegated to a
    // DIFFERENT DRep — definitive non-membership.
    mockGet.mockResolvedValueOnce(buildCommittee() as never);
    mockLookupCurrentDrep.mockResolvedValue({
      drepId: 'drep1other',
      source: 'koios',
    });
    const event = buildEvent({
      walletAddress: OUTSIDER_WALLET,
      roles: ['delegator'],
      drepId: DREP_ID,
      body: { body: 'hi' },
    });

    const res = (await handler(event)) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 403 });
    const parsed = parseResponseBody(res);
    expect(parsed['message']).toMatch(/delegated to this DRep|committee/i);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('rejects callers when undelegated AND not a role-holder', async () => {
    // Definitive null delegation (Koios confirmed undelegated).
    mockGet.mockResolvedValueOnce(buildCommittee() as never);
    mockLookupCurrentDrep.mockResolvedValue({ drepId: null, source: 'koios' });
    const event = buildEvent({
      walletAddress: OUTSIDER_WALLET,
      roles: ['delegator'],
      drepId: DREP_ID,
      body: { body: 'hi' },
    });

    const res = (await handler(event)) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 403 });
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('allows a delegator (no committee role) to post in their DRep clubhouse', async () => {
    // Outsider has no role here; the lookup confirms they're delegated.
    mockGet.mockResolvedValueOnce(buildCommittee() as never);
    mockLookupCurrentDrep.mockResolvedValue({ drepId: DREP_ID, source: 'koios' });
    const event = buildEvent({
      walletAddress: OUTSIDER_WALLET,
      roles: ['delegator'],
      drepId: DREP_ID,
      body: { body: 'hi from a delegator' },
    });

    const res = (await handler(event)) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 201 });
    expect(mockPut).toHaveBeenCalledTimes(1);
    const written = mockPut.mock.calls[0]![1] as Record<string, unknown>;
    // Delegator posts must NOT be marked as DRep posts — they're not
    // authored by the DRep or their committee.
    expect(written['isDRepPost']).toBe(false);
  });

  it('fails CLOSED with 503 when both Koios + Blockfrost are unreachable AND caller is not a role-holder', async () => {
    // source=null signals both upstreams failed. SEC-2 (2026-05-28)
    // change: this used to soft-allow ("upstream is down but I should
    // still be able to post"). Oracle flagged that as a fail-open
    // anti-pattern. The new posture is fail-CLOSED — uncertainty about
    // delegation must not grant access. Role-holders are unaffected
    // (separate test below).
    mockGet.mockResolvedValueOnce(buildCommittee() as never);
    mockLookupCurrentDrep.mockResolvedValue({ drepId: null, source: null });
    const event = buildEvent({
      walletAddress: OUTSIDER_WALLET,
      roles: ['delegator'],
      drepId: DREP_ID,
      body: { body: 'upstream is down, I should NOT be able to post anonymously' },
    });

    const res = (await handler(event)) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 503 });
    const parsed = parseResponseBody(res);
    expect(parsed['message']).toMatch(/verify your delegation|retry/i);
    expect(parsed['error']).toBe('ServiceUnavailable');
    // CRITICAL: no write should have happened on the fail-closed path.
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('role-holder BYPASS: lead DRep still posts during a dual-upstream outage', async () => {
    // The fail-closed change above must NOT lock out role-holders. A
    // lead/committee_member/trusted_delegator is identified via the
    // local DDB committee Get, which has no upstream dependency — so
    // they can write even when both Koios and Blockfrost are down.
    mockGet.mockResolvedValueOnce(buildCommittee() as never);
    mockLookupCurrentDrep.mockResolvedValue({ drepId: null, source: null });
    const event = buildEvent({
      walletAddress: LEAD_WALLET,
      roles: ['lead_drep'],
      drepId: DREP_ID,
      body: { body: 'lead chime-in during a Koios outage' },
    });

    const res = (await handler(event)) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 201 });
    expect(mockPut).toHaveBeenCalledTimes(1);
    const written = mockPut.mock.calls[0]![1] as Record<string, unknown>;
    expect(written['isDRepPost']).toBe(true);
  });

  it('role-holder BYPASS: committee_member still posts during a dual-upstream outage', async () => {
    mockGet.mockResolvedValueOnce(buildCommittee() as never);
    mockLookupCurrentDrep.mockResolvedValue({ drepId: null, source: null });
    const event = buildEvent({
      walletAddress: COMMITTEE_MEMBER_WALLET,
      roles: ['committee_member'],
      drepId: DREP_ID,
      body: { body: 'committee member during outage' },
    });

    const res = (await handler(event)) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 201 });
    expect(mockPut).toHaveBeenCalledTimes(1);
  });

  // ---- Body validation ----

  it('rejects empty body', async () => {
    mockGet.mockResolvedValueOnce(buildCommittee() as never);
    const event = buildEvent({
      walletAddress: LEAD_WALLET,
      roles: ['lead_drep'],
      drepId: DREP_ID,
      body: { body: '   ' },
    });

    const res = (await handler(event)) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 400 });
  });

  it('rejects body over 50,000 characters', async () => {
    mockGet.mockResolvedValueOnce(buildCommittee() as never);
    const event = buildEvent({
      walletAddress: LEAD_WALLET,
      roles: ['lead_drep'],
      drepId: DREP_ID,
      body: { body: 'a'.repeat(50_001) },
    });

    const res = (await handler(event)) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 400 });
  });

  // ---- Post type matrix ----

  it('persists a discussion post with isDRepPost=true for the lead', async () => {
    mockGet.mockResolvedValueOnce(buildCommittee() as never);
    const event = buildEvent({
      walletAddress: LEAD_WALLET,
      roles: ['lead_drep'],
      drepId: DREP_ID,
      body: { body: 'hello world', title: 'Welcome' },
    });

    const res = (await handler(event)) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 201 });

    expect(mockPut).toHaveBeenCalledTimes(1);
    const written = mockPut.mock.calls[0]![1] as Record<string, unknown>;
    expect(written['authorWallet']).toBe(LEAD_WALLET);
    expect(written['drepId']).toBe(DREP_ID);
    expect(written['isDRepPost']).toBe(true);
    expect(written['type']).toBe('discussion');
    expect(written['body']).toBe('hello world');
    expect(written['title']).toBe('Welcome');
    expect(written['stakeAda']).toBe('1.0M ₳');
    expect(written['drep']).toBe('drep1mock');
  });

  it('marks isDRepPost=true for a committee_member author', async () => {
    mockGet.mockResolvedValueOnce(buildCommittee() as never);
    const event = buildEvent({
      walletAddress: COMMITTEE_MEMBER_WALLET,
      roles: ['committee_member'],
      drepId: DREP_ID,
      body: { body: 'a committee post' },
    });

    const res = (await handler(event)) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 201 });
    const written = mockPut.mock.calls[0]![1] as Record<string, unknown>;
    expect(written['isDRepPost']).toBe(true);
  });

  it('marks isDRepPost=false for a trusted_delegator author', async () => {
    // Trusted delegators can post in the clubhouse but their posts are
    // NOT branded as official DRep statements. This matters because the
    // frontend renders a "DRep" badge on `isDRepPost: true` cards.
    mockGet.mockResolvedValueOnce(buildCommittee() as never);
    const event = buildEvent({
      walletAddress: TRUSTED_DELEGATOR_WALLET,
      roles: ['trusted_delegator'],
      drepId: DREP_ID,
      body: { body: 'a delegator post' },
    });

    const res = (await handler(event)) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 201 });
    const written = mockPut.mock.calls[0]![1] as Record<string, unknown>;
    expect(written['isDRepPost']).toBe(false);
  });

  // ---- Poll validation ----

  it('persists a poll with valid options', async () => {
    mockGet.mockResolvedValueOnce(buildCommittee() as never);
    const event = buildEvent({
      walletAddress: LEAD_WALLET,
      roles: ['lead_drep'],
      drepId: DREP_ID,
      body: {
        body: 'Vote on this',
        type: 'poll',
        pollOptions: [{ label: 'Yes' }, { label: 'No' }, { label: 'Abstain' }],
        pollMultiple: false,
        pollClosesAt: '2026-12-31T23:59:59.000Z',
      },
    });

    const res = (await handler(event)) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 201 });
    const written = mockPut.mock.calls[0]![1] as Record<string, unknown>;
    expect(written['type']).toBe('poll');
    expect(written['pollOptions']).toEqual([
      { id: 'a', label: 'Yes', votes: 0 },
      { id: 'b', label: 'No', votes: 0 },
      { id: 'c', label: 'Abstain', votes: 0 },
    ]);
    expect(written['pollMultiple']).toBe(false);
    expect(written['pollClosesAt']).toBe('2026-12-31T23:59:59.000Z');
    expect(written['pollVotes']).toEqual({});
  });

  it('rejects polls with fewer than 2 options', async () => {
    mockGet.mockResolvedValueOnce(buildCommittee() as never);
    const event = buildEvent({
      walletAddress: LEAD_WALLET,
      roles: ['lead_drep'],
      drepId: DREP_ID,
      body: { body: '?', type: 'poll', pollOptions: [{ label: 'Only one' }] },
    });

    const res = (await handler(event)) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 400 });
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('rejects polls with more than 8 options', async () => {
    mockGet.mockResolvedValueOnce(buildCommittee() as never);
    const event = buildEvent({
      walletAddress: LEAD_WALLET,
      roles: ['lead_drep'],
      drepId: DREP_ID,
      body: {
        body: '?',
        type: 'poll',
        pollOptions: Array.from({ length: 9 }, (_, i) => ({ label: `opt ${i}` })),
      },
    });

    const res = (await handler(event)) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 400 });
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('rejects poll with duplicate option IDs', async () => {
    mockGet.mockResolvedValueOnce(buildCommittee() as never);
    const event = buildEvent({
      walletAddress: LEAD_WALLET,
      roles: ['lead_drep'],
      drepId: DREP_ID,
      body: {
        body: '?',
        type: 'poll',
        pollOptions: [
          { id: 'x', label: 'A' },
          { id: 'x', label: 'B' },
        ],
      },
    });

    const res = (await handler(event)) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 400 });
    const parsed = parseResponseBody(res);
    expect(parsed['message']).toMatch(/duplicate/i);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('rejects poll with empty option label', async () => {
    mockGet.mockResolvedValueOnce(buildCommittee() as never);
    const event = buildEvent({
      walletAddress: LEAD_WALLET,
      roles: ['lead_drep'],
      drepId: DREP_ID,
      body: {
        body: '?',
        type: 'poll',
        pollOptions: [{ label: 'A' }, { label: '   ' }],
      },
    });

    const res = (await handler(event)) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 400 });
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('rejects unknown post type', async () => {
    mockGet.mockResolvedValueOnce(buildCommittee() as never);
    const event = buildEvent({
      walletAddress: LEAD_WALLET,
      roles: ['lead_drep'],
      drepId: DREP_ID,
      body: { body: 'hi', type: 'rant' },
    });

    const res = (await handler(event)) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 400 });
  });

  // ---- Recognition tolerance ----

  it('still writes the post even when recognition lookup fails', async () => {
    // Recognition pills are best-effort decoration — a Koios/Blockfrost
    // outage MUST NOT block a member from posting in their committee's
    // clubhouse. Lock this behavior in.
    mockGet.mockResolvedValueOnce(buildCommittee() as never);
    mockRecognition.mockResolvedValueOnce({}); // empty — both providers failed

    const event = buildEvent({
      walletAddress: LEAD_WALLET,
      roles: ['lead_drep'],
      drepId: DREP_ID,
      body: { body: 'hi' },
    });

    const res = (await handler(event)) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 201 });
    expect(mockPut).toHaveBeenCalledTimes(1);
    const written = mockPut.mock.calls[0]![1] as Record<string, unknown>;
    // Pills absent (we don't write empty strings — see the spread guard).
    expect(written['stakeAda']).toBeUndefined();
    expect(written['drep']).toBeUndefined();
    // But the post itself was written.
    expect(written['body']).toBe('hi');
  });
});
