import React, { useMemo, useState } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../AuthContext.jsx';
import { useLeague } from '../LeagueContext.jsx';
import {
  canAccessMockDraft,
  canAccessKeeperCeremony,
  canAccessTradeAnalyzer,
  canAccessKeepers,
  canAccessRules,
  canAccessGuestBrowse,
} from '../config.js';
import BottomSheet from './BottomSheet.jsx';
import './Nav.css';

const memberPrimaryItems = [
  { to: '/', label: 'Home', icon: HomeIcon, end: true },
  { to: '/me', label: 'My team', icon: MyTeamIcon },
  { to: '/rankings', label: 'Rankings', icon: RankingsIcon },
  { to: '/mock-draft', label: 'Mock draft', icon: DraftIcon, requires: 'mockDraft' },
];

const memberOverflowItems = [
  { to: '/stats', label: 'Stats', icon: StatsIcon },
  { to: '/trades', label: 'Trades', icon: TradeIcon, requires: 'trades' },
  { to: '/drafts', label: 'Draft', icon: DraftIcon },
  { to: '/keepers', label: 'Keepers', icon: KeeperIcon, requires: 'keepers' },
  { to: '/keeper-ceremony', label: 'Ceremony', icon: CeremonyIcon, requires: 'ceremony' },
  { to: '/rules', label: 'Rules', icon: RulesIcon, requires: 'rules' },
];

const guestPrimaryItems = [
  { to: '/', label: 'Home', icon: HomeIcon, end: true },
  { to: '/rankings', label: 'Rankings', icon: RankingsIcon },
  { to: '/stats', label: 'Stats', icon: StatsIcon },
  { to: '/trades', label: 'Trades', icon: TradeIcon, requires: 'trades' },
];

const guestOverflowItems = [{ to: '/drafts', label: 'Draft', icon: DraftIcon }];

function itemVisible(item, user, devBypass, isGuest) {
  if (item.requires === 'mockDraft') return canAccessMockDraft(user, devBypass, isGuest);
  if (item.requires === 'ceremony') return canAccessKeeperCeremony(user, devBypass, isGuest);
  if (item.requires === 'trades') return canAccessTradeAnalyzer(user, devBypass, isGuest);
  if (item.requires === 'keepers') return canAccessKeepers(isGuest);
  if (item.requires === 'rules') return canAccessRules(isGuest);
  return true;
}

export default function Nav() {
  const { authEnabled, authenticated, devBypass, refresh, user } = useAuth();
  const { isGuest, exitGuestLeague, guestLeagueName } = useLeague();
  const navigate = useNavigate();
  const location = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const hasRealSession = authenticated && !devBypass;
  const showLogout = authEnabled && hasRealSession && !isGuest;
  const showExitGuest = isGuest;
  const showBrowse =
    !isGuest &&
    location.pathname !== '/login' &&
    canAccessGuestBrowse(user, devBypass, { hasRealSession: Boolean(hasRealSession) });

  const primaryVisible = useMemo(() => {
    const items = isGuest ? guestPrimaryItems : memberPrimaryItems;
    return items.filter((item) => itemVisible(item, user, devBypass, isGuest));
  }, [user, devBypass, isGuest]);

  const overflowVisible = useMemo(() => {
    const items = isGuest ? guestOverflowItems : memberOverflowItems;
    return items.filter((item) => itemVisible(item, user, devBypass, isGuest));
  }, [user, devBypass, isGuest]);

  const overflowPaths = useMemo(() => new Set(overflowVisible.map((i) => i.to)), [overflowVisible]);

  const moreActive = useMemo(() => overflowPaths.has(location.pathname), [location.pathname, overflowPaths]);

  async function onLogout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } finally {
      // Stale guest browse storage would make Login treat us as still "in" and bounce to /.
      exitGuestLeague();
      await refresh();
      navigate('/login', { replace: true });
    }
  }

  function onExitGuest() {
    exitGuestLeague();
    navigate(hasRealSession ? '/' : '/login', { replace: true });
  }

  const navExtra = showLogout || showExitGuest || showBrowse;

  return (
    <nav className={'bottom-nav' + (navExtra ? ' bottom-nav--auth' : '')} aria-label="Primary">
      {isGuest && guestLeagueName ? (
        <p className="nav-guest-banner" title={guestLeagueName}>
          Browsing <strong>{guestLeagueName}</strong>
        </p>
      ) : null}
      <ul>
        {primaryVisible.map(({ to, label, icon: Icon, end }) => (
          <li key={to}>
            <NavLink
              to={to}
              end={end}
              className={({ isActive }) => 'tab' + (isActive ? ' active' : '')}
            >
              <Icon />
              <span>{label}</span>
            </NavLink>
          </li>
        ))}
        {overflowVisible.length > 0 && (
          <li>
            <button
              type="button"
              className={'tab tab-more' + (moreActive ? ' active' : '')}
              aria-expanded={moreOpen}
              aria-haspopup="dialog"
              aria-controls="nav-more-sheet"
              aria-label="More navigation"
              onClick={() => setMoreOpen(true)}
            >
              <MoreIcon />
              <span>More</span>
            </button>
          </li>
        )}
        {showLogout && (
          <li>
            <button type="button" className="tab tab-logout" onClick={onLogout}>
              <LogoutIcon />
              <span>Log out</span>
            </button>
          </li>
        )}
        {showExitGuest && (
          <li>
            <button type="button" className="tab tab-logout" onClick={onExitGuest}>
              <LogoutIcon />
              <span>Exit</span>
            </button>
          </li>
        )}
        {showBrowse && (
          <li>
            <NavLink
              to="/login"
              className={({ isActive }) => 'tab' + (isActive ? ' active' : '')}
            >
              <BrowseIcon />
              <span>Browse</span>
            </NavLink>
          </li>
        )}
      </ul>

      <BottomSheet open={moreOpen} onClose={() => setMoreOpen(false)} title="More">
        <div id="nav-more-sheet">
          <ul className="nav-more-list">
            {overflowVisible.map(({ to, label, icon: Icon }) => (
              <li key={to}>
                <NavLink
                  to={to}
                  className={({ isActive }) => 'nav-more-link' + (isActive ? ' nav-more-link--active' : '')}
                  onClick={() => setMoreOpen(false)}
                >
                  <Icon />
                  <span>{label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      </BottomSheet>
    </nav>
  );
}

function LogoutIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

function BrowseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
    </svg>
  );
}

function MyTeamIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M6 20v-1a6 6 0 0 1 12 0v1" />
    </svg>
  );
}

function HomeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 11l9-8 9 8" />
      <path d="M5 10v10h14V10" />
    </svg>
  );
}

function StatsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 3v18h18" />
      <path d="M7 15l4-4 3 3 5-6" />
    </svg>
  );
}

function DraftIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      <path d="M8 7h8M8 11h8M8 15h4" />
    </svg>
  );
}

function KeeperIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l2.4 4.9L20 9.3l-4 3.9.9 5.6L12 16.9 7.1 18.8 8 13.2 4 9.3l5.6-1.4L12 3z" />
    </svg>
  );
}

function CeremonyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3v9l6.5 3.5" />
    </svg>
  );
}

function RulesIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 4h9l4 4v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
      <path d="M14 4v5h5" />
      <path d="M9 14h6" />
      <path d="M9 18h4" />
    </svg>
  );
}

function RankingsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20V10" />
      <path d="M10 20V4" />
      <path d="M16 20v-7" />
      <path d="M22 20H2" />
    </svg>
  );
}

function TradeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M16 3h5v5" />
      <path d="M8 21H3v-5" />
      <path d="M21 3l-7 7" />
      <path d="M3 21l7-7" />
    </svg>
  );
}
