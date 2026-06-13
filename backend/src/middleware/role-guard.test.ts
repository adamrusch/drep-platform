/**
 * Regression tests for `extractAuthContext` — specifically the
 * 2026-05-27 rename of the authorizer-context field
 * `drepId` → `registeredDrepId` and the legacy-fallback shim.
 *
 * # Why a fallback exists
 *
 * The JWT authorizer Lambda and the downstream handler Lambdas
 * redeploy independently. During the rollout window the authorizer
 * may still emit the old `drepId` field while a handler has already
 * been redeployed to read `registeredDrepId`. The legacy fallback
 * accepts either field shape and prefers the new one. It can be
 * removed after 2026-06-03 (one normal-session JWT TTL past the
 * rename's rollout); by then the authorizer Lambda is also guaranteed
 * to emit only the new shape.
 */

import { describe, it, expect } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import type { CommitteeMemberItem } from '../lib/types';
import {
  extractAuthContext,
  requireOwner,
  requireOwnerOrCommitteeLead,
  AuthorizationError,
} from './role-guard';

const WALLET = 'stake1uyvjdz9rxsfsmv44rtk75k2rqyqskrga96dgdfrqjvjjpwsefcjnp';
const NEW_DREP = 'drep1newfield';
const LEGACY_DREP = 'drep1legacyfield';

function buildEvent(ctx: Record<string, string>): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    requestContext: {
      authorizer: { lambda: ctx },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer['requestContext'],
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

describe('extractAuthContext — registeredDrepId rename compat', () => {
  it('reads the new `registeredDrepId` field from the authorizer context', () => {
    const ctx = extractAuthContext(
      buildEvent({
        walletAddress: WALLET,
        roles: JSON.stringify(['delegator']),
        sessionType: 'normal',
        registeredDrepId: NEW_DREP,
      }),
    );

    expect(ctx.walletAddress).toBe(WALLET);
    expect(ctx.roles).toEqual(['delegator']);
    expect(ctx.registeredDrepId).toBe(NEW_DREP);
  });

  it('falls back to the legacy `drepId` authorizer-context field when the new one is absent', () => {
    // Simulates the rollout window where the authorizer Lambda is
    // still on the old code and emits `drepId` instead of
    // `registeredDrepId`. The downstream handler must still see the
    // registered-DRep id.
    const ctx = extractAuthContext(
      buildEvent({
        walletAddress: WALLET,
        roles: JSON.stringify(['delegator']),
        sessionType: 'normal',
        drepId: LEGACY_DREP,
      }),
    );

    expect(ctx.registeredDrepId).toBe(LEGACY_DREP);
  });

  it('prefers the new field when both are present', () => {
    const ctx = extractAuthContext(
      buildEvent({
        walletAddress: WALLET,
        roles: JSON.stringify(['delegator']),
        sessionType: 'normal',
        registeredDrepId: NEW_DREP,
        drepId: LEGACY_DREP,
      }),
    );

    expect(ctx.registeredDrepId).toBe(NEW_DREP);
  });

  it('returns undefined when neither field is present', () => {
    const ctx = extractAuthContext(
      buildEvent({
        walletAddress: WALLET,
        roles: JSON.stringify(['delegator']),
        sessionType: 'normal',
      }),
    );

    expect(ctx.registeredDrepId).toBeUndefined();
  });
});

// ---- S1 (2026-06-10 security review) — tokenSource forwarding ----

describe('extractAuthContext — tokenSource (S1)', () => {
  it('parses `legacy` tokenSource', () => {
    const ctx = extractAuthContext(
      buildEvent({
        walletAddress: WALLET,
        roles: JSON.stringify(['delegator']),
        sessionType: 'normal',
        tokenSource: 'legacy',
      }),
    );
    expect(ctx.tokenSource).toBe('legacy');
  });

  it('parses `onchain` tokenSource', () => {
    const ctx = extractAuthContext(
      buildEvent({
        walletAddress: WALLET,
        roles: JSON.stringify(['delegator']),
        sessionType: 'normal',
        tokenSource: 'onchain',
        onChainRoles: JSON.stringify(['drep']),
      }),
    );
    expect(ctx.tokenSource).toBe('onchain');
  });

  it('drops an unknown tokenSource value to undefined (defensive)', () => {
    const ctx = extractAuthContext(
      buildEvent({
        walletAddress: WALLET,
        roles: JSON.stringify(['delegator']),
        sessionType: 'normal',
        tokenSource: 'bogus',
      }),
    );
    expect(ctx.tokenSource).toBeUndefined();
  });

  it('omits tokenSource when absent (pre-S1 authorizer)', () => {
    const ctx = extractAuthContext(
      buildEvent({
        walletAddress: WALLET,
        roles: JSON.stringify(['delegator']),
        sessionType: 'normal',
      }),
    );
    expect(ctx.tokenSource).toBeUndefined();
  });
});

// ---- P0-4 (2026-05-28) — committee-scoped authorization helpers ----

describe('requireOwner — author-only check (action comments etc.)', () => {
  const authCtx = {
    walletAddress: WALLET,
    roles: ['lead_drep' as const, 'committee_member' as const],
  };

  it('permits the owner regardless of roles held', () => {
    expect(() => requireOwner(authCtx, WALLET)).not.toThrow();
  });

  it('REJECTS a non-owner even when they hold lead_drep globally', () => {
    expect(() => requireOwner(authCtx, 'stake1somebody_else')).toThrow(
      AuthorizationError,
    );
  });
});

describe('requireOwnerOrCommitteeLead — scope-aware override', () => {
  const X_LEAD = 'stake1x_lead';
  const X_MEMBER_LEAD = 'stake1x_member_with_lead_role';
  const X_PLAIN = 'stake1x_plain_committee_member';
  const Y_LEAD = 'stake1y_lead_of_some_other_committee';

  const xCommittee: {
    leadWallet: string;
    members: CommitteeMemberItem[];
  } = {
    leadWallet: X_LEAD,
    members: [
      { walletAddress: X_LEAD, role: 'lead_drep', joinedAt: 't' },
      { walletAddress: X_MEMBER_LEAD, role: 'lead_drep', joinedAt: 't' },
      { walletAddress: X_PLAIN, role: 'committee_member', joinedAt: 't' },
    ],
  };

  const ctxFor = (wallet: string) => ({
    walletAddress: wallet,
    roles: ['lead_drep' as const],
  });

  it('permits the owner regardless of committee membership', () => {
    expect(() =>
      requireOwnerOrCommitteeLead(ctxFor('stake1author'), 'stake1author', xCommittee),
    ).not.toThrow();
  });

  it('permits the platform-level leadWallet of THIS committee', () => {
    expect(() =>
      requireOwnerOrCommitteeLead(ctxFor(X_LEAD), 'stake1author', xCommittee),
    ).not.toThrow();
  });

  it('permits a `lead_drep`-role member of THIS committee', () => {
    expect(() =>
      requireOwnerOrCommitteeLead(ctxFor(X_MEMBER_LEAD), 'stake1author', xCommittee),
    ).not.toThrow();
  });

  it('REJECTS the lead of some OTHER committee (the P0-4 exploit)', () => {
    expect(() =>
      requireOwnerOrCommitteeLead(ctxFor(Y_LEAD), 'stake1author', xCommittee),
    ).toThrow(AuthorizationError);
  });

  it('REJECTS a `committee_member` (non-lead) of THIS committee', () => {
    // `committee_member` is a posting role, not a moderation role.
    // Even when listed in this committee's members, they cannot
    // delete other authors' posts.
    expect(() =>
      requireOwnerOrCommitteeLead(ctxFor(X_PLAIN), 'stake1author', xCommittee),
    ).toThrow(AuthorizationError);
  });

  it('REJECTS any non-owner when committee is undefined (auto-post clubhouse fallback)', () => {
    expect(() =>
      requireOwnerOrCommitteeLead(ctxFor(Y_LEAD), 'stake1author', undefined),
    ).toThrow(AuthorizationError);
  });

  it('permits the owner even when committee is undefined', () => {
    expect(() =>
      requireOwnerOrCommitteeLead(ctxFor('stake1author'), 'stake1author', undefined),
    ).not.toThrow();
  });
});
