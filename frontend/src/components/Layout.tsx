import React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { useUiStore } from '@/stores/uiStore';
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
  match: (path: string) => boolean;
  roles?: UserRole[];
  badge?: number;
}

const NAV_ITEMS: NavItem[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    href: '/dashboard',
    match: (p) => p === '/' || p.startsWith('/dashboard'),
    roles: ['delegator', 'committee_member', 'lead_drep', 'trusted_delegator'],
  },
  {
    id: 'governance',
    label: 'Governance Actions',
    href: '/governance',
    match: (p) => p.startsWith('/governance'),
  },
  {
    id: 'clubhouse',
    label: 'Delegator Clubhouse',
    href: '/drep',
    match: (p) => p.startsWith('/drep') && p.includes('/delegators'),
  },
  {
    id: 'profile',
    label: 'DReps',
    href: '/drep',
    match: (p) => p.startsWith('/drep') && !p.includes('/delegators'),
  },
  {
    id: 'me',
    label: 'My Profile',
    href: '/profile/setup',
    match: (p) => p.startsWith('/profile'),
    roles: ['delegator', 'committee_member', 'lead_drep', 'trusted_delegator'],
  },
];

export function Layout({ children }: LayoutProps): React.ReactElement {
  const { roles, walletAddress, isAuthenticated, profile } = useAuthStore();
  useUiStore();
  const location = useLocation();
  const navigate = useNavigate();

  const visibleNav = NAV_ITEMS.filter(
    (item) => !item.roles || item.roles.some((r) => roles.includes(r)),
  );

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
          <svg
            className="topbar__search-icon"
            width={16}
            height={16}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input placeholder="Search proposals, DReps, topics…" />
          <span className="kbd">⌘K</span>
        </div>

        <div className="topbar__actions">
          {isAuthenticated && walletAddress ? (
            <>
              <button className="wallet-pill" type="button" onClick={() => navigate('/profile/setup')}>
                <svg
                  width={16}
                  height={16}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.75}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M21 12V7a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h16v2" />
                  <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
                  <circle cx="17" cy="14" r="1.5" fill="currentColor" />
                </svg>
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
          {visibleNav.map((item) => (
            <Link
              key={item.id}
              to={item.href}
              className={cn('nav__item', item.match(location.pathname) && 'nav__item--active')}
            >
              <span>{item.label}</span>
              {item.badge !== undefined && (
                <span className="nav__item-badge">{item.badge}</span>
              )}
            </Link>
          ))}
        </nav>
        <div className="sidebar__footer">
          <div className="epoch-card">
            <div className="epoch-card__row">
              <span>Network</span>
              <span>
                <span className="network-dot" />
                Preview
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
