# `frontend/src/pages/`

Route-level views. One page per top-level URL. Mounted in
`frontend/src/App.tsx` via React Router.

## Page route map

| File | Route | Purpose |
|------|-------|---------|
| `Home.tsx` | `/` | Redirects to either `GuestLanding` (signed-out) or `DelegatorDashboard` (signed-in) |
| `GuestLanding.tsx` | `/welcome` | Marketing page for unauthenticated visitors |
| `WalletConnectPage.tsx` | `/connect` | CIP-30 wallet picker + connect flow |
| `ProfileSetup.tsx` | `/onboarding` | First-time profile setup after wallet connect |
| `ComingSoon.tsx` | `/coming-soon` | Placeholder for unreleased surfaces |
| `GovernanceListPage.tsx` | `/governance` | Browse all governance actions, filter by status / type |
| `GovernanceActionPage.tsx` | `/governance/:actionId` | Single action detail — anchor body, vote tallies, comments |
| `GovernanceHistoryPage.tsx` | `/governance/history` | Historical actions with `/governance/stats` aggregation tiles |
| `DRepDirectoryPage.tsx` | `/dreps` | Browse/search DReps with sort tabs (power / delegators / recent / name), pagination, retired toggle |
| `DRepPublicProfile.tsx` | `/dreps/:drepId` | Single-DRep chain-state profile — anchor body, voting power, recent votes, delegators |
| `DRepDashboard.tsx` | `/drep/dashboard` | Logged-in DRep's own dashboard (committee admin) |
| `DelegatorDashboard.tsx` | `/dashboard` | Logged-in delegator's dashboard |
| `DelegatorClubhouse.tsx` | `/clubhouse/:drepId` | Delegator clubhouse for a specific DRep |
| `ClubhouseLanding.tsx` | `/clubhouse` | Discover clubhouses |
| `PublicProfilePage.tsx` | `/profile/:walletAddress` | Public profile for any wallet address |

## Conventions

- One page = one default-exported React component.
- Pages compose components from `frontend/src/components/`. Keep
  page-only logic (URL parsing, top-level data fetching) in the page
  file; reusable presentation goes in components.
- Data fetching via TanStack Query hooks from `frontend/src/hooks/`.
  Pages call `useQuery(...)` / `useMutation(...)` directly; never
  bypass the query client.
- Page-scoped state lives in the component. Cross-page state goes in
  `frontend/src/stores/` (Zustand).
- Loading / error states belong in the page. Components render the
  data they're given and display inline errors only for component-local
  problems.

## Auth gating

Pages that require auth call `useAuth()` from `frontend/src/hooks/useAuth.ts`
and redirect to `/connect` if signed-out. There's no central guard
HOC — explicit redirect-on-mount in each protected page keeps the
behavior visible.

## Adding a new page

1. Create `pages/<Name>.tsx` exporting a default React component.
2. Wire it up in `App.tsx`'s router config.
3. If the page needs API data, add a hook in
   `frontend/src/hooks/use<Name>.ts` rather than calling axios from the
   page directly.
4. If the route is auth-gated, replicate the redirect-on-mount pattern
   from `DelegatorDashboard.tsx`.
