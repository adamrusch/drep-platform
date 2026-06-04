/**
 * Regression tests for the `/auth/me` handler — specifically the
 * `delegatedToDrepId` field that fixes "my wallet's chosen DRep is
 * not being recognized".
 *
 * # The bug this guards against
 *
 * Pre-fix `/auth/me` returned `drepId` from the JWT context — but
 * `drepId` is the REGISTERED-DRep id (set when the user themselves
 * registered as a DRep), not the DRep they delegate to. Frontend code
 * conflated the two, so the Clubhouse routing and "your DRep" surfaces
 * routed wallets to the wrong DRep (or nowhere).
 *
 * Post-fix `/auth/me` adds `delegatedToDrepId`, populated live from
 * Koios on every call via `lookupCurrentDrep`. THIS is the field
 * frontend should consume for "the DRep my wallet backs."
 *
 * # What we're verifying
 *
 *   - The new field is present when the upstream answered with a real
 *     delegation.
 *   - The new field is `null` when the upstream confirmed the wallet
 *     is undelegated.
 *   - The new field is ABSENT (omitted from JSON) when the upstream
 *     could not be reached — so the frontend doesn't render
 *     "undelegated" wrongly when it's really "unknown".
 *   - The legacy `drepId` field is still present and reflects the JWT
 *     value (registered-DRep id).
 *   - A `lookupCurrentDrep` exception doesn't 500 the handler.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

vi.mock('../../lib/dynamodb', () => ({
  getItem: vi.fn(),
  // Feature 1 (committee invitations) — `/auth/me` runs a GSI Query for
  // pending invites and a batchGet to denormalize committee names onto
  // the response. Stub both; tests that don't care about the invitation
  // surface get empty results (the default mock returns
  // `{ items: [], lastEvaluatedKey: undefined, count: 0 }`).
  queryItems: vi.fn().mockResolvedValue({ items: [], lastEvaluatedKey: undefined, count: 0 }),
  batchGetItems: vi.fn().mockResolvedValue([]),
  tableNames: {
    users: 'test-users',
    drepCommittees: 'test-drep_committees',
    committeeMembership: 'test-committee_membership',
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
  lookupCurrentDrep: vi.fn(),
}));

import { getItem, queryItems, batchGetItems } from '../../lib/dynamodb';
import { lookupCurrentDrep } from '../../lib/recognition';
import { handler } from './me';

const mockGet = vi.mocked(getItem);
const mockQuery = vi.mocked(queryItems);
const mockBatchGet = vi.mocked(batchGetItems);
const mockLookup = vi.mocked(lookupCurrentDrep);

const WALLET = 'stake1uyvjdz9rxsfsmv44rtk75k2rqyqskrga96dgdfrqjvjjpwsefcjnp';
const REGISTERED_DREP = 'drep1registered';
const DELEGATED_DREP = 'drep1delegated';

function buildEvent(opts: {
  walletAddress: string;
  roles: string[];
  drepId?: string;
}): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    requestContext: {
      authorizer: {
        lambda: {
          walletAddress: opts.walletAddress,
          roles: JSON.stringify(opts.roles),
          sessionType: 'normal',
          ...(opts.drepId ? { drepId: opts.drepId } : {}),
        },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer['requestContext'],
    body: null,
    headers: {},
    isBase64Encoded: false,
    rawPath: '',
    rawQueryString: '',
    routeKey: '',
    version: '2.0',
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

function buildUserRow(): unknown {
  return {
    walletAddress: WALLET,
    SK: 'PROFILE',
    displayName: 'Adam',
    roles: ['delegator'],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    sessionTokenHash: 'hash-that-should-not-leak',
    sessionExpiry: '2026-05-08T00:00:00Z',
  };
}

function parseBody(res: APIGatewayProxyResultV2): Record<string, unknown> {
  if (typeof res !== 'object' || res === null) throw new Error('expected object response');
  const r = res as { body?: string };
  if (typeof r.body !== 'string') throw new Error('expected body string');
  const wrapper = JSON.parse(r.body) as Record<string, unknown>;
  return wrapper['data'] as Record<string, unknown>;
}

describe('GET /auth/me', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockLookup.mockReset();
    mockQuery.mockReset();
    mockBatchGet.mockReset();
    // Default: no pending invitations. Tests that need a populated set
    // override mockQuery for that specific case.
    mockQuery.mockResolvedValue({ items: [], lastEvaluatedKey: undefined, count: 0 });
    mockBatchGet.mockResolvedValue([]);
    // `/auth/me` makes TWO getItem calls in parallel: the user row
    // (mockResolvedValueOnce'd per test) and the committee_membership row.
    // Default any UNqueued getItem to "no row" so the membership lookup
    // resolves to undefined (→ committeeMembership: null) unless a test
    // explicitly queues a membership row after the user row.
    mockGet.mockResolvedValue(undefined as never);
  });

  it('includes delegatedToDrepId when the upstream returned a real delegation', async () => {
    mockGet.mockResolvedValueOnce(buildUserRow() as never);
    mockLookup.mockResolvedValueOnce({ drepId: DELEGATED_DREP, source: 'koios' });

    const res = (await handler(
      buildEvent({ walletAddress: WALLET, roles: ['delegator'], drepId: REGISTERED_DREP }),
    )) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 200 });

    const data = parseBody(res);
    // Live delegation surfaced — fix for "wallet's chosen DRep not recognized".
    expect(data['delegatedToDrepId']).toBe(DELEGATED_DREP);
    // Legacy registered-DRep id still surfaced unchanged.
    expect(data['drepId']).toBe(REGISTERED_DREP);
    // Sensitive fields stripped.
    expect(data['sessionTokenHash']).toBeUndefined();
    expect(data['sessionExpiry']).toBeUndefined();
  });

  it('includes delegatedToDrepId=null when upstream confirms the wallet is undelegated', async () => {
    mockGet.mockResolvedValueOnce(buildUserRow() as never);
    mockLookup.mockResolvedValueOnce({ drepId: null, source: 'koios' });

    const res = (await handler(
      buildEvent({ walletAddress: WALLET, roles: ['delegator'] }),
    )) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 200 });

    const data = parseBody(res);
    // null is a CONFIRMED answer (source !== null) — surface it.
    // Frontend reads this as "wallet is not delegated to any DRep" and
    // renders the "browse the directory" CTA.
    expect(data['delegatedToDrepId']).toBeNull();
  });

  it('OMITS delegatedToDrepId when both upstreams failed', async () => {
    // Distinguishing "unknown" from "undelegated" is the whole reason
    // for the source-tag — the frontend reads field-absence as "we
    // don't know yet" and falls back to the stored delegation history.
    mockGet.mockResolvedValueOnce(buildUserRow() as never);
    mockLookup.mockResolvedValueOnce({ drepId: null, source: null });

    const res = (await handler(
      buildEvent({ walletAddress: WALLET, roles: ['delegator'] }),
    )) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 200 });

    const data = parseBody(res);
    expect('delegatedToDrepId' in data).toBe(false);
  });

  it('does NOT 500 when lookupCurrentDrep throws', async () => {
    // Defensive — the lookup is supposed to swallow upstream errors,
    // but if a future revision throws we want `/auth/me` to degrade
    // (omit the field) rather than fail the whole session-revalidation
    // round-trip.
    mockGet.mockResolvedValueOnce(buildUserRow() as never);
    mockLookup.mockRejectedValueOnce(new Error('boom'));

    const res = (await handler(
      buildEvent({ walletAddress: WALLET, roles: ['delegator'] }),
    )) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 200 });

    const data = parseBody(res);
    expect('delegatedToDrepId' in data).toBe(false);
  });

  it('returns 404 when the user row is missing', async () => {
    mockGet.mockResolvedValueOnce(undefined);
    mockLookup.mockResolvedValueOnce({ drepId: null, source: null });

    const res = (await handler(
      buildEvent({ walletAddress: WALLET, roles: ['delegator'] }),
    )) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 404 });
  });

  // ---- Feature 1: pendingInvitations surface ----

  it('always returns pendingInvitations (default: empty array)', async () => {
    mockGet.mockResolvedValueOnce(buildUserRow() as never);
    mockLookup.mockResolvedValueOnce({ drepId: null, source: 'koios' });

    const res = (await handler(
      buildEvent({ walletAddress: WALLET, roles: ['delegator'] }),
    )) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 200 });
    const data = parseBody(res);
    expect(Array.isArray(data['pendingInvitations'])).toBe(true);
    expect((data['pendingInvitations'] as unknown[]).length).toBe(0);
  });

  it('returns pendingInvitations with committee names denormalised in', async () => {
    mockGet.mockResolvedValueOnce(buildUserRow() as never);
    mockLookup.mockResolvedValueOnce({ drepId: null, source: 'koios' });
    // One pending invite from the GSI.
    mockQuery.mockResolvedValueOnce({
      items: [
        {
          drepId: 'drep1abc',
          SK: `INVITE#${WALLET}`,
          inviteeStake: WALLET,
          status: 'pending',
          role: 'committee_member',
          invitedBy: 'stake1chair',
          invitedAt: '2026-01-01T00:00:00Z',
        },
      ],
      lastEvaluatedKey: undefined,
      count: 1,
    });
    // batchGetItems on drep_committees → the COMMITTEE row for that drepId.
    mockBatchGet.mockResolvedValueOnce([
      {
        drepId: 'drep1abc',
        SK: 'COMMITTEE',
        leadWallet: 'stake1chair',
        committeeName: 'Cardano Builders Collective',
        description: 'd',
        members: [],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]);

    const res = (await handler(
      buildEvent({ walletAddress: WALLET, roles: ['delegator'] }),
    )) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 200 });
    const data = parseBody(res);
    const invs = data['pendingInvitations'] as Array<Record<string, unknown>>;
    expect(invs).toHaveLength(1);
    expect(invs[0]).toMatchObject({
      drepId: 'drep1abc',
      committeeName: 'Cardano Builders Collective',
      role: 'committee_member',
    });
  });

  // ---- committeeMembership surface (member-recognition fix) ----

  it('returns committeeMembership for a non-lead member (drepId belongs to the lead)', async () => {
    // The member's user row (call #1) followed by their membership row
    // (call #2, role 'member'), then the committee-name getItem (call #3).
    mockGet
      .mockResolvedValueOnce(buildUserRow() as never) // user PROFILE
      .mockResolvedValueOnce({ walletAddress: WALLET, drepId: 'drep1lead', role: 'member', joinedAt: 't' } as never) // membership
      .mockResolvedValueOnce({ drepId: 'drep1lead', SK: 'COMMITTEE', committeeName: 'Cardano Puppy Committee' } as never); // committee name
    mockLookup.mockResolvedValueOnce({ drepId: null, source: 'koios' });

    const res = (await handler(
      buildEvent({ walletAddress: WALLET, roles: ['delegator'] }),
    )) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 200 });
    const data = parseBody(res);
    expect(data['committeeMembership']).toMatchObject({
      drepId: 'drep1lead',
      role: 'member',
      committeeName: 'Cardano Puppy Committee',
    });
    // A member has no registered drepId of their own.
    expect(data['drepId']).toBeUndefined();
  });

  it('returns committeeMembership: null when the user is in no committee', async () => {
    mockGet.mockResolvedValueOnce(buildUserRow() as never); // user row; membership defaults to undefined
    mockLookup.mockResolvedValueOnce({ drepId: null, source: 'koios' });

    const res = (await handler(
      buildEvent({ walletAddress: WALLET, roles: ['delegator'] }),
    )) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 200 });
    const data = parseBody(res);
    expect(data['committeeMembership']).toBeNull();
  });

  it('excludes a not-yet-accepted (invited) membership from committeeMembership', async () => {
    // role 'invited' is a pending slot — it belongs in pendingInvitations,
    // NOT committeeMembership. No committee-name getItem should fire.
    mockGet
      .mockResolvedValueOnce(buildUserRow() as never)
      .mockResolvedValueOnce({ walletAddress: WALLET, drepId: 'drep1lead', role: 'invited', joinedAt: 't' } as never);
    mockLookup.mockResolvedValueOnce({ drepId: null, source: 'koios' });

    const res = (await handler(
      buildEvent({ walletAddress: WALLET, roles: ['delegator'] }),
    )) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 200 });
    const data = parseBody(res);
    expect(data['committeeMembership']).toBeNull();
  });

  it('does NOT 500 when the pending-invites GSI Query throws', async () => {
    // Defensive: the bell badge / Accept-Reject card is a soft surface;
    // any failure on the secondary read path serves an empty list rather
    // than failing the entire /auth/me round-trip.
    mockGet.mockResolvedValueOnce(buildUserRow() as never);
    mockLookup.mockResolvedValueOnce({ drepId: null, source: 'koios' });
    mockQuery.mockRejectedValueOnce(new Error('GSI down'));

    const res = (await handler(
      buildEvent({ walletAddress: WALLET, roles: ['delegator'] }),
    )) as APIGatewayProxyResultV2;
    expect(res).toMatchObject({ statusCode: 200 });
    const data = parseBody(res);
    expect(data['pendingInvitations']).toEqual([]);
  });
});
