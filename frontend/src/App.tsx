import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';

import { queryClient } from '@/lib/api';
import { WalletAuthProvider } from '@/auth/WalletAuthProvider';
import { Layout } from '@/components/Layout';
import { RoleGuard } from '@/components/RoleGuard';
import { Toaster } from '@/components/ui/Toaster';
import { useAuthStore } from '@/stores/authStore';
import { useThemeStore } from '@/stores/themeStore';

import { Home } from '@/pages/Home';
import { GuestLanding } from '@/pages/GuestLanding';
import { GovernanceListPage } from '@/pages/GovernanceListPage';
import { GovernanceActionPage } from '@/pages/GovernanceActionPage';
import { DRepPublicProfile } from '@/pages/DRepPublicProfile';
import { DelegatorClubhouse } from '@/pages/DelegatorClubhouse';
import { WalletConnectPage } from '@/pages/WalletConnectPage';
import { DRepDashboard } from '@/pages/DRepDashboard';
import { DelegatorDashboard } from '@/pages/DelegatorDashboard';
import { ProfileSetup } from '@/pages/ProfileSetup';
import { PublicProfilePage } from '@/pages/PublicProfilePage';
import { ComingSoon } from '@/pages/ComingSoon';
import { ClubhouseLanding } from '@/pages/ClubhouseLanding';
import { DRepDirectoryPage } from '@/pages/DRepDirectoryPage';

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
  const theme = useThemeStore((s) => s.theme);

  // Mirror the persisted theme onto the root <html> element so the
  // [data-theme="dark"] CSS block in design-system.css activates.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

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

              {/* Governance — public, no auth required */}
              <Route path="/governance" element={<GovernanceListPage />} />
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

              {/* Clubhouse — the README's hero flow. The /clubhouse landing
                  route picks the right DRep clubhouse for the signed-in
                  user (or shows a Discover CTA for guests). */}
              <Route path="/clubhouse" element={<ClubhouseLanding />} />
              <Route
                path="/committee"
                element={
                  <ComingSoon
                    title="Committee"
                    description="Constitutional Committee directory, voting power, and cross-DRep coordination. Coming soon."
                  />
                }
              />
              <Route path="/dreps" element={<DRepDirectoryPage />} />
              <Route
                path="/rationales"
                element={
                  <ComingSoon
                    title="Rationales"
                    description="Browse vote rationales from active DReps and committee members. Coming soon."
                  />
                }
              />
              <Route
                path="/notifications"
                element={
                  <ComingSoon
                    title="Notifications"
                    description="Track replies, mentions, governance updates, and clubhouse activity. Coming soon."
                  />
                }
              />

              {/* Catch-all redirect */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Layout>
          {/* Toast renderer — overlays everything (z-index handled by .toast-stack). */}
          <Toaster />
        </WalletAuthProvider>
      </BrowserRouter>
      {import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} />}
    </QueryClientProvider>
  );
}

export default App;
