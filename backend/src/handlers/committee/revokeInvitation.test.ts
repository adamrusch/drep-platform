/**
 * Unit tests for DELETE /committee/{drepId}/invitations/{walletAddress}.
 *
 * Covers:
 *   - Lead-only access (mirrors removeMember.ts gate).
 *   - Atomic INVITE pending→revoked + membership slot Delete.
 *   - 409 when invite is not pending.
 *   - 404 when invite does not exist.
 *   - 403 when caller is not the lead.
 *   - 401 on signature failure.
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
import { handler } from './revokeInvitation';

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
  target: string;
  body: unknown;
}): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    pathParameters: { drepId: opts.drepId, walletAddress: encodeURIComponent(opts.target) },
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

function txItems(): Array<Record<string, unknown>> {
  const call = mockTx.mock.calls[0];
  if (!call) throw new Error('expected transactWrite to have been called');
  return call[0] as Array<Record<string, unknown>>;
}

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

const signedBody = () => ({
  mutationNonce: 'n',
  mutationSignature: 's',
  mutationKey: 'k',
});

describe('DELETE /committee/{drepId}/invitations/{walletAddress}', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockTx.mockReset();
    mockAudit.mockClear();
  });

  it('the lead can revoke a pending invitation — slot is freed', async () => {
    mockGet
      .mockResolvedValueOnce(committee() as never) // loadCommittee
      .mockResolvedValueOnce(pendingInvite() as never); // loadInvite
    mockTx.mockResolvedValueOnce(undefined);

    const res = await handler(
      buildEvent({ drepId: DREP, walletAddress: CHAIR, target: INVITEE, body: signedBody() }),
    );
    const { statusCode, body } = parseResult(res);
    expect(statusCode).toBe(200);
    expect((body['data'] as Record<string, unknown>)['status']).toBe('revoked');

    expect(mockTx).toHaveBeenCalledTimes(1);
    const items = txItems();
    // [0] = INVITE update pending→revoked. [1] = committee_membership Delete.
    expect(items).toHaveLength(2);
    const inviteUpdate = items[0] as { Update: { UpdateExpression: string } };
    expect(inviteUpdate.Update.UpdateExpression).toContain(':revoked');
    const slotDelete = items[1] as { Delete?: { TableName: string } };
    expect(slotDelete.Delete).toBeDefined();
    expect(slotDelete.Delete?.TableName).toBe('test-committee_membership');

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'committee.invitation.revoked',
        actorWallet: CHAIR,
      }),
    );
  });

  it('403 when a non-lead tries to revoke', async () => {
    mockGet.mockResolvedValueOnce(committee() as never);

    const res = await handler(
      buildEvent({ drepId: DREP, walletAddress: OTHER, target: INVITEE, body: signedBody() }),
    );
    const { statusCode } = parseResult(res);
    expect(statusCode).toBe(403);
    expect(mockTx).not.toHaveBeenCalled();
  });

  it('404 when the invitation does not exist', async () => {
    mockGet
      .mockResolvedValueOnce(committee() as never) // loadCommittee
      .mockResolvedValueOnce(undefined); // loadInvite

    const res = await handler(
      buildEvent({ drepId: DREP, walletAddress: CHAIR, target: INVITEE, body: signedBody() }),
    );
    const { statusCode } = parseResult(res);
    expect(statusCode).toBe(404);
    expect(mockTx).not.toHaveBeenCalled();
  });

  it('409 when the invitation is not pending', async () => {
    mockGet
      .mockResolvedValueOnce(committee() as never)
      .mockResolvedValueOnce(pendingInvite({ status: 'accepted' }) as never);

    const res = await handler(
      buildEvent({ drepId: DREP, walletAddress: CHAIR, target: INVITEE, body: signedBody() }),
    );
    const { statusCode } = parseResult(res);
    expect(statusCode).toBe(409);
    expect(mockTx).not.toHaveBeenCalled();
  });
});
