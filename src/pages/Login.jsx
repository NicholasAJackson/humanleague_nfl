import React, { useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext.jsx';
import { useLeague } from '../LeagueContext.jsx';
import { canAccessGuestBrowse, DEV_LOGIN_SCREEN, GUEST_BROWSE_LEAGUES } from '../config.js';
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
  const [guestError, setGuestError] = useState('');
  const [guestSubmittingId, setGuestSubmittingId] = useState('');
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

  async function onBrowseLeague(leagueId) {
    setGuestError('');
    setGuestSubmittingId(String(leagueId));
    try {
      await enterGuestLeague(leagueId);
      navigate('/', { replace: true });
    } catch (err) {
      setGuestError(err?.message || 'Could not load that league.');
    } finally {
      setGuestSubmittingId('');
    }
  }

  function onReturnHumanLeague() {
    exitGuestLeague();
    navigate('/', { replace: true });
  }

  let lead =
    'Sign in to open the Human League hub, or pick a league below to browse stats, trades, and Target.';
  if (guestOnlyDevScreen || (hasRealSession && showGuestBrowse)) {
    lead = hasRealSession
      ? 'Pick a league to browse stats, drafts, rankings, trades, and Target.'
      : 'Local dev: pick a league to try guest browse without enabling site auth.';
  } else if (modes) {
    if (userLogin && siteLogin) {
      lead = 'Sign in with your member account, or pick a league below to browse without signing in.';
    } else if (userLogin) {
      lead =
        'Use the username and password your commissioner set up, or pick a league below to browse.';
    } else if (siteLogin) {
      lead = 'Enter the shared league password, or pick a league below to browse without signing in.';
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
        <span className="eyebrow">{browseOnly ? (guestOnlyDevScreen ? 'Local dev' : 'Allowed leagues') : 'Human League'}</span>
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
                disabled={submitting || Boolean(guestSubmittingId)}
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
              disabled={submitting || Boolean(guestSubmittingId)}
              required
              minLength={usernameRequired ? 8 : 1}
            />
            {usernameRequired ? <p className="login-hint">At least 8 characters.</p> : null}
          </div>

          {error ? <p className="login-err">{error}</p> : null}

          <button
            type="submit"
            className="btn btn-primary login-submit"
            disabled={submitting || Boolean(guestSubmittingId)}
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
        <div className="card login-card login-card--guest">
          <header className="login-guest-header">
            <h2>{guestOnlyDevScreen ? 'Sleeper league' : 'Browse a league'}</h2>
            <p className="muted login-lead">
              Open a public league for stats, the trade analyzer, and Target. No sign-in required.
              Human League keepers and rules stay on the member app.
            </p>
          </header>

          <div className="login-league-list">
            {GUEST_BROWSE_LEAGUES.map((league) => {
              const current = isGuest && String(activeLeagueId) === String(league.id);
              const loading = guestSubmittingId === String(league.id);
              return (
                <button
                  key={league.id}
                  type="button"
                  className={
                    'btn login-submit login-submit--guest' + (current ? ' is-current' : '')
                  }
                  disabled={submitting || Boolean(guestSubmittingId)}
                  onClick={() => onBrowseLeague(league.id)}
                >
                  {loading ? 'Loading…' : current ? `${league.name} (current)` : league.name}
                </button>
              );
            })}
          </div>

          {guestError ? <p className="login-err">{guestError}</p> : null}
        </div>
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
