/**
 * Unit tests for POST /me/invitations/decline-all.
 *
 * Covers the explicit "Decline all pending" action — distinct from the
 * `autoDeclineInvites` profile toggle (which only blocks FUTURE invites).
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
    auditLog: 'test-audit_log',
    authNonces: 'test-auth_nonces',
  },
}));

vi.mock('../../lib/audit', () => ({
  writeAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

import { queryItems, transactWrite } from '../../lib/dynamodb';
import { writeAuditEvent } from '../../lib/audit';
import { handler } from './declineAllInvitations';

const mockQuery = vi.mocked(queryItems);
const mockTx = vi.mocked(transactWrite);
const mockAudit = vi.mocked(writeAuditEvent);

const WALLET = 'stake1invitee';

function buildEvent(): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    requestContext: {
      authorizer: {
        lambda: {
          walletAddress: WALLET,
          roles: JSON.stringify(['delegator']),
          sessionType: 'normal',
        },
      },
    },
    body: null,
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

function parseResult(res: APIGatewayProxyResultV2): {
  statusCode: number;
  body: Record<string, unknown>;
} {
  const r = res as { statusCode?: number; body?: string };
  if (typeof r.body !== 'string') throw new Error('expected string body');
  return { statusCode: r.statusCode ?? 0, body: JSON.parse(r.body) as Record<string, unknown> };
}

describe('POST /me/invitations/decline-all', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTx.mockReset();
    mockAudit.mockClear();
  });

  it('rejects every pending invitation for the caller (slots freed)', async () => {
    mockQuery.mockResolvedValueOnce({
      items: [
        { drepId: 'drep1a', SK: `INVITE#${WALLET}`, inviteeStake: WALLET, status: 'pending', role: 'committee_member', invitedBy: 'c', invitedAt: 't' },
        { drepId: 'drep1b', SK: `INVITE#${WALLET}`, inviteeStake: WALLET, status: 'pending', role: 'committee_member', invitedBy: 'c', invitedAt: 't' },
      ],
      lastEvaluatedKey: undefined,
      count: 2,
    });
    mockTx.mockResolvedValue(undefined);

    const res = await handler(buildEvent());
    const { statusCode, body } = parseResult(res);
    expect(statusCode).toBe(200);
    expect((body['data'] as Record<string, unknown>)['rejected']).toBe(2);
    expect((body['data'] as Record<string, unknown>)['skipped']).toBe(0);

    expect(mockTx).toHaveBeenCalledTimes(2);
    // Both invocations carry the same two-item shape: INVITE update + slot Delete.
    for (const call of mockTx.mock.calls) {
      const items = call[0] as Array<Record<string, unknown>>;
      expect(items).toHaveLength(2);
      const inviteUpdate = items[0] as { Update: { UpdateExpression: string } };
      expect(inviteUpdate.Update.UpdateExpression).toContain(':rejected');
      const slotDelete = items[1] as { Delete?: { TableName: string } };
      expect(slotDelete.Delete?.TableName).toBe('test-committee_membership');
    }
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'committee.invitations.declined_all' }),
    );
  });

  it('returns rejected=0, skipped=0 when there are no pending invitations', async () => {
    mockQuery.mockResolvedValueOnce({ items: [], lastEvaluatedKey: undefined, count: 0 });

    const res = await handler(buildEvent());
    const { statusCode, body } = parseResult(res);
    expect(statusCode).toBe(200);
    expect((body['data'] as Record<string, unknown>)['rejected']).toBe(0);
    expect((body['data'] as Record<string, unknown>)['skipped']).toBe(0);
    expect(mockTx).not.toHaveBeenCalled();
    // No audit row for the noop case — keeps the audit log uncluttered.
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('skips invites whose state drifted between Query and tx (best-effort per row)', async () => {
    mockQuery.mockResolvedValueOnce({
      items: [
        { drepId: 'drep1a', SK: `INVITE#${WALLET}`, inviteeStake: WALLET, status: 'pending', role: 'committee_member', invitedBy: 'c', invitedAt: 't' },
        { drepId: 'drep1b', SK: `INVITE#${WALLET}`, inviteeStake: WALLET, status: 'pending', role: 'committee_member', invitedBy: 'c', invitedAt: 't' },
      ],
      lastEvaluatedKey: undefined,
      count: 2,
    });
    // First tx succeeds, second fails with the DDB-cancelled marker.
    mockTx.mockResolvedValueOnce(undefined);
    const cancelledError = Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
    });
    mockTx.mockRejectedValueOnce(cancelledError);

    const res = await handler(buildEvent());
    const { statusCode, body } = parseResult(res);
    expect(statusCode).toBe(200);
    expect((body['data'] as Record<string, unknown>)['rejected']).toBe(1);
    expect((body['data'] as Record<string, unknown>)['skipped']).toBe(1);
  });
});
