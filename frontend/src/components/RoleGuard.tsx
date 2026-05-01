import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import type { UserRole } from '@/types';

interface RoleGuardProps {
  children: React.ReactNode;
  /** At least one of these roles is required */
  requiredRoles: UserRole[];
  /** Where to redirect unauthenticated users. Defaults to '/' */
  redirectTo?: string;
  /** Custom fallback element instead of redirect */
  fallback?: React.ReactNode;
}

export function RoleGuard({
  children,
  requiredRoles,
  redirectTo = '/',
  fallback,
}: RoleGuardProps): React.ReactElement {
  const { walletAddress, roles, expiresAt } = useAuthStore();
  const location = useLocation();

  const isAuthenticated =
    Boolean(walletAddress) &&
    Boolean(expiresAt) &&
    new Date(expiresAt!).getTime() > Date.now();

  if (!isAuthenticated) {
    if (fallback) return <>{fallback}</>;
    return <Navigate to={redirectTo} state={{ from: location }} replace />;
  }

  const hasRequiredRole = requiredRoles.some((r) => roles.includes(r));
  if (!hasRequiredRole) {
    if (fallback) return <>{fallback}</>;
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <h2 className="text-2xl font-semibold mb-2">Access Restricted</h2>
        <p className="text-muted-foreground">
          You need one of the following roles to access this page:{' '}
          <span className="font-medium">{requiredRoles.join(', ')}</span>
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
