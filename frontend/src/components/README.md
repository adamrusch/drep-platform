# `frontend/src/components/`

Reusable UI components. Pages compose these. Anything route-specific lives
under `frontend/src/pages/` instead.

## Categories

```
components/
├── ui/                          # Design-system primitives
│   ├── Button.tsx               # CVA-based button with variants
│   ├── Card.tsx                 # Card + CardHeader + CardContent
│   ├── Donut.tsx                # SVG donut chart for ratification math
│   ├── Markdown.tsx             # Rehype-sanitized Markdown renderer
│   ├── SentimentBar.tsx         # Stacked yes/no/abstain bar
│   ├── Sparkline.tsx            # Inline line chart
│   ├── StatTile.tsx             # Headline + value + delta tile
│   ├── StatusPill.tsx           # Active/expired/enacted/dropped chip
│   └── Toaster.tsx              # Toast renderer for clipboard / errors
├── rails/                       # Right-rail widgets (governance + dashboards)
│   ├── ClubhouseRail.tsx        # Recent clubhouse activity for a DRep
│   ├── DashboardRail.tsx        # User dashboard side rail
│   └── ProposalRail.tsx         # Proposal-detail side rail (links, anchor info)
├── governance/                  # Governance-specific shared components
│   ├── CastVoteModal.tsx        # Wallet-signed vote casting (Phase 2)
│   └── ShareModal.tsx           # Share + copy link
├── clubhouse/                   # Clubhouse-specific shared components
│   └── Composer.tsx             # Post composer with poll support
├── CommentForm.tsx              # Comment input + mutation-nonce signing
├── CommentList.tsx              # Threaded comments with recognition pills
├── GovernanceActionCard.tsx     # Card view of one action (used on list pages)
├── GovernanceHistoryWidget.tsx  # Mini governance-history widget
├── HeroBand.tsx                 # Page-top hero with stats
├── Layout.tsx                   # App shell — topbar, sidebar, drawer
├── RoleGuard.tsx                # Conditional render based on user role
├── SentimentBlock.tsx           # 3-slice ratification donut + role breakdown
└── WalletButton.tsx             # CIP-30 connect / disconnect button
```

## Conventions

- `ui/` primitives match the Cardano design system tokens in
  `frontend/src/styles/design-system.css`. Adding a new primitive should
  follow the same CVA / Radix-wrapper pattern as `Button.tsx`.
- Components are functional + hooks. No class components.
- Server state via TanStack Query (`useQuery`, `useMutation`); local UI
  state via Zustand stores in `frontend/src/stores/`.
- TypeScript: strict mode, no `any` in component props.
- Markdown content (anchor bodies, comment bodies, posts) ALWAYS goes
  through `<Markdown>` which wraps `react-markdown` with
  `rehype-sanitize` to defang XSS in user-supplied / chain-supplied text.

## Conditional surfaces

Some components have role-aware rendering. Use `<RoleGuard>` rather than
inline conditionals for clarity:

```tsx
<RoleGuard roles={['lead_drep']}>
  <Composer />
</RoleGuard>
```

Roles come from the JWT claims (`auth/me` returns the parsed claim list).

## Adding a new component

1. Place it under the appropriate subfolder (or top-level if it's used
   from multiple feature areas).
2. Co-locate small helpers; extract larger ones to `frontend/src/lib/`.
3. Use design tokens — never hardcode colors or spacing values.
4. If the component talks to the API, use a TanStack Query hook from
   `frontend/src/hooks/`. Don't `axios.get()` directly inside a
   component.
