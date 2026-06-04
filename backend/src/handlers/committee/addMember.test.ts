/**
 * Unit tests for POST /committee/{drepId}/members — the new invitation-issuing
 * path (Feature 1). Critical behaviours covered:
 *
 *   - The handler issues a pending INVITE row (no longer instant append to
 *     members[]) AND claims the wallet's slot with role='invited'.
 *   - autoDeclineInvites=true on the invitee's user row → INVITE row is
 *     written with status='rejected' and the slot is NOT claimed.
 *   - X is restated against the new INTENDED N (chair + every invited
 *     address, regardless of accept status).
 *   - 409 when an INVITE already exists for that wallet on this committee.
 *   - 409 when the wallet is already in members[] (accepted).
 *   - 403 when caller is not the lead.
 *   - The legacy "instantly append to members[]" path is GONE — the
 *     transaction MUST NOT mutate the COMMITTEE row's `members` attribute.
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

vi.mock('../../lib/cardanoAddress', () => ({
  normalizeToStakeAddress: vi.fn((addr: string) => addr),
}));

import { getItem, transactWrite } from '../../lib/dynamodb';
import { writeAuditEvent } from '../../lib/audit';
import { handler } from './addMember';

const mockGet = vi.mocked(getItem);
const mockTx = vi.mocked(transactWrite);
const mockAudit = vi.mocked(writeAuditEvent);

const CHAIR = 'stake1chair';
const OTHER = 'stake1other';
const INVITEE = 'stake1invitee';
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
          roles: JSON.stringify(['lead_drep']),
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

/** Pull the first `transactWrite` call's items array, asserting it exists.
 *  Vitest's mock.calls[0] is typed as possibly-undefined under `strict +
 *  noUncheckedIndexedAccess`; this narrows it for the test assertions. */
function txItems(): Array<Record<string, unknown>> {
  const call = mockTx.mock.calls[0];
  if (!call) throw new Error('expected transactWrite to have been called');
  return call[0] as Array<Record<string, unknown>>;
}

const committee = (overrides: Partial<Record<string, unknown>> = {}) => ({
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
  ...overrides,
});

const baseBody = (overrides: Partial<Record<string, unknown>> = {}) => ({
  walletAddress: INVITEE,
  approvalThreshold: 2,
  mutationNonce: 'n',
  mutationSignature: 's',
  mutationKey: 'k',
  ...overrides,
});

describe('POST /committee/{drepId}/members — issue invitation', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockTx.mockReset();
    mockAudit.mockClear();
  });

  it('writes a pending INVITE row and claims the invited slot — does NOT mutate members[]', async () => {
    mockGet
      .mockResolvedValueOnce(committee() as never) // loadCommittee
      .mockResolvedValueOnce(undefined) // loadInvite (no existing)
      .mockResolvedValueOnce(undefined); // users row lookup (not autoDecline)
    mockTx.mockResolvedValueOnce(undefined);

    const res = await handler(
      buildEvent({ drepId: DREP, walletAddress: CHAIR, body: baseBody({ approvalThreshold: 3 }) }),
    );
    const { statusCode, body } = parseResult(res);
    expect(statusCode).toBe(201);
    // Returned shape is the INVITE row, not a CommitteeMemberItem.
    expect((body['data'] as Record<string, unknown>)['status']).toBe('pending');

    const items = txItems();
    // [0] = INVITE Put, [1] = COMMITTEE Update (X + intendedN + updatedAt),
    // [2] = membership slot Put with role='invited'.
    expect(items).toHaveLength(3);

    const inviteWrite = items[0] as {
      Put: { TableName: string; Item: Record<string, unknown> };
    };
    expect(inviteWrite.Put.TableName).toBe('test-drep_committees');
    expect(inviteWrite.Put.Item['status']).toBe('pending');
    expect(inviteWrite.Put.Item['SK']).toBe(`INVITE#${INVITEE}`);

    const committeeUpdate = items[1] as { Update: { UpdateExpression: string } };
    expect(committeeUpdate.Update.UpdateExpression).toContain('approvalThreshold');
    expect(committeeUpdate.Update.UpdateExpression).toContain('intendedMemberCount');
    // CRITICAL: must NOT instantly append a member.
    expect(committeeUpdate.Update.UpdateExpression).not.toContain('list_append');
    expect(committeeUpdate.Update.UpdateExpression).not.toContain('members');

    const slotPut = items[2] as { Put: { TableName: string; Item: Record<string, unknown> } };
    expect(slotPut.Put.TableName).toBe('test-committee_membership');
    expect(slotPut.Put.Item['role']).toBe('invited');

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'committee.member.invited' }),
    );
  });

  it('honors autoDeclineInvites — writes status="rejected" INVITE and does NOT claim a slot', async () => {
    mockGet
      .mockResolvedValueOnce(committee() as never)
      .mockResolvedValueOnce(undefined) // no existing invite
      .mockResolvedValueOnce({ // users row with autoDecline
        walletAddress: INVITEE,
        SK: 'PROFILE',
        autoDeclineInvites: true,
      } as never);
    mockTx.mockResolvedValueOnce(undefined);

    const res = await handler(
      buildEvent({ drepId: DREP, walletAddress: CHAIR, body: baseBody({ approvalThreshold: 3 }) }),
    );
    const { statusCode, body } = parseResult(res);
    expect(statusCode).toBe(201);
    expect((body['data'] as Record<string, unknown>)['status']).toBe('rejected');

    const items = txItems();
    // Two items: INVITE (with status='rejected') + COMMITTEE Update. NO
    // slot Put — the wallet's membership slot stays free.
    expect(items).toHaveLength(2);
    const inviteWrite = items[0] as { Put: { Item: Record<string, unknown> } };
    expect(inviteWrite.Put.Item['status']).toBe('rejected');
    // No committee_membership row in the tx.
    for (const it of items) {
      const put = (it as { Put?: { TableName?: string } }).Put;
      if (put) expect(put.TableName).not.toBe('test-committee_membership');
    }
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'committee.member.invited',
        metadata: expect.objectContaining({ status: 'rejected', autoDeclined: true }),
      }),
    );
  });

  it('409 when an INVITE already exists for that wallet (any status)', async () => {
    mockGet
      .mockResolvedValueOnce(committee() as never)
      .mockResolvedValueOnce({
        drepId: DREP,
        SK: `INVITE#${INVITEE}`,
        inviteeStake: INVITEE,
        status: 'pending',
        role: 'committee_member',
        invitedBy: CHAIR,
        invitedAt: 't',
      } as never);

    const res = await handler(
      buildEvent({ drepId: DREP, walletAddress: CHAIR, body: baseBody({ approvalThreshold: 3 }) }),
    );
    const { statusCode } = parseResult(res);
    expect(statusCode).toBe(409);
    expect(mockTx).not.toHaveBeenCalled();
  });

  it('409 when the wallet is already an accepted member', async () => {
    const c = committee({
      members: [
        { walletAddress: CHAIR, role: 'lead_drep', joinedAt: 't', active: true },
        { walletAddress: INVITEE, role: 'committee_member', joinedAt: 't', active: true },
      ],
    });
    mockGet.mockResolvedValueOnce(c as never);

    const res = await handler(
      buildEvent({ drepId: DREP, walletAddress: CHAIR, body: baseBody({ approvalThreshold: 3 }) }),
    );
    const { statusCode } = parseResult(res);
    expect(statusCode).toBe(409);
    expect(mockTx).not.toHaveBeenCalled();
  });

  it('403 when the caller is not the committee lead', async () => {
    mockGet.mockResolvedValueOnce(committee() as never);
    const res = await handler(
      buildEvent({ drepId: DREP, walletAddress: OTHER, body: baseBody({ approvalThreshold: 3 }) }),
    );
    const { statusCode } = parseResult(res);
    expect(statusCode).toBe(403);
    expect(mockTx).not.toHaveBeenCalled();
  });

  it('400 when X is out of range for the new intended N', async () => {
    // loadCommittee → check accepted members → loadInvite → X validation.
    // The X check fires BEFORE the autoDecline lookup, so only two getItem
    // calls are expected.
    mockGet
      .mockResolvedValueOnce(committee() as never)
      .mockResolvedValueOnce(undefined);

    // New intended N = 3 + 1 = 4. X=5 is invalid.
    const res = await handler(
      buildEvent({ drepId: DREP, walletAddress: CHAIR, body: baseBody({ approvalThreshold: 5 }) }),
    );
    const { statusCode } = parseResult(res);
    expect(statusCode).toBe(400);
    expect(mockTx).not.toHaveBeenCalled();
  });
});
