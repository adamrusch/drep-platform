import { describe, it, expect, afterEach } from 'vitest';
import { isBootstrapAdmin, isPlatformAdmin, getBootstrapAdmins } from './platformAdmin';
import type { AuthContext } from '../middleware/role-guard';

const ctx = (over: Partial<AuthContext> = {}): AuthContext => ({
  walletAddress: 'addr1xxx',
  roles: [],
  ...over,
});

afterEach(() => {
  delete process.env['ADMIN_BOOTSTRAP_WALLETS'];
});

describe('platformAdmin', () => {
  it('parses the bootstrap list (trims, drops empties)', () => {
    process.env['ADMIN_BOOTSTRAP_WALLETS'] = ' addr1a , addr1b ,';
    expect(getBootstrapAdmins()).toEqual(['addr1a', 'addr1b']);
  });

  it('empty env → no bootstrap admins', () => {
    expect(getBootstrapAdmins()).toEqual([]);
    expect(isBootstrapAdmin('anything')).toBe(false);
  });

  it('a persisted platform_admin role is recognized', () => {
    expect(isPlatformAdmin(ctx({ roles: ['platform_admin'] }))).toBe(true);
  });

  it('a bootstrap wallet is an admin even without the role', () => {
    process.env['ADMIN_BOOTSTRAP_WALLETS'] = 'addr1xxx';
    expect(isPlatformAdmin(ctx())).toBe(true);
  });

  it('a non-admin, non-bootstrap wallet is not an admin', () => {
    expect(isPlatformAdmin(ctx({ roles: ['lead_drep'] }))).toBe(false);
  });
});
