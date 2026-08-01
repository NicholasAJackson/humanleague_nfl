import React, { Suspense, lazy } from 'react';
import { Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import Nav from './components/Nav.jsx';
import { AuthProvider, useAuth } from './AuthContext.jsx';
import { canAccessMockDraft, canAccessKeeperCeremony } from './config.js';

const Home = lazy(() => import('./pages/Home.jsx'));
const Stats = lazy(() => import('./pages/Stats.jsx'));
const Wheel = lazy(() => import('./pages/Wheel.jsx'));
const Rules = lazy(() => import('./pages/Rules.jsx'));
const Drafts = lazy(() => import('./pages/Drafts.jsx'));
const MockDraft = lazy(() => import('./pages/MockDraft.jsx'));
const Keepers = lazy(() => import('./pages/Keepers.jsx'));
const KeeperCeremony = lazy(() => import('./pages/KeeperCeremony.jsx'));
const Rankings = lazy(() => import('./pages/Rankings.jsx'));
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

function RequireAuth() {
  const { ready, authenticated, authEnabled } = useAuth();
  const location = useLocation();

  if (!ready) {
    return <PageFallback />;
  }
  if (authEnabled && !authenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  return <Outlet />;
}

function AppLayout() {
  return (
    <>
      <Nav />
      <main className="app-shell">
        <Suspense fallback={<PageFallback />}>
          <Outlet />
        </Suspense>
      </main>
    </>
  );
}

function MockDraftOnly({ children }) {
  const { ready, user, devBypass } = useAuth();
  if (!ready) return <PageFallback />;
  if (!canAccessMockDraft(user, devBypass)) return <Navigate to="/" replace />;
  return children;
}

function CeremonyOnly({ children }) {
  const { ready, user, devBypass } = useAuth();
  if (!ready) return <PageFallback />;
  if (!canAccessKeeperCeremony(user, devBypass)) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <AuthProvider>
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
          <Route element={<RequireAuth />}>
            <Route path="/" element={<Home />} />
            <Route path="/stats" element={<Stats />} />
            <Route path="/insights" element={<Navigate to="/stats" replace />} />
            <Route path="/h2h" element={<Navigate to="/stats" replace />} />
            <Route path="/wheel" element={<Wheel />} />
            <Route path="/rules" element={<Rules />} />
            <Route path="/drafts" element={<Drafts />} />
            <Route
              path="/mock-draft"
              element={
                <MockDraftOnly>
                  <MockDraft />
                </MockDraftOnly>
              }
            />
            <Route path="/keepers" element={<Keepers />} />
            <Route
              path="/keeper-ceremony"
              element={
                <CeremonyOnly>
                  <KeeperCeremony />
                </CeremonyOnly>
              }
            />
            <Route path="/rankings" element={<Rankings />} />
            <Route path="/me" element={<MyTeam />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Route>
      </Routes>
    </AuthProvider>
  );
}
