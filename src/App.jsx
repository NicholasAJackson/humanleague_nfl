import React, { Suspense, lazy } from 'react';
import { Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import Nav from './components/Nav.jsx';
import { AuthProvider, useAuth } from './AuthContext.jsx';
import { LeagueProvider, useLeague } from './LeagueContext.jsx';
import {
  canAccessMockDraft,
  canAccessKeeperCeremony,
  canAccessTradeAnalyzer,
  canAccessKeepers,
  canAccessRules,
  isGuestAllowedPath,
} from './config.js';

const Home = lazy(() => import('./pages/Home.jsx'));
const Stats = lazy(() => import('./pages/Stats.jsx'));
const Wheel = lazy(() => import('./pages/Wheel.jsx'));
const Rules = lazy(() => import('./pages/Rules.jsx'));
const Drafts = lazy(() => import('./pages/Drafts.jsx'));
const MockDraft = lazy(() => import('./pages/MockDraft.jsx'));
const Keepers = lazy(() => import('./pages/Keepers.jsx'));
const KeeperCeremony = lazy(() => import('./pages/KeeperCeremony.jsx'));
const Rankings = lazy(() => import('./pages/Rankings.jsx'));
const TradeAnalyzer = lazy(() => import('./pages/TradeAnalyzer.jsx'));
const MyTeam = lazy(() => import('./pages/MyTeam.jsx'));
const Login = lazy(() => import('./pages/Login.jsx'));

function PageFallback() {
  return (
    <div className="page">
      <div className="skeleton" style={{ height: 28, width: '40%' }} />
      <div className="skeleton" style={{ height: 18, width: '70%' }} />
      <div className="card-grid" style={{ marginTop: 12 }}>
        <div className="skeleton" style={{ height: 120 }} />
        <div className="skeleton" style={{ height: 120 }} />
        <div className="skeleton" style={{ height: 120 }} />
      </div>
    </div>
  );
}

/** Signed-in members, or guests with a pasted Sleeper league id. */
function RequireAccess() {
  const { ready, authenticated, authEnabled } = useAuth();
  const { isGuest } = useLeague();
  const location = useLocation();

  if (!ready) {
    return <PageFallback />;
  }
  if (authEnabled && !authenticated && !isGuest) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  return <Outlet />;
}

/** Human League member features — not available in guest browse mode. */
function MembersOnly({ children }) {
  const { isGuest } = useLeague();
  if (isGuest) return <Navigate to="/" replace />;
  return children;
}

function GuestRouteGuard() {
  const { isGuest } = useLeague();
  const location = useLocation();
  if (isGuest && !isGuestAllowedPath(location.pathname)) {
    return <Navigate to="/" replace />;
  }
  return <Outlet />;
}

function AppLayout() {
  const { isGuest } = useLeague();
  return (
    <>
      <Nav />
      <main className={'app-shell' + (isGuest ? ' app-shell--guest' : '')}>
        <Suspense fallback={<PageFallback />}>
          <Outlet />
        </Suspense>
      </main>
    </>
  );
}

function MockDraftOnly({ children }) {
  const { ready, user, devBypass } = useAuth();
  const { isGuest } = useLeague();
  if (!ready) return <PageFallback />;
  if (!canAccessMockDraft(user, devBypass, isGuest)) return <Navigate to="/" replace />;
  return children;
}

function CeremonyOnly({ children }) {
  const { ready, user, devBypass } = useAuth();
  const { isGuest } = useLeague();
  if (!ready) return <PageFallback />;
  if (!canAccessKeeperCeremony(user, devBypass, isGuest)) return <Navigate to="/" replace />;
  return children;
}

function TradeAnalyzerOnly({ children }) {
  const { ready, user, devBypass } = useAuth();
  const { isGuest } = useLeague();
  if (!ready) return <PageFallback />;
  if (!canAccessTradeAnalyzer(user, devBypass, isGuest)) return <Navigate to="/" replace />;
  return children;
}

function KeepersOnly({ children }) {
  const { ready } = useAuth();
  const { isGuest } = useLeague();
  if (!ready) return <PageFallback />;
  if (!canAccessKeepers(isGuest)) return <Navigate to="/" replace />;
  return children;
}

function RulesOnly({ children }) {
  const { ready } = useAuth();
  const { isGuest } = useLeague();
  if (!ready) return <PageFallback />;
  if (!canAccessRules(isGuest)) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <AuthProvider>
      <LeagueProvider>
        <Routes>
          <Route
            path="/login"
            element={
              <Suspense fallback={<PageFallback />}>
                <Login />
              </Suspense>
            }
          />
          <Route element={<AppLayout />}>
            <Route element={<RequireAccess />}>
              <Route element={<GuestRouteGuard />}>
                <Route path="/" element={<Home />} />
                <Route path="/stats" element={<Stats />} />
                <Route path="/insights" element={<Navigate to="/stats" replace />} />
                <Route path="/h2h" element={<Navigate to="/stats" replace />} />
                <Route
                  path="/wheel"
                  element={
                    <MembersOnly>
                      <Wheel />
                    </MembersOnly>
                  }
                />
                <Route
                  path="/rules"
                  element={
                    <MembersOnly>
                      <RulesOnly>
                        <Rules />
                      </RulesOnly>
                    </MembersOnly>
                  }
                />
                <Route path="/drafts" element={<Drafts />} />
                <Route
                  path="/mock-draft"
                  element={
                    <MembersOnly>
                      <MockDraftOnly>
                        <MockDraft />
                      </MockDraftOnly>
                    </MembersOnly>
                  }
                />
                <Route
                  path="/keepers"
                  element={
                    <MembersOnly>
                      <KeepersOnly>
                        <Keepers />
                      </KeepersOnly>
                    </MembersOnly>
                  }
                />
                <Route
                  path="/keeper-ceremony"
                  element={
                    <MembersOnly>
                      <CeremonyOnly>
                        <KeeperCeremony />
                      </CeremonyOnly>
                    </MembersOnly>
                  }
                />
                <Route path="/rankings" element={<Rankings />} />
                <Route
                  path="/trades"
                  element={
                    <TradeAnalyzerOnly>
                      <TradeAnalyzer />
                    </TradeAnalyzerOnly>
                  }
                />
                <Route
                  path="/me"
                  element={
                    <MembersOnly>
                      <MyTeam />
                    </MembersOnly>
                  }
                />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Route>
          </Route>
        </Routes>
      </LeagueProvider>
    </AuthProvider>
  );
}
