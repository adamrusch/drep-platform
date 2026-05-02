import React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Home,
  FileText,
  MessageSquare,
  Shield,
  Users,
  Lightbulb,
  Bell,
  Sun,
  Moon,
  Search,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { useAuthStore, useIsAuthenticated } from '@/stores/authStore';
import { useUiStore } from '@/stores/uiStore';
import { useThemeStore } from '@/stores/themeStore';
import { WalletButton } from './WalletButton';
import { cn, formatWalletAddress } from '@/lib/utils';
import type { UserRole } from '@/types';

interface LayoutProps {
  children: React.ReactNode;
}

interface NavItem {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  match: (path: string) => boolean;
  roles?: UserRole[];
  badge?: number;
}

const NAV_ITEMS: NavItem[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    href: '/dashboard',
    icon: Home,
    match: (p) => p === '/' || p.startsWith('/dashboard'),
    roles: ['delegator', 'committee_member', 'lead_drep', 'trusted_delegator'],
  },
  {
    id: 'governance',
    label: 'Governance Actions',
    href: '/governance',
    icon: FileText,
    match: (p) => p.startsWith('/governance'),
  },
  {
    id: 'clubhouse',
    label: 'Delegator Clubhouse',
    href: '/clubhouse',
    icon: MessageSquare,
    match: (p) => p.startsWith('/clubhouse') || (p.startsWith('/drep') && p.includes('/delegators')),
  },
  {
    id: 'committee',
    label: 'Committee',
    href: '/committee',
    icon: Shield,
    match: (p) => p.startsWith('/committee'),
  },
  {
    id: 'dreps',
    label: 'DReps',
    href: '/dreps',
    icon: Users,
    match: (p) => p === '/dreps' || (p.startsWith('/drep') && !p.includes('/delegators')),
  },
  {
    id: 'rationales',
    label: 'Rationales',
    href: '/rationales',
    icon: Lightbulb,
    match: (p) => p.startsWith('/rationales'),
  },
  {
    id: 'notifications',
    label: 'Notifications',
    href: '/notifications',
    icon: Bell,
    match: (p) => p.startsWith('/notifications'),
  },
];

export function Layout({ children }: LayoutProps): React.ReactElement {
  const walletAddress = useAuthStore((s) => s.walletAddress);
  const profile = useAuthStore((s) => s.profile);
  const isAuthenticated = useIsAuthenticated();
  useUiStore();
  const location = useLocation();
  const navigate = useNavigate();
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggle);

  // Show all 7 nav items to everyone — guest visitors can see Dashboard
  // (it redirects to wallet connect under the hood). Hiding nav items
  // hides primary surfaces and is what the audit flagged. Routes are still
  // protected by RoleGuard, so revealing the chrome is safe.
  const visibleNav = NAV_ITEMS;

  const displayInitials =
    profile?.displayName
      ?.split(' ')
      .map((p) => p[0])
      .slice(0, 2)
      .join('')
      .toUpperCase() ??
    (walletAddress ? walletAddress.slice(0, 2).toUpperCase() : '??');

  return (
    <div className="app">
      {/* Topbar */}
      <header className="topbar">
        <div className="topbar__brand">
          <Link to="/" className="brand-mark" aria-label="Cardano DRep">
            <img
              src="/cardano-logo.png"
              alt="Cardano"
              width={36}
              height={36}
              style={{
                width: '78%',
                height: '78%',
                objectFit: 'contain',
                display: 'block',
              }}
            />
          </Link>
          <div className="brand-name">
            Cardano DRep
            <span className="brand-name__sub">Coordination Platform</span>
          </div>
        </div>

        <div className="topbar__search">
          <Search
            className="topbar__search-icon"
            size={16}
            strokeWidth={1.75}
            aria-hidden="true"
          />
          <input placeholder="Search proposals, DReps, topics…" />
          <span className="kbd">⌘K</span>
        </div>

        <div className="topbar__actions">
          <button
            type="button"
            onClick={toggleTheme}
            aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
            title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
            className={cn(
              'inline-flex items-center justify-center w-[38px] h-[38px]',
              'rounded-token-md text-[var(--text-secondary)]',
              'transition-colors hover:bg-[var(--bg-muted)] hover:text-[var(--text-primary)]',
            )}
          >
            {theme === 'light' ? (
              <Moon size={18} strokeWidth={1.75} />
            ) : (
              <Sun size={18} strokeWidth={1.75} />
            )}
          </button>
          {isAuthenticated && walletAddress ? (
            <>
              <button
                className="wallet-pill"
                type="button"
                onClick={() => navigate('/profile/setup')}
              >
                <Wallet size={16} strokeWidth={1.75} aria-hidden="true" />
                <span>{formatWalletAddress(walletAddress, 6)}</span>
              </button>
              <button
                className="avatar-btn"
                type="button"
                onClick={() => navigate('/profile/setup')}
                aria-label="Open profile menu"
              >
                <span className="avatar avatar--sm">{displayInitials}</span>
              </button>
            </>
          ) : (
            <WalletButton />
          )}
        </div>
      </header>

      {/* Sidebar */}
      <aside className="sidebar">
        <nav className="nav">
          {visibleNav.map((item) => {
            const Icon = item.icon;
            const isActive = item.match(location.pathname);
            return (
              <Link
                key={item.id}
                to={item.href}
                className={cn('nav__item', isActive && 'nav__item--active')}
              >
                <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
                <span>{item.label}</span>
                {item.badge !== undefined && (
                  <span className="nav__item-badge">{item.badge}</span>
                )}
              </Link>
            );
          })}
        </nav>
        <div className="sidebar__footer">
          <div className="epoch-card">
            <div className="epoch-card__row">
              <span>Network</span>
              <span>
                <span className="network-dot" />
                Mainnet
              </span>
            </div>
            <div
              className="epoch-card__row"
              style={{ marginTop: 10, marginBottom: 0 }}
            >
              <span>Epoch</span>
            </div>
            <div className="epoch-card__num">—</div>
            <div className="epoch-card__sub">Synced from Blockfrost</div>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="main main--no-rail">{children}</main>
    </div>
  );
}
