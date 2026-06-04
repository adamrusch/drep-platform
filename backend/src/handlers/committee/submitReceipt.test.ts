/**
 * Unit tests for submitReceipt's stage-aware gate (Feature 3).
 *
 * Scope: confirms the wall layer + the safety-acknowledgement requirement
 * — NOT the full mainnet write path (which depends on a real wallet/tx
 * and is covered by the design-doc manual-test checklist, not unit tests).
 *
 * What's exercised here:
 *   - test + non-admin lead → 403 (canBroadcastGovernanceVote=false)
 *   - test + admin without `confirmedRealMainnetVote=true` → 400
 *   - test + admin with `confirmedRealMainnetVote=true` → 200 (full happy path)
 *   - prod + lead → 200 (unchanged; `confirmedRealMainnetVote` not required)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

vi.mock('../../lib/dynamodb', () => ({
  getItem: vi.fn(),
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

import { getItem, putItem } from '../../lib/dynamodb';
import { writeAuditEvent } from '../../lib/audit';
import { handler } from './submitReceipt';

const mockGet = vi.mocked(getItem);
const mockPut = vi.mocked(putItem);
const mockAudit = vi.mocked(writeAuditEvent);

const CHAIR = 'stake1chair';
const ADMIN = 'stake1admin';
const DREP = 'drep1abc';
const ACTION = 'tx0000000000000000000000000000000000000000000000000000000000000000#0';
const TX = 'a'.repeat(64);

function buildEvent(
  opts: {
    walletAddress: string;
    roles?: string[];
    confirmedRealMainnetVote?: boolean | undefined;
  },
): APIGatewayProxyEventV2WithJWTAuthorizer {
  const body: Record<string, unknown> = {
    txHash: TX,
    mutationNonce: 'n',
    mutationSignature: 's',
    mutationKey: 'k',
  };
  if (opts.confirmedRealMainnetVote !== undefined) {
    body['confirmedRealMainnetVote'] = opts.confirmedRealMainnetVote;
  }
  return {
    pathParameters: { drepId: DREP, actionId: encodeURIComponent(ACTION) },
    body: JSON.stringify(body),
    requestContext: {
      authorizer: {
        lambda: {
          walletAddress: opts.walletAddress,
          roles: JSON.stringify(opts.roles ?? ['lead_drep']),
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

const committee = () => ({
  drepId: DREP,
  SK: 'COMMITTEE',
  leadWallet: CHAIR,
  committeeName: 'Test',
  description: 'd',
  members: [{ walletAddress: CHAIR, role: 'lead_drep', joinedAt: 't', active: true }],
  approvalThreshold: 1,
  intendedMemberCount: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

const passedProposal = () => ({
  voteScope: `${DREP}#${ACTION}`,
  itemKey: 'PROPOSAL',
  drepId: DREP,
  actionId: ACTION,
  proposerWallet: CHAIR,
  proposedPosition: 'Yes',
  approvalThreshold: 1,
  memberCount: 1,
  status: 'passed',
  openedAt: '2026-01-01T00:00:00Z',
});

const finalRationale = () => ({
  voteScope: `${DREP}#${ACTION}`,
  itemKey: 'RATIONALE#FINAL',
  ipfsUri: 'ipfs://QmAbc',
  anchorHash: 'b'.repeat(64),
  canonicalJson: '{}',
});

beforeEach(() => {
  mockGet.mockReset();
  mockPut.mockReset();
  mockAudit.mockReset();
  delete process.env['STAGE'];
  delete process.env['ADMIN_BOOTSTRAP_WALLETS'];
});

describe('POST /committee/{drepId}/votes/{actionId}/submit/receipt — stage + safety gate', () => {
  it('test + non-admin lead → 403 (not the chair-of-committee bar — the platform-admin bar)', async () => {
    process.env['STAGE'] = 'test';
    // The non-admin lead would normally pass `assertCommitteeLead`, but
    // `canBroadcastGovernanceVote` rejects them before we even look up the
    // committee. So no Dynamo reads should happen.
    const res = await handler(
      buildEvent({ walletAddress: CHAIR, roles: ['lead_drep'], confirmedRealMainnetVote: true }),
    );
    const { statusCode, body } = parseResult(res);
    expect(statusCode).toBe(403);
    expect(String(body['message'])).toMatch(/platform admins/i);
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('test + admin without confirmedRealMainnetVote → 400', async () => {
    process.env['STAGE'] = 'test';
    process.env['ADMIN_BOOTSTRAP_WALLETS'] = ADMIN;
    const res = await handler(
      buildEvent({ walletAddress: ADMIN, roles: ['lead_drep'] /* no confirm */ }),
    );
    const { statusCode, body } = parseResult(res);
    expect(statusCode).toBe(400);
    expect(String(body['message'])).toMatch(/confirmedRealMainnetVote/);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('test + admin with confirmedRealMainnetVote=false → 400 (must be the boolean literal true)', async () => {
    process.env['STAGE'] = 'test';
    process.env['ADMIN_BOOTSTRAP_WALLETS'] = ADMIN;
    const res = await handler(
      buildEvent({ walletAddress: ADMIN, roles: ['lead_drep'], confirmedRealMainnetVote: false }),
    );
    const { statusCode } = parseResult(res);
    expect(statusCode).toBe(400);
  });

  it('test + admin with confirmedRealMainnetVote=true → 200 (writes audit-event row flagged realMainnetVoteOnTest)', async () => {
    process.env['STAGE'] = 'test';
    process.env['ADMIN_BOOTSTRAP_WALLETS'] = ADMIN;
    // Admin happens to ALSO be the committee lead — the test ignores
    // committee-lead semantics by making the lead the admin.
    mockGet
      .mockResolvedValueOnce({ ...committee(), leadWallet: ADMIN, members: [{ walletAddress: ADMIN, role: 'lead_drep', joinedAt: 't', active: true }] } as never) // loadCommittee
      .mockResolvedValueOnce(passedProposal() as never) // loadProposal
      .mockResolvedValueOnce(finalRationale() as never); // loadRationaleFinal
    mockPut.mockResolvedValueOnce(undefined);
    const res = await handler(
      buildEvent({ walletAddress: ADMIN, roles: [], confirmedRealMainnetVote: true }),
    );
    const { statusCode } = parseResult(res);
    expect(statusCode).toBe(200);
    expect(mockPut).toHaveBeenCalledTimes(1);
    // Pre-write safety audit + post-write submitted audit
    const eventTypes = mockAudit.mock.calls.map((c) => (c[0] as { eventType: string }).eventType);
    expect(eventTypes).toContain('committee.vote.realMainnetVoteOnTest');
    expect(eventTypes).toContain('committee.vote.submitted');
    // SUBMISSION row should record broadcastStage='test' (provenance), not
    // be silently rewritten to 'prod'.
    const written = mockPut.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(written?.['broadcastStage']).toBe('test');
  });

  it('prod + lead → 200 even when confirmedRealMainnetVote is omitted (prod IS production by design)', async () => {
    process.env['STAGE'] = 'prod';
    mockGet
      .mockResolvedValueOnce(committee() as never) // loadCommittee
      .mockResolvedValueOnce(passedProposal() as never) // loadProposal
      .mockResolvedValueOnce(finalRationale() as never); // loadRationaleFinal
    mockPut.mockResolvedValueOnce(undefined);
    const res = await handler(
      buildEvent({ walletAddress: CHAIR, roles: ['lead_drep'] /* no confirm field */ }),
    );
    const { statusCode } = parseResult(res);
    expect(statusCode).toBe(200);
    expect(mockPut).toHaveBeenCalledTimes(1);
    const written = mockPut.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(written?.['broadcastStage']).toBe('prod');
  });

  it('dev → 403 (neither prod nor a platform-admin-gated test)', async () => {
    process.env['STAGE'] = 'dev';
    const res = await handler(
      buildEvent({ walletAddress: ADMIN, roles: ['platform_admin'], confirmedRealMainnetVote: true }),
    );
    const { statusCode } = parseResult(res);
    expect(statusCode).toBe(403);
  });
});
