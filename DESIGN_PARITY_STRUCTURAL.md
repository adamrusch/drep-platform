# DRep Coordination Platform — Structural Parity Audit

Code-only audit. Sources:

- Design: `/Users/admin/Documents/Claude/Projects/DRep Collaboration Platform/style-assets/design_handoff_drep_platform/design_files/`
- Live: `/Users/admin/Developer/drep-platform/frontend/src/`

The headline is simple: the **design tokens were imported verbatim** (`design-system.css` is byte-for-byte identical to `design_files/styles.css`), but **the live React components almost never reference those classes**. Out of ~500 styled selectors in the design system, the live app uses fewer than ~25, and only inside `Layout.tsx` and `PublicProfilePage.tsx`. Every other page is built with Tailwind utilities and has not been wired to the design vocabulary. The 4 hero surfaces (Dashboard, Governance, Clubhouse, Profile) are stubs compared to the spec.

---

## 1. Design Tokens

The token layer is the strongest area. `design-system.css` is a verbatim mirror — same names, same values, including the dark-theme block.

| Token | In design? | In live? | Match | Notes |
|---|---|---|---|---|
| `--brand-primary` (`#0033AD`) | ✅ | ✅ | ✅ | identical |
| `--brand-primary-hover` (`#002789`) | ✅ | ✅ | ✅ | identical |
| `--brand-primary-soft` (`#E6ECF7`) | ✅ | ✅ | ✅ | identical |
| `--brand-accent` / `--brand-accent-soft` / `--brand-cyan` | ✅ | ✅ | ✅ | identical |
| `--success` / `--danger` / `--warning` / `--info` (+ `-soft`) | ✅ | ✅ | ✅ | live includes `--info` token (design adds it too at `styles.css:21`) |
| `--bg-app`, `--bg-canvas`, `--bg-subtle`, `--bg-muted`, `--bg-hero` | ✅ | ✅ | ✅ | identical |
| `--text-primary/secondary/tertiary/muted/on-brand` | ✅ | ✅ | ✅ | identical |
| `--border-default/strong/subtle` | ✅ | ✅ | ✅ | identical |
| `--shadow-xs/sm/md/lg`, `--shadow-focus` | ✅ | ✅ | 🟡 | identical, but `--shadow-focus` uses indigo `rgba(79,70,229,...)` while brand is Cardano blue — minor inconsistency carried over from design (`styles.css:46`) |
| `--shadow-pop` | README spec | ❌ | ❌ | README `Shadows` section names `--shadow-pop` for modals/dropdowns; not present in either CSS file |
| Spacing `--s-1..--s-12` | ✅ | ✅ | ✅ | identical |
| Radius `--r-sm..--r-2xl`, `--r-full` | ✅ | ✅ | ✅ | identical |
| Type `--font-sans`, `--font-mono` | ✅ | ✅ | ✅ | Inter stack matches |
| Layout `--sidebar-w`, `--topbar-h`, `--right-rail-w` | ✅ | ✅ | ✅ | identical |
| Motion: cubic-bezier(0.16,1,0.3,1), 220ms enter, 150ms hover | ✅ | ✅ | ✅ | encoded in CSS keyframes |
| Tailwind theme extension mapping tokens to utilities | implied | ❌ | ❌ | `tailwind.config.*` not present in src; live uses raw Tailwind palette (`bg-green-100`, `text-emerald-800`, `bg-cardano-blue` referenced but no `theme.extend` found) |
| `cardano-blue` Tailwind color | implied custom | 🟡 | 🟡 | referenced in `CommentList.tsx:46,55` and `DRepDashboard.tsx:38` and `DelegatorDashboard.tsx:37` but not declared in any Tailwind config we can see — likely silently no-op |

**Verdict (tokens):** ✅ — the CSS variables are 100% there. The gap is **bridging** — Tailwind utilities don't reference the tokens, so most components style themselves with `bg-green-100`, `border-border`, etc. instead of the brand vocabulary.

---

## 2. Light / Dark Mode

| Element | Design ref | Live | Match |
|---|---|---|---|
| `[data-theme="dark"]` block | `styles.css:78–113` | `design-system.css:78–113` (verbatim) | ✅ tokens |
| Theme application (`document.documentElement.dataset.theme = ...`) | `app.jsx:21` | absent | ❌ |
| Tweaks panel toggle (light/dark buttons) | `app.jsx:175–193`, `tweaks-panel.jsx` | not implemented | ❌ |
| User-settings theme toggle (README §"Theme toggle" line 432: "Production should expose in user-settings dropdown") | spec | not implemented | ❌ |
| `localStorage` persistence under `theme` key | spec | not implemented | ❌ |
| `themeStore` (Zustand) per spec line 457 | spec | not implemented | ❌ |
| `dark:` Tailwind variants on components | implied | 0 occurrences in `src/` | ❌ |

**Verdict:** 🟡 the dark-mode CSS exists but is **dead code** — nothing ever sets `data-theme="dark"`. Toggling it via DevTools would partially work for `Layout.tsx` and the design-system classes, but every Tailwind-styled page (the majority) uses fixed light palette utilities (`bg-green-100`, `text-gray-600`, etc.) and would not adapt.

---

## 3. The Four Hero Surfaces

### 3a. Dashboard

Two live variants: `DRepDashboard.tsx` and `DelegatorDashboard.tsx`. Neither matches the design.

| Element | Design ref | Live | Match | Notes |
|---|---|---|---|---|
| Hero band (`hero` + `HeroDots` SVG) | `dashboard.jsx:35–39` | absent | ❌ | header is plain text |
| Stat grid (4 cards: Active, Comments, Committee, Sentiment %) | `dashboard.jsx:41–66` | partial — 3 plain divs in `DRepDashboard.tsx:47–58` | 🟡 | no icons, no soft-tint circles, no trend chip, no `stat__num` typography |
| Hot Actions table (`action-row__head` + grid columns Title / Status / Epoch / Discussions / Sentiment / chev) | `dashboard.jsx:68–112` | replaced by stack of `GovernanceActionCard` | ❌ | no row layout, no sentiment bar column, no hover chev animation |
| Sentiment bar (3-segment support/oppose/abstain) | `dashboard.jsx:100–104`, `styles.css:985–998` | absent in card | ❌ | CSS exists but no JSX uses it |
| **Right rail** entire column | `dashboard.jsx:120–207` (DashboardRail) | not rendered — `Layout.tsx:198` always uses `main--no-rail` | ❌ | live app has no right rail anywhere |
| DRep Profile chip (avatar lg + name + DRep ID + 3 metrics) | `dashboard.jsx:122–139` | absent | ❌ | |
| Committee Overview (3 stacked avatars + threshold + next meeting) | `dashboard.jsx:141–163` | absent | ❌ | |
| Delegator Sentiment donut (Approve/Disapprove/Abstain/Not Voted) | `dashboard.jsx:165–183` | absent | ❌ | `Donut` SVG primitive is not implemented |
| Recent Activity timeline (5–7 colored dot rows) | `dashboard.jsx:185–206` | absent | ❌ | CSS classes `.activity-row*` exist, unused |
| Wallet sync indicator (pulsing dot in topbar) | spec line 427, `chrome.jsx:74–80` | absent | ❌ |

**Surface fidelity:** ~10% (a header, a stat-ish row, an action list). 9 of 10 design elements absent.

### 3b. Governance Actions — list + detail

**List (`GovernanceListPage.tsx`)**

| Element | Design ref | Live | Match |
|---|---|---|---|
| Page head with title + sub | `governance.jsx:23–28` | ✅ `GovernanceListPage.tsx:23–28` | ✅ |
| Filter chip group (All / Voting / Discussion / Review / Passed / Failed) | `governance.jsx:32–43` | 🟡 4 status tabs, design has 4 status chips + extra | 🟡 partial — chips are styled as Tailwind tabs not `.kind-chip` |
| Search input (right-aligned, 280px, search icon prefix) | `governance.jsx:44–47` | ❌ absent | ❌ |
| Sort `<select>` (Latest / Most discussed / Most supported) | `governance.jsx:48–52` | ❌ absent | ❌ |
| Action card list — type pill, status pill, sentiment bar with %s | `governance.jsx:55–91` | 🟡 `GovernanceActionCard.tsx` shows type + status only | 🟡 — sentiment bar absent, status uses `bg-green-100`/`bg-blue-100` not branded `--success-soft`/`--brand-primary-soft` |
| Empty state card | `governance.jsx:63–65` | ✅ `GovernanceListPage.tsx:71–76` | ✅ |
| Skeleton loaders | (not in design) | ✅ `:51–61` | ✅ live additions |

**Detail (`GovernanceActionPage.tsx`)**

| Element | Design ref | Live | Match |
|---|---|---|---|
| Breadcrumb back link with chevron-left | `governance.jsx:117–121` | 🟡 plain text crumbs (`GovernanceActionPage.tsx:78–84`) | 🟡 — uses `mx-2` slash separator instead of `chevronLeft` icon |
| Hero card with H1 + status pill + meta row + Share/overflow | `governance.jsx:123–140` | 🟡 — title + status pill + actionId code; no Share, no padding card, status uses Tailwind colors not branded | 🟡 |
| Tabs: Overview / Public Comments / Delegator Clubhouse / Rationale | `governance.jsx:142–153` | ❌ absent — sections rendered as flat stacked cards | ❌ |
| Proposal Summary section | `governance.jsx:155–165` | 🟡 split into Abstract / Motivation / Rationale / Description sections | 🟡 — different shape, not the single "Summary + view full rationale" block |
| Meta strip (5 cells: Proposed by / Category / Amount / Policy ID / Requested by) | `governance.jsx:166–172` | 🟡 3-cell grid (Submitted / Epoch Deadline / Last Synced) | 🟡 different fields |
| **On-Chain Votes** section — sentiment cards + 140px donut + legend | `governance.jsx:174–221` | ❌ absent | ❌ |
| **Delegator Sentiment** section — same shape, separated by hairline | `governance.jsx:223–271` | ❌ absent | ❌ |
| Public Comments composer | `governance.jsx:277–289` | 🟡 `CommentForm.tsx` (textarea + isPublic checkbox + Post button) | 🟡 — no avatar, no "stake-weighted" helper, has extra "Make comment public" toggle that is not in design |
| Comment header — name → **Recognized gold-star** → stake pill → **DRep pill** → time | `governance.jsx:294–305` | ❌ — `CommentList.tsx:50–64` shows name + DRep flag pill + Members-only pill + time | ❌ |
| Recognized gold-star badge | `governance.jsx:296–300`, `styles.css:658–679` | ❌ never rendered | ❌ |
| Stake pill (`pill--neutral`, "5.2M ₳ stake") | `governance.jsx:301` | ❌ absent | ❌ |
| DRep pill ("delegates to X") | `governance.jsx:302–304` | ❌ absent | ❌ |
| Reply / like comment actions | `governance.jsx:308–311` | ❌ Delete only | ❌ |
| Anchor verification badge | (not in design) | ✅ `GovernanceActionPage.tsx:98–112` | live addition |
| References list (URL allowlist) | spec | ✅ `:191–216` | live addition |
| **Right rail** — Vote action card + DRep position chip + Timeline + Resources | `governance.jsx:346–423` (ProposalRail) | ❌ no right rail | ❌ |

### 3c. Delegator Clubhouse — *the README's hero flow*

This is where the gap is largest.

| Element | Design ref | Live | Match |
|---|---|---|---|
| Hero band ("Lock icon · Private to delegators of Ada DRep · 2,840 members") | `clubhouse.jsx:136–143` | ❌ absent — page just says "Delegator Clubhouse" | ❌ |
| Welcome card from DRep (avatar + bio + 3 stats: Members / Discussions / Total Delegated) | `clubhouse.jsx:145–176` | ❌ absent | ❌ |
| Composer with `composer__avatar` + auto-grow textarea | `clubhouse.jsx:178–215` | 🟡 plain textarea + Post button | 🟡 |
| **Type selector** (Discussion / Question / Poll segmented control) | `clubhouse.jsx:191–202` | ❌ absent | ❌ |
| Poll composer (when Poll selected, +Add option list, up to 4 inputs, remove buttons) | `clubhouse.jsx:79–84` | ❌ absent | ❌ |
| Filter chip row (All / Discussions / Questions / Announcements with counts) | `clubhouse.jsx:217–234` | ❌ absent | ❌ |
| Sort select | `clubhouse.jsx:228–231` | ❌ absent | ❌ |
| Post card with `post__head` + `post__author` + verified check + DRep / Trusted pills + pinned + time | `clubhouse.jsx:258–271` | 🟡 plain `flex items-start justify-between` with name + small DRep pill | 🟡 — no avatar in post, no Trusted Delegator pill, no Pinned pill |
| **Polls** — animated horizontal bars with %s, click to vote, optimistic update, "You voted" check | `clubhouse.jsx:276–297` | ❌ absent | ❌ |
| **Like** action with animated heart, count | `clubhouse.jsx:299–302` | ❌ absent | ❌ |
| Reply count action with msg icon | `clubhouse.jsx:303–305` | 🟡 plain text "N comment(s)" toggle | 🟡 |
| "View discussion →" link | `clubhouse.jsx:306–308` | ❌ absent | ❌ |
| Threaded replies inline (indented 44px, vertical line, avatar + name + role pill + body + actions) | `clubhouse.jsx:311–334` | 🟡 flat list of `<div>` rows | 🟡 — no avatars, no role pills, no left vertical line, no like-on-reply |
| Inline reply composer with avatar + textarea + primary Reply button | `clubhouse.jsx:336–348` | 🟡 single-line `<input>` + Reply button | 🟡 — uses `<input>` not `<textarea>`, no avatar |
| **Right rail** — Delegation Verified card | `clubhouse.jsx:358–384` (ClubhouseRail) | ❌ no right rail in app shell | ❌ |
| Right rail — Community Guidelines | `clubhouse.jsx:386–406` | ❌ | ❌ |
| Right rail — Upcoming Office Hours (event-row with date tile) | `clubhouse.jsx:408–435` | ❌ | ❌ |
| Right rail — Top Contributors (rank + avatar + count, "Your rank" footer) | `clubhouse.jsx:437–467` | ❌ | ❌ |

**Surface fidelity:** ~8%. The hero flow is essentially unbuilt.

### 3d. DRep Profile & Committee

| Element | Design ref | Live | Match |
|---|---|---|---|
| Page head H1 + Edit Profile button (right) | `profile.jsx:33–39` | 🟡 only in `ProfileSetup.tsx` for self; `DRepPublicProfile.tsx` has no header button | 🟡 |
| **Cover card** — gradient `bg-hero` + HeroDots + xl avatar + verified check + DRep ID chip + 3-stat grid | `profile.jsx:41–76` | ❌ absent — `DRepPublicProfile.tsx:42–49` is a plain card with title + member count | ❌ |
| Description / bio prose card | `profile.jsx:60–63` | 🟡 inline below title, not its own card | 🟡 |
| Social links (4 icon buttons: globe / twitter / discord / github) | `profile.jsx:65–74` | ❌ — `PublicProfilePage.tsx` shows raw text links | ❌ |
| **Committee table** (`com-table`) — Member / Role / Wallet / Expertise badges / Status | `profile.jsx:98–115` | 🟡 `DRepPublicProfile.tsx:54–72` shows simple list rows (name / role / joinedAt) | 🟡 — no expertise badges, no Status indicator dot, not table layout |
| Threshold setting "3 of 5 must approve" + Edit pencil | `profile.jsx:84–92` | ❌ absent | ❌ |
| Member Activity stream (last 8 events, avatar + name + action + time + colored kind dot) | `profile.jsx:120–138` | ❌ absent | ❌ |
| Recent Governance Positions mini-table (Action / Position / Committee Result / Outcome / Epoch) | `profile.jsx:144–176` | ❌ absent | ❌ |
| Delegator Overview (3 stats: Total / VP / Avg Stake) | `profile.jsx:183–187` | ❌ absent | ❌ |
| Sparkline (1-year stake trend, SVG line+area) | `profile.jsx:189–192` | ❌ absent — `Sparkline` primitive not built | ❌ |
| Trusted Delegator Badges card | `profile.jsx:193–202` | ❌ absent | ❌ |
| Recent clubhouse posts on public profile | (live addition) | ✅ `DRepPublicProfile.tsx:76–93` | live addition |
| Delegation history list | (live addition) | ✅ `PublicProfilePage.tsx:142–183` | live addition (different concept than the design's profile) |

**Surface fidelity:** ~15%.

---

## 4. Shared Chrome

| Element | Design ref | Live | Match |
|---|---|---|---|
| 3-column app grid (sidebar / center / right rail) | `styles.css:136–145` + `app.jsx:90–97` | 🟡 grid CSS exists, but `Layout.tsx:198` always passes `main--no-rail` | 🟡 |
| Topbar 60–64px sticky | `chrome.jsx:56–92`, `styles.css:147–158` | ✅ `Layout.tsx:82–158` uses same `.topbar` classes | ✅ |
| Brand mark on white tile + product wordmark | `chrome.jsx:61–67` | ✅ `Layout.tsx:84–102` | ✅ — exact pixel match (78% logo inset, both themes) |
| Global search (centered, max 480px, ⌘K kbd badge, search icon) | `chrome.jsx:68–72`, `styles.css:199–245` | 🟡 markup present in `Layout.tsx:104–122` but **no onChange / onSubmit** — purely decorative | 🟡 |
| Sync pill ("Synced 5 min ago" with pulsing dot) | `chrome.jsx:74–80` | ❌ absent from topbar | ❌ |
| Wallet pill (avatar + abbreviated address + chevron) | `chrome.jsx:81–85` | ✅ `Layout.tsx:127–144` | ✅ |
| Avatar dropdown with chevron | `chrome.jsx:86–89` | 🟡 click navigates to /profile/setup, no menu | 🟡 |
| Notification bell with red dot badge | spec | ❌ absent | ❌ |
| Sidebar 240px sticky | `chrome.jsx:17–51` | ✅ `Layout.tsx:161–195` | ✅ |
| Sidebar nav items (7) — Dashboard / Governance / Clubhouse / Committee / DReps / Rationales / Notifications | `chrome.jsx:7–15` | 🟡 5 items: Dashboard / Governance / Clubhouse / DReps / My Profile | 🟡 — missing **Committee**, **Rationales**, **Notifications** (badge=3) |
| Active nav 3px left brand-primary border | `styles.css:378–386` | ✅ inherited from same CSS | ✅ |
| Nav icons (16/18px lucide) | `chrome.jsx:25` | ❌ — nav items render label-only, no `Icon` | ❌ |
| Notification bell badge count `3` | `chrome.jsx:14` | ❌ no badge | ❌ |
| Epoch indicator card in sidebar footer | `chrome.jsx:33–48` | 🟡 present (`Layout.tsx:177–193`) but values hardcoded to "—" / "Synced from Blockfrost" | 🟡 |
| `View epoch info →` link | `chrome.jsx:41` | ❌ absent | ❌ |
| Document Library link | `chrome.jsx:43–47` | ❌ absent | ❌ |
| Mobile hamburger button | `chrome.jsx:58–60`, `styles.css:1561–1601` | ❌ — Layout doesn't render `.mobile-menu-btn` | ❌ |
| Mobile drawer transform/scrim | `styles.css:1561–1621`, `chrome.jsx:19` | ❌ no `sidebar--open` toggle wiring or scrim | ❌ |

---

## 5. Modals / Overlays

| Modal | Design ref | Live | Match |
|---|---|---|---|
| Modal primitive (backdrop, ESC, click-outside, animation) | `primitives.jsx:166–190`, `styles.css:844–891` | ❌ no `<Modal>` component anywhere | ❌ |
| **Connect Wallet** — 6-tile grid (Eternl / Lace / Nami / Yoroi / Nufi / Typhon) | spec line 382, `app.jsx:99–119` | 🟡 `WalletButton.tsx` shows a small dropdown of `useWalletList()` results, not a tiled modal grid | 🟡 |
| Wallet info modal (logo + addr + balance + voting power + Disconnect) | `app.jsx:99–119` | ❌ — disconnect happens inline | ❌ |
| **Share** modal (copy link + 4 social share buttons) | `app.jsx:121–139` | ❌ absent — no Share button on proposal | ❌ |
| **Cast Vote** modal (radio Yes/No/Abstain + helper + Sign and submit + re-sign step) | `app.jsx:141–173` | ❌ absent | ❌ |
| Re-sign nonce flow per spec §3.3 | spec | 🟡 `CommentForm.tsx:27–31` sends literal "dev-nonce" / "dev-sig" / "dev-key" | 🟡 — TODO marker present, not implemented |
| Toast system rendered (`<ToastStack/>` in tree) | `app.jsx:196`, `primitives.jsx:147–161` | ❌ — `useUiStore.addToast` is called from `WalletButton`, `CommentForm`, `ProfileSetup`, but **no component renders `state.toasts`**. Toasts are silently lost. | ❌ |
| Tweaks panel (light/dark toggle) | `tweaks-panel.jsx`, `app.jsx:175–193` | ❌ absent | ❌ — by design (it's a prototype host control), but the production-side equivalent (theme toggle in user menu, README §"Theme toggle") is also missing |
| Modal overlay backdrop blur + animation | `styles.css:844–873` | ✅ CSS exists | unused |

---

## 6. Components from `primitives.jsx`

These are the building blocks. shadcn equivalents count.

| Primitive | Design ref | Live equivalent | Match |
|---|---|---|---|
| `Icon` (60+ named SVGs, lucide-style) | `primitives.jsx:7–65` | `lucide-react` installed; only `Layout.tsx` inlines its own SVGs (search, wallet) | 🟡 — lucide is on the dep list but never imported. Each component hand-rolls its own SVGs |
| `BrandMark` | `primitives.jsx:70–74` | inline `<img>` in `Layout.tsx:85–97` | ✅ |
| `HeroDots` (concentric ring SVG) | `primitives.jsx:79–93` | ❌ never imported / never built | ❌ |
| `Avatar` (deterministic colored initials, sm/md/lg/xl, verified check overlay) | `primitives.jsx:113–122` | 🟡 — only used in `Layout.tsx:151` (hardcoded `--brand-primary` background) and `PublicProfilePage.tsx:58` (hardcoded `#0033AD`); no deterministic color hash, no `verified` prop | 🟡 |
| `Tip` (tooltip on hover, dark surface, arrow) | `primitives.jsx:127–132`, CSS at `styles.css:805–838` | ❌ — CSS exists, no React component, `@radix-ui/react-tooltip` not installed (Dialog/Dropdown/Tabs/Toast are, Tooltip is not) | ❌ |
| `Modal` | `primitives.jsx:166–190` | ❌ — `@radix-ui/react-dialog` installed, never used | ❌ |
| `ToastStack` + `useToasts` | `primitives.jsx:137–161` | 🟡 — `uiStore.addToast` exists, no renderer; `@radix-ui/react-toast` installed, never used | 🟡 |
| `Donut` (SVG 4-segment chart) | `primitives.jsx:193–217` | ❌ | ❌ |
| `Sparkline` (line + area SVG) | `primitives.jsx:220–243` | ❌ | ❌ |
| `fmtNum` ("M" / "K" abbrevs) | `primitives.jsx:246–250` | ❌ — `formatRelativeTime`, `formatWalletAddress` exist in `lib/utils.ts`, but no big-number formatter | ❌ |
| Pills `.pill--*` (10 variants) | `styles.css:636–656` | 🟡 — CSS exists, but components use Tailwind utilities like `bg-green-100 text-green-800` instead | 🟡 |
| Gold-star Recognized badge | `styles.css:658–679` | ❌ — class exists, never rendered | ❌ |
| Buttons `.btn--primary/secondary/ghost/sm/xs/icon` | `styles.css:691–731` | 🟡 — CSS exists; components use raw Tailwind `bg-primary text-primary-foreground` etc. | 🟡 |
| Tabs `.tab--active::after` underline | `styles.css:737–777` | 🟡 — used inline in `GovernanceListPage.tsx` for status tabs (re-implemented with Tailwind `border-primary -mb-px`) | 🟡 |
| Form inputs `.input/.select/.textarea` | `styles.css:783–799` | 🟡 — CSS exists, components use Tailwind | 🟡 |

---

## Per-Surface Fidelity (rough)

Counting design-specified elements per surface, full credit for ✅, half for 🟡, zero for ❌.

| Surface | Elements counted | Fidelity |
|---|---|---|
| Design tokens | 14 rows | ~95% |
| Light/dark mode | 7 rows | ~14% (tokens only) |
| Dashboard | 10 rows | ~10% |
| Governance list | 7 rows | ~50% |
| Governance detail | 14 rows | ~18% |
| Delegator Clubhouse | 16 rows | ~9% |
| DRep Profile & Committee | 12 rows | ~17% |
| Shared chrome (sidebar / topbar) | 16 rows | ~50% |
| Modals / overlays | 8 rows | ~6% |
| Primitives | 14 rows | ~25% |

**Weighted overall** (Clubhouse 30%, Dashboard 20%, Governance detail 15%, Governance list 10%, Profile 5%, Chrome 10%, Modals 5%, Primitives 5%): **~22% fidelity**. Tokens carry the score; component-level work is heavily under-built.

---

## Top 10 Build List (prioritized)

| # | Gap | Design ref | Where to build in live | Effort |
|---|---|---|---|---|
| 1 | Render the toast stack — toasts are added but never displayed | `primitives.jsx:147–161`, `app.jsx:196` | New `<Toaster />` in `App.tsx` (use `@radix-ui/react-toast`, already installed) reading `useUiStore().toasts`; or a hand-rolled `.toast-stack` div in `Layout.tsx` | S |
| 2 | Build Clubhouse composer with type selector (Discussion/Question/Poll) and poll-option editor | `clubhouse.jsx:178–215`, `:79–84` | `pages/DelegatorClubhouse.tsx` — extract `<Composer/>` with kind chips and conditional poll editor | M |
| 3 | Build poll rendering + voting (animated bars, optimistic update, "You voted" check) | `clubhouse.jsx:276–297` | `pages/DelegatorClubhouse.tsx`'s `PostCard` + new `useVotePoll` hook | M |
| 4 | Comment header — name → **gold-star Recognized** → stake pill → DRep pill → time | `governance.jsx:294–305`, `styles.css:658–679` | `components/CommentList.tsx:50–64` — add `comment.starred`, `comment.stakeAda`, `comment.drep` to type and render pills | M |
| 5 | Governance detail tabs (Overview / Public Comments / Delegator Clubhouse / Rationale) + section reorganization | `governance.jsx:142–153` | `pages/GovernanceActionPage.tsx` — wrap content in `@radix-ui/react-tabs` (installed) | M |
| 6 | Donut chart primitive + On-Chain Votes / Delegator Sentiment dual sections (4-card stack + 140px donut + legend, hairline-separated) | `primitives.jsx:193–217`, `governance.jsx:174–271` | New `components/Donut.tsx`; new `components/SentimentBlock.tsx` reused in proposal detail and dashboard rail | L |
| 7 | Three-column app shell with right-rail support + per-page rails (Dashboard / Proposal / Clubhouse) | `styles.css:466–491`, all `*Rail` components | `components/Layout.tsx:198` accept `rail` prop; remove forced `main--no-rail`; new rail components per page | L |
| 8 | Theme toggle wired to `data-theme` + `localStorage` + `themeStore` | spec line 432, `app.jsx:20–22` | New `stores/themeStore.ts`; toggle button in topbar avatar dropdown; sync to `document.documentElement.dataset.theme` in `App.tsx` `useEffect` | S |
| 9 | Dashboard hero band + 4-stat grid + Hot Actions table with sentiment-bar column | `dashboard.jsx:35–112` | Rewrite `pages/DRepDashboard.tsx` and `pages/DelegatorDashboard.tsx`; reuse new sentiment-bar component | L |
| 10 | Mobile sidebar drawer (hamburger button + scrim + transform) and collapsing right rail | `chrome.jsx:58–60`, `styles.css:1561–1621` | `components/Layout.tsx` — add `mobileOpen` state, `.mobile-menu-btn` button, `.scrim`, `useUiStore.toggleSidebar` | M |

---

## Other Notable Issues (out of top 10 but worth flagging)

- **Tailwind theme extension is missing.** Components reference `bg-cardano-blue`, `border-cardano-blue/30`, `bg-blue-50/30` but `tailwind.config.*` is not under `src/` and these utilities likely render to nothing. CSS tokens never bridge into Tailwind. Add a `theme.extend.colors` mapping `brand-primary: 'var(--brand-primary)'` etc.
- **Lucide-react is installed but never imported.** Every SVG in `Layout.tsx` is hand-rolled. Either commit to lucide (smaller bundle, consistent strokes) or remove the dependency.
- **shadcn primitives are installed (radix dialog/dropdown/tabs/toast/avatar/label) but never used.** Either scaffold the `components/ui/*` files or remove the deps. The README explicitly directs the team toward shadcn.
- **`Layout.tsx` topbar `<input>` for search has no `onChange`/`onSubmit`.** It is decorative — same shape as design but doesn't search.
- **Governance status colors don't use brand tokens.** `STATUS_CLASSES` in `GovernanceActionCard.tsx:11–16` uses `bg-green-100 text-green-800` etc. Design wants `pill--passed` (`--success-soft` / `--success`).
- **"DReps" sidebar item uses href `/drep`** which is not a route — `App.tsx:46` only registers `/drep/:drepId`. Clicking goes to a 404 fallback that redirects to `/`.
- **`uiStore.isWalletModalOpen`** is declared but no component opens or renders it. Dead state.
- **README rule #6: "Brand color is Cardano Blue `#0033AD` — do not use generic indigo / violet / purple anywhere."** `styles.css:46` and `design-system.css:46` define `--shadow-focus: 0 0 0 3px rgba(79, 70, 229, 0.12)` — that's indigo (`#4F46E5`). Both files inherit the bug from the design source. Worth flagging to the design team.
- **`AVATAR_COLORS` in design uses indigo/violet/pink** which the README says to avoid; the live `Avatar` is hardcoded to `--brand-primary` only — that's actually the safer choice, but loses the deterministic-color visual variety. Trade-off.
- **`CommentForm.tsx` posts `mutationNonce: 'dev-nonce'`** (line 30) — explicit dev shortcut. The README and Phase 1 spec require a real re-sign nonce flow before any production deploy. Flag for security review.

---

## Bottom line

The visual layer (CSS variables, layout grid, the dark-mode block) is **copy-pasted in**. The component layer is **~80% missing**. The platform is functional — wallet auth, governance fetch, comments — but it doesn't yet **look or feel** like the design. The four hero surfaces in particular need the right rail, the donut/sentiment block, the proper Clubhouse composer with polls, and the comment-header pill stack with the gold-star Recognized badge before the team can claim parity.

Files touched in the audit (no edits made):
- Read: every file in `/Users/admin/Documents/Claude/Projects/DRep Collaboration Platform/style-assets/design_handoff_drep_platform/design_files/` and every `.tsx`/`.ts` file in `/Users/admin/Developer/drep-platform/frontend/src/pages/`, `/components/`, `/stores/`, `/auth/`, `/lib/`, plus `App.tsx`, `main.tsx`, `index.css`, `styles/design-system.css`.
- Wrote: this report only (`/Users/admin/Developer/drep-platform/DESIGN_PARITY_STRUCTURAL.md`).
