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
  const { enterGuestLeague, exitGuestLeague } = useLeague();
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

  const hasRealSession = authenticated && !devBypass;
  const guestOnlyDevScreen = DEV_LOGIN_SCREEN && !authEnabled;
  const showGuestBrowse = canAccessGuestBrowse(user, devBypass, { hasRealSession });
  const showSignIn = !guestOnlyDevScreen && !hasRealSession;

  if (ready && !authEnabled && !DEV_LOGIN_SCREEN) {
    return <Navigate to="/" replace />;
  }
  // Signed-in managers bounce home; commissioners may stay to paste a league id.
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

  let lead =
    'Sign in to open the league hub. If your deployment uses member accounts, use the username your commissioner gave you.';
  if (guestOnlyDevScreen || (hasRealSession && showGuestBrowse)) {
    lead = hasRealSession
      ? 'Paste a Sleeper league ID to browse stats, drafts, rankings, and trades for another league.'
      : 'Local dev: paste a Sleeper league ID to try guest browse without enabling site auth.';
  } else if (modes) {
    if (userLogin && siteLogin) {
      lead = '';
    } else if (userLogin) {
      lead = 'Use the username and password your commissioner set up for you.';
    } else if (siteLogin) {
      lead = 'Enter the shared league password your commissioner configured on the host.';
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
        <span className="eyebrow">{browseOnly ? (guestOnlyDevScreen ? 'Local dev' : 'Commissioner') : 'Human League'}</span>
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
            <h2>{guestOnlyDevScreen ? 'Sleeper league' : 'Browse another league'}</h2>
            <p className="muted login-lead">
              Paste a Sleeper league ID to view stats, drafts, rankings, and trades. Human League
              keepers, rules, and My Team stay on the member app.
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
            {guestSubmitting ? 'Loading league…' : 'Browse league'}
          </button>
        </form>
      ) : null}

      {showSignIn ? (
        <p className="login-foot">Forgetting passwords will be publically shamed.</p>
      ) : showGuestBrowse ? (
        <p className="login-foot">
          {guestOnlyDevScreen
            ? 'Tip: open /login anytime, or use Browse in the nav. Restart Vite after changing env.'
            : 'Exit browse from the nav to return to Human League.'}
        </p>
      ) : null}
    </div>
  );
}
