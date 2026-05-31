import type { AuthContext } from '../middleware/role-guard';
import { AuthorizationError } from '../middleware/role-guard';

/**
 * platform_admin recognition.
 *
 * Bootstrap: the wallets in the ADMIN_BOOTSTRAP_WALLETS env (comma-separated,
 * sourced from the admin-bootstrap secret/context at deploy time) are treated
 * as platform_admin even without the persisted role — this is the break-glass
 * seed that grants the first admin. Thereafter admins grant/revoke the role to
 * others, which persists it on the users row.
 */
export function getBootstrapAdmins(): string[] {
  return (process.env['ADMIN_BOOTSTRAP_WALLETS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isBootstrapAdmin(wallet: string): boolean {
  return getBootstrapAdmins().includes(wallet);
}

export function isPlatformAdmin(authCtx: AuthContext): boolean {
  return authCtx.roles.includes('platform_admin') || isBootstrapAdmin(authCtx.walletAddress);
}

export function requirePlatformAdmin(authCtx: AuthContext): void {
  if (!isPlatformAdmin(authCtx)) {
    throw new AuthorizationError('This action requires platform_admin', 403);
  }
}
