import React, { Suspense, lazy, useEffect } from 'react';
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

/**
 * Per-route lazy imports.
 *
 * Why this matters: before lazy-loading, every page component (~14 of them,
 * including the heavyweight DRep directory + governance pages) was statically
 * imported into App.tsx, which Rollup bundled into a single ~786 KB raw /
 * ~170 KB gzip entry chunk. First paint paid the whole bill regardless of
 * which route was actually rendered.
 *
 * With React.lazy, each page becomes its own Rollup chunk, fetched only when
 * the matching route renders. The landing routes (`/`, `/guest`) now pay
 * only for the small Home / GuestLanding components plus the shared vendor
 * chunks (React, react-router, TanStack Query). The big chunks (DRep
 * directory page with its sort/filter UI, GovernanceActionPage with the
 * markdown renderer, the Clubhouse pages with comment threading) ship
 * lazily on first navigation to those routes.
 *
 * # Why the `.then((m) => ({ default: m.X }))` indirection
 *
 * Every page in `src/pages/` uses a NAMED export (`export function X(): …`)
 * rather than a default export, so the bare `import('@/pages/X')` returns
 * a module whose `default` field is `undefined` — which React.lazy can't
 * use. The thenable adapter remaps the named export into the
 * `{ default: … }` shape React.lazy requires. This is the standard
 * idiom; alternatives (adding default exports to every page) would touch
 * 14+ files for a stylistic preference, and would also create a second,
 * redundant export path on each page.
 *
 * # MeshSDK is NOT lazy-loaded here
 *
 * The Mesh WalletButton chunk (already split out at ~6.9 MB raw / 1.3 MB
 * gz, plus a 5.4 MB WASM blob) is lazy-loaded inside `Layout.tsx` via its
 * own React.lazy boundary. That separation is intentional — the wallet
 * code is part of the persistent topbar, not a route, so it follows a
 * different lifecycle than the page chunks below.
 */
const Home = lazy(() => import('@/pages/Home').then((m) => ({ default: m.Home })));
const GuestLanding = lazy(() =>
  import('@/pages/GuestLanding').then((m) => ({ default: m.GuestLanding })),
);
const GovernanceListPage = lazy(() =>
  import('@/pages/GovernanceListPage').then((m) => ({ default: m.GovernanceListPage })),
);
const GovernanceHistoryPage = lazy(() =>
  import('@/pages/GovernanceHistoryPage').then((m) => ({ default: m.GovernanceHistoryPage })),
);
const GovernanceActionPage = lazy(() =>
  import('@/pages/GovernanceActionPage').then((m) => ({ default: m.GovernanceActionPage })),
);
const DRepPublicProfile = lazy(() =>
  import('@/pages/DRepPublicProfile').then((m) => ({ default: m.DRepPublicProfile })),
);
const DelegatorClubhouse = lazy(() =>
  import('@/pages/DelegatorClubhouse').then((m) => ({ default: m.DelegatorClubhouse })),
);
const WalletConnectPage = lazy(() =>
  import('@/pages/WalletConnectPage').then((m) => ({ default: m.WalletConnectPage })),
);
const DRepDashboard = lazy(() =>
  import('@/pages/DRepDashboard').then((m) => ({ default: m.DRepDashboard })),
);
const DelegatorDashboard = lazy(() =>
  import('@/pages/DelegatorDashboard').then((m) => ({ default: m.DelegatorDashboard })),
);
const ProfileSetup = lazy(() =>
  import('@/pages/ProfileSetup').then((m) => ({ default: m.ProfileSetup })),
);
const PublicProfilePage = lazy(() =>
  import('@/pages/PublicProfilePage').then((m) => ({ default: m.PublicProfilePage })),
);
const ComingSoon = lazy(() =>
  import('@/pages/ComingSoon').then((m) => ({ default: m.ComingSoon })),
);
const ClubhouseLanding = lazy(() =>
  import('@/pages/ClubhouseLanding').then((m) => ({ default: m.ClubhouseLanding })),
);
const DRepDirectoryPage = lazy(() =>
  import('@/pages/DRepDirectoryPage').then((m) => ({ default: m.DRepDirectoryPage })),
);
const CommitteeLanding = lazy(() =>
  import('@/pages/CommitteeLanding').then((m) => ({ default: m.CommitteeLanding })),
);
const CommitteeVoteList = lazy(() =>
  import('@/pages/CommitteeVoteList').then((m) => ({ default: m.CommitteeVoteList })),
);
const CommitteeVoteRoom = lazy(() =>
  import('@/pages/CommitteeVoteRoom').then((m) => ({ default: m.CommitteeVoteRoom })),
);
const RationaleEditorPage = lazy(() =>
  import('@/pages/RationaleEditorPage').then((m) => ({ default: m.RationaleEditorPage })),
);
const RationalesPage = lazy(() =>
  import('@/pages/RationalesPage').then((m) => ({ default: m.RationalesPage })),
);
const AdminPanel = lazy(() =>
  import('@/pages/AdminPanel').then((m) => ({ default: m.AdminPanel })),
);

/**
 * Suspense fallback rendered while a lazy page chunk is fetching.
 *
 * Kept deliberately lightweight: a single centered spinner inside the
 * Layout chrome. No skeleton scaffolding — page shapes vary too widely
 * (directory grid vs single-action vs dashboard) for a per-page skeleton
 * to be worth the maintenance burden of keeping it in sync. On a warm
 * cache the chunk arrives in 10–50ms anyway, well below the threshold
 * where a skeleton beats a spinner.
 *
 * Uses design-system tokens so the spinner reads correctly in both
 * light and dark themes. `role="status"` + `aria-label` keeps screen
 * readers informed; `aria-live="polite"` lets assistive tech announce
 * the load without interrupting the user.
 */
function RouteFallback(): React.ReactElement {
  return (
    <div
      className="flex items-center justify-center w-full py-24"
      role="status"
      aria-live="polite"
      aria-label="Loading page"
    >
      <span
        className="inline-block w-8 h-8 rounded-full border-2 border-[var(--border-default)] border-t-[var(--brand-primary)] animate-spin"
        aria-hidden="true"
      />
    </div>
  );
}

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
            {/* Single Suspense boundary wraps the entire <Routes>. A
                per-route boundary would also work, but a single one
                avoids 14+ duplicated <Suspense> wrappers and keeps the
                fallback consistent across routes. Layout chrome (topbar
                + nav) stays mounted while a chunk loads — only the
                page-body slot reveals the spinner. */}
            <Suspense fallback={<RouteFallback />}>
              <Routes>
                {/* Public landing / dashboard switcher */}
                <Route path="/" element={<Home />} />
                <Route path="/guest" element={<GuestLanding />} />

                {/* Auth */}
                <Route path="/auth/connect" element={<WalletConnectPage />} />

                {/* Governance — public, no auth required.
                    NOTE: `/governance/history` MUST be declared before
                    `/governance/:actionId` so React Router's segment match
                    picks the static route over the parameterized one. */}
                <Route path="/governance" element={<GovernanceListPage />} />
                <Route path="/governance/history" element={<GovernanceHistoryPage />} />
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
                {/* DRep committees — order matters: most specific first. */}
                <Route
                  path="/committee/:drepId/votes/:actionId/rationale"
                  element={<RationaleEditorPage />}
                />
                <Route
                  path="/committee/:drepId/votes/:actionId"
                  element={<CommitteeVoteRoom />}
                />
                <Route path="/committee/:drepId" element={<CommitteeVoteList />} />
                <Route path="/committee" element={<CommitteeLanding />} />
                <Route
                  path="/admin"
                  element={
                    <RoleGuard requiredRoles={['platform_admin']} redirectTo="/">
                      <AdminPanel />
                    </RoleGuard>
                  }
                />
                <Route path="/dreps" element={<DRepDirectoryPage />} />
                <Route path="/rationales" element={<RationalesPage />} />
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
            </Suspense>
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
