import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';

import { queryClient } from '@/lib/api';
import { WalletAuthProvider } from '@/auth/WalletAuthProvider';
import { Layout } from '@/components/Layout';
import { RoleGuard } from '@/components/RoleGuard';
import { useAuthStore } from '@/stores/authStore';

import { Home } from '@/pages/Home';
import { GuestLanding } from '@/pages/GuestLanding';
import { GovernanceActionPage } from '@/pages/GovernanceActionPage';
import { DRepPublicProfile } from '@/pages/DRepPublicProfile';
import { DelegatorClubhouse } from '@/pages/DelegatorClubhouse';
import { WalletConnectPage } from '@/pages/WalletConnectPage';
import { DRepDashboard } from '@/pages/DRepDashboard';
import { DelegatorDashboard } from '@/pages/DelegatorDashboard';
import { ProfileSetup } from '@/pages/ProfileSetup';
import { PublicProfilePage } from '@/pages/PublicProfilePage';

/**
 * Routes the user to the correct dashboard based on their role.
 * Lead DReps and committee members → DRepDashboard
 * Everyone else → DelegatorDashboard
 */
function DashboardRouter(): React.ReactElement {
  const { roles } = useAuthStore();
  if (roles.includes('lead_drep') || roles.includes('committee_member')) {
    return <DRepDashboard />;
  }
  return <DelegatorDashboard />;
}

function App(): React.ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <WalletAuthProvider>
          <Layout>
            <Routes>
              {/* Public landing / dashboard switcher */}
              <Route path="/" element={<Home />} />
              <Route path="/guest" element={<GuestLanding />} />

              {/* Auth */}
              <Route path="/auth/connect" element={<WalletConnectPage />} />

              {/* Governance */}
              <Route path="/governance/:actionId" element={<GovernanceActionPage />} />

              {/* DRep public surfaces */}
              <Route path="/drep/:drepId" element={<DRepPublicProfile />} />
              <Route path="/drep/:drepId/delegators" element={<DelegatorClubhouse />} />

              {/* Authenticated dashboards */}
              <Route
                path="/dashboard"
                element={
                  <RoleGuard
                    requiredRoles={[
                      'delegator',
                      'committee_member',
                      'lead_drep',
                      'trusted_delegator',
                    ]}
                    redirectTo="/auth/connect"
                  >
                    <DashboardRouter />
                  </RoleGuard>
                }
              />
              <Route
                path="/dashboard/drep"
                element={
                  <RoleGuard
                    requiredRoles={['lead_drep', 'committee_member']}
                    redirectTo="/auth/connect"
                  >
                    <DRepDashboard />
                  </RoleGuard>
                }
              />
              <Route
                path="/dashboard/delegator"
                element={
                  <RoleGuard
                    requiredRoles={[
                      'delegator',
                      'committee_member',
                      'lead_drep',
                      'trusted_delegator',
                    ]}
                    redirectTo="/auth/connect"
                  >
                    <DelegatorDashboard />
                  </RoleGuard>
                }
              />

              {/* Profile */}
              <Route
                path="/profile/setup"
                element={
                  <RoleGuard
                    requiredRoles={[
                      'delegator',
                      'committee_member',
                      'lead_drep',
                      'trusted_delegator',
                    ]}
                    redirectTo="/auth/connect"
                  >
                    <ProfileSetup />
                  </RoleGuard>
                }
              />
              <Route path="/profile/:walletAddress" element={<PublicProfilePage />} />

              {/* Catch-all redirect */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Layout>
        </WalletAuthProvider>
      </BrowserRouter>
      {import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} />}
    </QueryClientProvider>
  );
}

export default App;
