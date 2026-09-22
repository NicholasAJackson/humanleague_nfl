import React, { useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext.jsx';
import { useLeague } from '../LeagueContext.jsx';
import { canAccessGuestBrowse, DEV_LOGIN_SCREEN } from '../config.js';
import './Login.css';

async function fetchAuthConfig() {
  const res = await fetch('/api/auth/config');
  if (!res.ok) return null;
  return res.json();
}

export default function Login() {
  const { ready, authenticated, authEnabled, devBypass, user, refresh } = useAuth();
  const { enterGuestLeague, exitGuestLeague, isGuest, leagueId: activeLeagueId } = useLeague();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [modes, setModes] = useState(null);
  const [guestId, setGuestId] = useState('');
  const [guestError, setGuestError] = useState('');
  const [guestSubmitting, setGuestSubmitting] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from?.pathname || '/';

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cfg = await fetchAuthConfig();
      if (!cancelled && cfg) setModes(cfg);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Prefill when changing league while already browsing.
  useEffect(() => {
    if (isGuest && activeLeagueId && !guestId) {
      setGuestId(activeLeagueId);
    }
  }, [isGuest, activeLeagueId, guestId]);

  const hasRealSession = authenticated && !devBypass;
  const guestOnlyDevScreen = DEV_LOGIN_SCREEN && !authEnabled;
  const showGuestBrowse = canAccessGuestBrowse(user, devBypass, { hasRealSession });
  const showSignIn = !guestOnlyDevScreen && !hasRealSession;

  if (ready && !authEnabled && !DEV_LOGIN_SCREEN) {
    return <Navigate to="/" replace />;
  }
  // Signed-in users without browse would bounce home; browse is open to everyone.
  if (ready && hasRealSession && !showGuestBrowse) {
    return <Navigate to={from === '/login' ? '/' : from} replace />;
  }

  const userLogin = Boolean(modes?.userAccountsLogin);
  const siteLogin = Boolean(modes?.sitePasswordLogin);
  const usernameRequired = userLogin && !siteLogin;

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    const u = username.trim();
    try {
      if (usernameRequired && u.length < 2) {
        setError('Enter your username');
        return;
      }
      const body = { password };
      if (u.length >= 2) body.username = u;

      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Login failed');
        return;
      }
      exitGuestLeague();
      await refresh();
      navigate(from === '/login' ? '/' : from, { replace: true });
    } catch {
      setError('Could not reach the server. Use `npx vercel dev` locally so /api runs.');
    } finally {
      setSubmitting(false);
    }
  }

  async function onBrowse(e) {
    e.preventDefault();
    setGuestError('');
    setGuestSubmitting(true);
    try {
      await enterGuestLeague(guestId);
      navigate('/', { replace: true });
    } catch (err) {
      setGuestError(err?.message || 'Could not load that league.');
    } finally {
      setGuestSubmitting(false);
    }
  }

  function onReturnHumanLeague() {
    exitGuestLeague();
    navigate('/', { replace: true });
  }

  let lead =
    'Sign in to open the Human League hub, or paste any Sleeper league ID to browse stats, trades, and your team’s waiver values.';
  if (guestOnlyDevScreen || (hasRealSession && showGuestBrowse)) {
    lead = hasRealSession
      ? 'Paste a Sleeper league ID to browse stats, drafts, rankings, trades, and My Team (waiver pickups) for another league.'
      : 'Local dev: paste a Sleeper league ID to try guest browse without enabling site auth.';
  } else if (modes) {
    if (userLogin && siteLogin) {
      lead =
        'Sign in with your member account, or paste a Sleeper league ID below to browse another league.';
    } else if (userLogin) {
      lead =
        'Use the username and password your commissioner set up, or paste a Sleeper league ID to browse another league.';
    } else if (siteLogin) {
      lead =
        'Enter the shared league password, or paste a Sleeper league ID to browse another league.';
    }
  }

  const browseOnly = !showSignIn && showGuestBrowse;

  return (
    <div className="page login-page">
      <div className="login-brand" aria-hidden="true">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="5" y="11" width="14" height="10" rx="2" />
          <path d="M12 15v2M8 11V7a4 4 0 0 1 8 0v4" strokeLinecap="round" />
        </svg>
      </div>
      <header className="page-header">
        <span className="eyebrow">{browseOnly ? (guestOnlyDevScreen ? 'Local dev' : 'Any Sleeper league') : 'Human League'}</span>
        <h1>{browseOnly ? 'Browse a league' : 'Sign in'}</h1>
        <p className="muted login-lead">{lead}</p>
      </header>

      {showSignIn ? (
        <form className="card login-card" onSubmit={onSubmit}>
          {(modes == null || userLogin) && (
            <div className="login-field">
              <label htmlFor="login-username">Username</label>
              <input
                id="login-username"
                name="username"
                type="text"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={submitting || guestSubmitting}
                required={usernameRequired}
                placeholder={userLogin ? 'e.g. Dansa-Bellend' : 'Optional for shared password'}
              />
              {modes != null && userLogin && siteLogin ? (
                <p className="login-hint">If you've forgotten, you're gonna have to ask Nick for help.</p>
              ) : null}
            </div>
          )}

          <div className="login-field">
            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting || guestSubmitting}
              required
              minLength={usernameRequired ? 8 : 1}
            />
            {usernameRequired ? <p className="login-hint">At least 8 characters.</p> : null}
          </div>

          {error ? <p className="login-err">{error}</p> : null}

          <button
            type="submit"
            className="btn btn-primary login-submit"
            disabled={submitting || guestSubmitting}
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      ) : null}

      {showSignIn && showGuestBrowse ? (
        <div className="login-divider" role="separator">
          <span>or</span>
        </div>
      ) : null}

      {showGuestBrowse ? (
        <form className="card login-card login-card--guest" onSubmit={onBrowse}>
          <header className="login-guest-header">
            <h2>{guestOnlyDevScreen ? 'Sleeper league' : 'Browse with a league ID'}</h2>
            <p className="muted login-lead">
              Paste a Sleeper league ID for league stats, the trade analyzer, and My Team waiver
              pickup values. Human League keepers and rules stay on the member app.
            </p>
          </header>

          <div className="login-field">
            <label htmlFor="guest-league-id">Sleeper league ID</label>
            <input
              id="guest-league-id"
              name="leagueId"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={guestId}
              onChange={(e) => setGuestId(e.target.value)}
              disabled={submitting || guestSubmitting}
              required
              placeholder="e.g. 1389346393180639232"
            />
            <p className="login-hint">
              Find it in the Sleeper URL when you open the league (
              <code>…/leagues/…</code>).
            </p>
          </div>

          {guestError ? <p className="login-err">{guestError}</p> : null}

          <button
            type="submit"
            className="btn login-submit login-submit--guest"
            disabled={submitting || guestSubmitting}
          >
            {guestSubmitting ? 'Loading league…' : isGuest ? 'Switch league' : 'Browse league'}
          </button>
        </form>
      ) : null}

      {hasRealSession ? (
        <p className="login-foot">
          <button type="button" className="login-text-link" onClick={onReturnHumanLeague}>
            Back to Human League
          </button>
        </p>
      ) : showSignIn ? (
        <p className="login-foot">Forgetting passwords will be publically shamed.</p>
      ) : guestOnlyDevScreen ? (
        <p className="login-foot">
          Tip: open /login anytime, or use Change league in the nav. Restart Vite after changing env.
        </p>
      ) : null}
    </div>
  );
}
