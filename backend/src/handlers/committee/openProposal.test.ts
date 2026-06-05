/**
 * Unit test for the open-proposal accepted-count guard (Feature 1).
 *
 * Decision B — "Chair's full X stands": opening a proposal requires the
 * number of ACCEPTED members to be at least X. Pending invitations don't
 * count — the eligible-voter set is frozen at open, so reaching X agrees
 * must be feasible against members.length alone.
 *
 * This test exercises ONLY the new guard. The rest of the open-proposal flow
 * (action lookup, snapshot freeze) is covered by the existing
 * committeeVoteResolver / proposal-lifecycle tests in this tree — we don't
 * re-test those here.
 *
 * As of 2026-06 opening a proposal takes NO wallet signature (JWT +
 * membership only), so this test sends a bare {actionId, proposedPosition}
 * body.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

vi.mock('../../lib/dynamodb', () => ({
  getItem: vi.fn(),
  queryItems: vi.fn(),
  putItem: vi.fn(),
  tableNames: {
    drepCommittees: 'test-drep_committees',
    committeeVotes: 'test-committee_votes',
    governanceActions: 'test-governance_actions',
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

vi.mock('../../lib/koios', () => ({
  getCurrentEpochInfo: vi.fn().mockResolvedValue({ epoch_no: 500 }),
}));

import { getItem, putItem } from '../../lib/dynamodb';
import { handler } from './openProposal';

const mockGet = vi.mocked(getItem);
const mockPut = vi.mocked(putItem);

const CHAIR = 'stake1chair';
const DREP = 'drep1abc';
const ACTION = 'tx123#0';

function buildEvent(walletAddress: string): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    pathParameters: { drepId: DREP },
    body: JSON.stringify({
      actionId: ACTION,
      proposedPosition: 'Yes',
    }),
    requestContext: {
      authorizer: {
        lambda: {
          walletAddress,
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
  const r = res as { statusCode?: number; body?: string };
  if (typeof r.body !== 'string') throw new Error('expected string body');
  return { statusCode: r.statusCode ?? 0, body: JSON.parse(r.body) as Record<string, unknown> };
}

const committee = (membersLen: number, approvalThreshold: number) => ({
  drepId: DREP,
  SK: 'COMMITTEE',
  leadWallet: CHAIR,
  committeeName: 'Test',
  description: 'd',
  members: Array.from({ length: membersLen }, (_, i) => ({
    walletAddress: i === 0 ? CHAIR : `stake1m${i}`,
    role: i === 0 ? 'lead_drep' : 'committee_member',
    joinedAt: 't',
    active: true,
  })),
  approvalThreshold,
  intendedMemberCount: 5,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

const action = () => ({
  actionId: ACTION,
  SK: 'ACTION',
  actionType: 'InfoAction',
  description: 'd',
  submittedAt: '2026-01-01T00:00:00Z',
  epochDeadline: 600,
  status: 'active',
});

describe('POST /committee/{drepId}/votes — accepted-count guard (decision B)', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPut.mockReset();
  });

  it('REJECTS opening a proposal when members.length < approvalThreshold', async () => {
    // X = 3, but only 2 accepted members (the rest are pending invites that
    // wouldn't surface here — `members[]` only ever contains accepted rows).
    mockGet.mockResolvedValueOnce(committee(2, 3) as never);

    const res = await handler(buildEvent(CHAIR));
    const { statusCode, body } = parseResult(res);
    expect(statusCode).toBe(400);
    expect(String(body['message'])).toContain('Not enough members have accepted yet');
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('PERMITS opening when members.length >= approvalThreshold (X reachable against the frozen set)', async () => {
    mockGet
      .mockResolvedValueOnce(committee(3, 3) as never) // loadCommittee
      .mockResolvedValueOnce(action() as never) // loadGovernanceAction
      .mockResolvedValueOnce(undefined); // loadProposal (no existing)
    mockPut.mockResolvedValueOnce(undefined);

    const res = await handler(buildEvent(CHAIR));
    const { statusCode } = parseResult(res);
    expect(statusCode).toBe(201);
    expect(mockPut).toHaveBeenCalledTimes(1);
  });
});
