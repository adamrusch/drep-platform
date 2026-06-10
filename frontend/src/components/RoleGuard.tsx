import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores/authStore';
import type { OnChainRole, UserRole } from '@/types';

interface RoleGuardProps {
  children: React.ReactNode;
  /** At least one of these roles is required (platform role) */
  requiredRoles?: UserRole[];
  /** Sprint 1 — at least one of these on-chain proven roles is required.
   *  Parallel to `requiredRoles`. When BOTH are supplied, the guard
   *  accepts a user who satisfies EITHER (logical OR — the union of the
   *  two role surfaces is permissive). When ONLY `requiredOnChainRoles`
   *  is supplied, the platform-role check is skipped entirely (the user
   *  may be a wallet-less SPO whose `roles` is just `['guest']`). */
  requiredOnChainRoles?: OnChainRole[];
  /** Where to redirect unauthenticated users. Defaults to '/' */
  redirectTo?: string;
  /** Custom fallback element instead of redirect */
  fallback?: React.ReactNode;
}

export function RoleGuard({
  children,
  requiredRoles,
  requiredOnChainRoles,
  redirectTo = '/',
  fallback,
}: RoleGuardProps): React.ReactElement {
  const { t } = useTranslation();
  const { walletAddress, roles, onChainRoles, expiresAt } = useAuthStore();
  const location = useLocation();

  const isAuthenticated =
    Boolean(walletAddress) &&
    Boolean(expiresAt) &&
    new Date(expiresAt!).getTime() > Date.now();

  if (!isAuthenticated) {
    if (fallback) return <>{fallback}</>;
    return <Navigate to={redirectTo} state={{ from: location }} replace />;
  }

  const platformRolesRequired = requiredRoles ?? [];
  const onChainRolesRequired = requiredOnChainRoles ?? [];

  const hasPlatformRole =
    platformRolesRequired.length === 0
      ? false
      : platformRolesRequired.some((r) => roles.includes(r));
  const hasOnChainRole =
    onChainRolesRequired.length === 0
      ? false
      : onChainRolesRequired.some((r) => onChainRoles.includes(r));

  // Permissive OR: a caller may pass `requiredRoles` only (legacy), or
  // `requiredOnChainRoles` only (a new on-chain-gated surface), or both
  // (any one role across either surface). At least one of the two arrays
  // MUST be non-empty for the guard to ever pass — passing both empty
  // is a programming error that should fail closed.
  const anyChecked =
    platformRolesRequired.length > 0 || onChainRolesRequired.length > 0;
  const hasRequiredRole = anyChecked && (hasPlatformRole || hasOnChainRole);

  if (!hasRequiredRole) {
    if (fallback) return <>{fallback}</>;
    const labels = [...platformRolesRequired, ...onChainRolesRequired];
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <h2 className="text-2xl font-semibold mb-2">{t('roleGuard.accessRestricted')}</h2>
        <p className="text-muted-foreground">
          {t('roleGuard.needRole')}{' '}
          <span className="font-medium">{labels.join(', ')}</span>
        </p>
      </div>
    );
  }

  return <>{children}</>;
}

/** Convenience wrapper that only requires authentication (any role) */
export function AuthGuard({
  children,
  redirectTo = '/',
}: {
  children: React.ReactNode;
  redirectTo?: string;
}): React.ReactElement {
  return (
    <RoleGuard
      requiredRoles={['delegator', 'committee_member', 'lead_drep', 'trusted_delegator', 'guest']}
      redirectTo={redirectTo}
    >
      {children}
    </RoleGuard>
  );
}
