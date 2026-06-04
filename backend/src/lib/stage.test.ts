/**
 * Unit test for `canBroadcastGovernanceVote` (Feature 3).
 *
 * This predicate is the LAST in-code wall between an accidental test-env
 * click and a real, irreversible mainnet DRep vote. The matrix:
 *
 *   STAGE = 'prod'              → true  (any caller; lead check is its own gate)
 *   STAGE = 'test' + admin      → true  (test = REAL mainnet votes → admins only)
 *   STAGE = 'test' + non-admin  → false
 *   STAGE = 'dev'  / undefined  → false (never broadcast from non-deployed)
 *
 * `admin` is recognised either by the persisted `platform_admin` role OR by
 * the wallet appearing on the `ADMIN_BOOTSTRAP_WALLETS` env (the
 * break-glass seed) — both branches are exercised.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { canBroadcastGovernanceVote } from './stage';
import type { AuthContext } from '../middleware/role-guard';

const ctx = (over: Partial<AuthContext> = {}): AuthContext => ({
  walletAddress: 'stake1nonadmin',
  roles: [],
  ...over,
});

afterEach(() => {
  delete process.env['STAGE'];
  delete process.env['ADMIN_BOOTSTRAP_WALLETS'];
});

describe('canBroadcastGovernanceVote', () => {
  it('prod → true for any caller (lead check is separate)', () => {
    process.env['STAGE'] = 'prod';
    expect(canBroadcastGovernanceVote(ctx())).toBe(true);
    expect(canBroadcastGovernanceVote(ctx({ roles: ['lead_drep'] }))).toBe(true);
    expect(canBroadcastGovernanceVote(ctx({ roles: ['platform_admin'] }))).toBe(true);
  });

  it('test + platform_admin role → true', () => {
    process.env['STAGE'] = 'test';
    expect(canBroadcastGovernanceVote(ctx({ roles: ['platform_admin'] }))).toBe(true);
  });

  it('test + bootstrap wallet → true (even without the persisted role)', () => {
    process.env['STAGE'] = 'test';
    process.env['ADMIN_BOOTSTRAP_WALLETS'] = 'stake1bootstrap';
    expect(
      canBroadcastGovernanceVote(ctx({ walletAddress: 'stake1bootstrap' })),
    ).toBe(true);
  });

  it('test + non-admin lead → false (test casts REAL mainnet votes)', () => {
    process.env['STAGE'] = 'test';
    expect(canBroadcastGovernanceVote(ctx({ roles: ['lead_drep'] }))).toBe(false);
  });

  it('test + no roles → false', () => {
    process.env['STAGE'] = 'test';
    expect(canBroadcastGovernanceVote(ctx())).toBe(false);
  });

  it('dev → false even with platform_admin', () => {
    process.env['STAGE'] = 'dev';
    expect(canBroadcastGovernanceVote(ctx({ roles: ['platform_admin'] }))).toBe(false);
  });

  it('unset STAGE → false (defaults to dev)', () => {
    expect(canBroadcastGovernanceVote(ctx({ roles: ['platform_admin'] }))).toBe(false);
  });
});
