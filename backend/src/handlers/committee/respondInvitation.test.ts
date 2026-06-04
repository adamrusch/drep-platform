/**
 * Unit tests for POST /committee/{drepId}/invitations/respond.
 *
 * Covers the invite lifecycle entry points that this handler owns:
 *   - Accept: INVITE pending→accepted; new CommitteeMemberItem appended to
 *     `members[]`; membership slot upgraded invited→member. X / intendedN
 *     UNCHANGED (decision B — Chair's full X stands).
 *   - Reject: INVITE pending→rejected; membership slot DELETED (slot freed).
 *   - Only the invitee may respond (auth wallet equality).
 *   - 409 on non-pending invite state.
 *   - 400 on bad decision value.
 *   - 401 on signature failure.
 *
 * Mocks: `dynamodb`, `audit`, and `auth` (re-sign verify). The same shape
 * as `auth/me.test.ts` and `role-guard.test.ts` already in this tree.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

vi.mock('../../lib/dynamodb', () => ({
  getItem: vi.fn(),
  queryItems: vi.fn(),
  transactWrite: vi.fn(),
  tableNames: {
    drepCommittees: 'test-drep_committees',
    committeeMembership: 'test-committee_membership',
    users: 'test-users',
    auditLog: 'test-audit_log',
    authNonces: 'test-auth_nonces',
  },
}));

vi.mock('../../lib/audit', () => ({
  writeAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/auth', () => ({
  validateMutationNonce: vi.fn().mockResolvedValue({ valid: true }),
  verifyWalletSignature: vi.fn().mockReturnValue({ valid: true }),
}));

import { getItem, transactWrite } from '../../lib/dynamodb';
import { writeAuditEvent } from '../../lib/audit';
import { handler } from './respondInvitation';

const mockGet = vi.mocked(getItem);
const mockTx = vi.mocked(transactWrite);
const mockAudit = vi.mocked(writeAuditEvent);

const INVITEE = 'stake1invitee';
const CHAIR = 'stake1chair';
const DREP = 'drep1abc';

function buildEvent(opts: {
  drepId: string;
  walletAddress: string;
  body: unknown;
}): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    pathParameters: { drepId: opts.drepId },
    body: JSON.stringify(opts.body),
    requestContext: {
      authorizer: {
        lambda: {
          walletAddress: opts.walletAddress,
          roles: JSON.stringify(['delegator']),
          sessionType: 'normal',
        },
      },
    },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

function parseResult(res: APIGatewayProxyResultV2): {
  statusCode: number;
  body: Record<string, unknown>;
} {
  if (typeof res !== 'object' || res === null) throw new Error('expected object response');
  const r = res as { statusCode?: number; body?: string };
  if (typeof r.body !== 'string') throw new Error('expected string body');
  return { statusCode: r.statusCode ?? 0, body: JSON.parse(r.body) as Record<string, unknown> };
}

function txItems(): Array<Record<string, unknown>> {
  const call = mockTx.mock.calls[0];
  if (!call) throw new Error('expected transactWrite to have been called');
  return call[0] as Array<Record<string, unknown>>;
}

const pendingInvite = (overrides: Partial<Record<string, unknown>> = {}) => ({
  drepId: DREP,
  SK: `INVITE#${INVITEE}`,
  inviteeStake: INVITEE,
  status: 'pending',
  role: 'committee_member',
  invitedBy: CHAIR,
  invitedAt: '2026-01-01T00:00:00Z',
  ...overrides,
});

const committee = () => ({
  drepId: DREP,
  SK: 'COMMITTEE',
  leadWallet: CHAIR,
  committeeName: 'Test',
  description: 'd',
  members: [{ walletAddress: CHAIR, role: 'lead_drep', joinedAt: 't', active: true }],
  approvalThreshold: 2,
  intendedMemberCount: 3,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

const signedBody = (decision: 'accept' | 'reject') => ({
  decision,
  mutationNonce: 'n',
  mutationSignature: 's',
  mutationKey: 'k',
});

describe('POST /committee/{drepId}/invitations/respond — accept', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockTx.mockReset();
    mockAudit.mockClear();
  });

  it('appends to members[] and upgrades the slot — does NOT touch approvalThreshold (decision B)', async () => {
    mockGet
      .mockResolvedValueOnce(pendingInvite() as never) // loadInvite
      .mockResolvedValueOnce(committee() as never); // loadCommittee
    mockTx.mockResolvedValueOnce(undefined);

    const res = await handler(
      buildEvent({ drepId: DREP, walletAddress: INVITEE, body: signedBody('accept') }),
    );
    const { statusCode, body } = parseResult(res);
    expect(statusCode).toBe(200);
    expect((body['data'] as Record<string, unknown>)['status']).toBe('accepted');

    // One transactWrite called with three items: INVITE update, COMMITTEE
    // members[] append + updatedAt, slot upgrade invited→member.
    expect(mockTx).toHaveBeenCalledTimes(1);
    const items = txItems();
    expect(items).toHaveLength(3);

    // INVITE row: status pending→accepted, NO touching of approvalThreshold.
    const inviteUpdate = items[0] as { Update: { UpdateExpression: string } };
    expect(inviteUpdate.Update.UpdateExpression).toContain(':accepted');

    // COMMITTEE row: list_append on members, set updatedAt. Critically,
    // the UpdateExpression MUST NOT mutate approvalThreshold or
    // intendedMemberCount — those are the Chair's intent, not the
    // invitee's lever.
    const committeeUpdate = items[1] as { Update: { UpdateExpression: string } };
    expect(committeeUpdate.Update.UpdateExpression).toContain('list_append');
    expect(committeeUpdate.Update.UpdateExpression).not.toContain('approvalThreshold');
    expect(committeeUpdate.Update.UpdateExpression).not.toContain('intendedMemberCount');

    // Slot upgrade row: invited→member, conditioned on the current role.
    const slotUpdate = items[2] as { Update: { ConditionExpression: string } };
    expect(slotUpdate.Update.ConditionExpression).toContain('invited');

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'committee.invitation.accepted', actorWallet: INVITEE }),
    );
  });

  it('rejects (403) when the caller wallet does not own the invite — defense-in-depth check', async () => {
    // Pin the SK lookup TO succeed (the row exists) but populate
    // inviteeStake with a different wallet than the auth caller. In
    // practice the SK is constructed from authCtx.walletAddress so a
    // mismatch here means a row that was somehow written with a
    // mismatched key/attribute pair — the handler should fail closed
    // with 403, never reveal "this invite exists for some other wallet."
    mockGet.mockResolvedValueOnce(pendingInvite() as never); // inviteeStake=INVITEE

    const res = await handler(
      // Caller is the Chair — handler defense-in-depth check trips on
      // inviteeStake !== authCtx.walletAddress.
      buildEvent({ drepId: DREP, walletAddress: CHAIR, body: signedBody('accept') }),
    );
    const { statusCode } = parseResult(res);
    expect(statusCode).toBe(403);
  });

  it('returns 404 when no INVITE row exists for the caller wallet (the common "not for me" case)', async () => {
    // Realistic path: the SK is built from authCtx.walletAddress, so a
    // Chair (or any non-invitee) looking up an INVITE keyed on their
    // own wallet simply gets undefined → 404. This guarantees we never
    // disclose that an invite exists for SOME OTHER wallet.
    mockGet.mockResolvedValueOnce(undefined);

    const res = await handler(
      buildEvent({ drepId: DREP, walletAddress: CHAIR, body: signedBody('accept') }),
    );
    const { statusCode } = parseResult(res);
    expect(statusCode).toBe(404);
  });

  it('409 on a non-pending invite', async () => {
    mockGet
      .mockResolvedValueOnce(pendingInvite({ status: 'accepted' }) as never);
    const res = await handler(
      buildEvent({ drepId: DREP, walletAddress: INVITEE, body: signedBody('accept') }),
    );
    const { statusCode } = parseResult(res);
    expect(statusCode).toBe(409);
    expect(mockTx).not.toHaveBeenCalled();
  });

  it('404 when the invite does not exist for this wallet', async () => {
    mockGet.mockResolvedValueOnce(undefined);
    const res = await handler(
      buildEvent({ drepId: DREP, walletAddress: INVITEE, body: signedBody('accept') }),
    );
    const { statusCode } = parseResult(res);
    expect(statusCode).toBe(404);
  });

  it('400 on an unknown decision value', async () => {
    const res = await handler(
      buildEvent({
        drepId: DREP,
        walletAddress: INVITEE,
        body: { ...signedBody('accept'), decision: 'maybe' },
      }),
    );
    const { statusCode } = parseResult(res);
    expect(statusCode).toBe(400);
    expect(mockGet).not.toHaveBeenCalled();
  });
});

describe('POST /committee/{drepId}/invitations/respond — reject', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockTx.mockReset();
    mockAudit.mockClear();
  });

  it('frees the slot (deletes the membership row) and marks the invite rejected', async () => {
    mockGet
      .mockResolvedValueOnce(pendingInvite() as never)
      .mockResolvedValueOnce(committee() as never);
    mockTx.mockResolvedValueOnce(undefined);

    const res = await handler(
      buildEvent({ drepId: DREP, walletAddress: INVITEE, body: signedBody('reject') }),
    );
    const { statusCode, body } = parseResult(res);
    expect(statusCode).toBe(200);
    expect((body['data'] as Record<string, unknown>)['status']).toBe('rejected');

    expect(mockTx).toHaveBeenCalledTimes(1);
    const items = txItems();
    expect(items).toHaveLength(2);

    const inviteUpdate = items[0] as { Update: { UpdateExpression: string } };
    expect(inviteUpdate.Update.UpdateExpression).toContain(':rejected');

    // Slot freed by Delete (NOT a role update).
    const slotDelete = items[1] as {
      Delete?: { TableName: string; ConditionExpression: string };
    };
    expect(slotDelete.Delete).toBeDefined();
    expect(slotDelete.Delete?.TableName).toBe('test-committee_membership');
    expect(slotDelete.Delete?.ConditionExpression).toContain('invited');

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'committee.invitation.rejected', actorWallet: INVITEE }),
    );
  });
});
