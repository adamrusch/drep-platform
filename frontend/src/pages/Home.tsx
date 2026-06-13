import type React from 'react';
import { useAuthStore, useIsAuthenticated } from '@/stores/authStore';
import { GuestLanding } from './GuestLanding';
import { DRepDashboard } from './DRepDashboard';
import { DelegatorDashboard } from './DelegatorDashboard';

export function Home(): React.ReactElement {
  const isAuthenticated = useIsAuthenticated();
  const roles = useAuthStore((s) => s.roles);

  if (!isAuthenticated) {
    return <GuestLanding />;
  }

  if (roles.includes('lead_drep') || roles.includes('committee_member')) {
    return <DRepDashboard />;
  }

  return <DelegatorDashboard />;
}
