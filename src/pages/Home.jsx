import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { config, canAccessKeepers, canAccessRules, getDraftTimestamp } from '../config.js';
import { useAuth } from '../AuthContext.jsx';
import { fetchLeague, fetchUsers } from '../lib/sleeper.js';
import { fetchHallOfFame } from '../lib/hallOfFame.js';
import './Home.css';

function splitCountdown(msRemaining) {
  const totalSec = Math.max(0, Math.floor(msRemaining / 1000));
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  return { days, hours, minutes, seconds, done: totalSec <= 0 };
}

function DraftCountdown() {
  const draftTs = getDraftTimestamp();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (draftTs == null) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [draftTs]);

  if (draftTs == null) return null;

  const parts = splitCountdown(draftTs - now);
  const draftLabel = new Date(draftTs).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  if (parts.done) {
    return (
      <div className="home-countdown" role="status">
        <p className="home-countdown__label">Draft time</p>
        <p className="home-countdown__live">It&apos;s draft night — good luck.</p>
      </div>
    );
  }

  const cells = [
    { value: parts.days, label: parts.days === 1 ? 'day' : 'days' },
    { value: parts.hours, label: 'hrs' },
    { value: parts.minutes, label: 'min' },
    { value: parts.seconds, label: 'sec' },
  ];

  return (
    <div className="home-countdown" role="timer" aria-live="polite" aria-atomic="true">
      <p className="home-countdown__label">Draft countdown</p>
      <div className="home-countdown__grid">
        {cells.map((c) => (
          <div key={c.label} className="home-countdown__cell">
            <strong>{String(c.value).padStart(2, '0')}</strong>
            <span>{c.label}</span>
          </div>
        ))}
      </div>
      <p className="home-countdown__when">{draftLabel}</p>
    </div>
  );
}

export default function Home() {
  const { ready, authenticated, authEnabled, user, devBypass } = useAuth();
  const [welcomeTeamName, setWelcomeTeamName] = useState(null);
  const [league, setLeague] = useState(null);
  const [hof, setHof] = useState({ status: 'idle' });

  const showMyTeamCta =
    ready &&
    Boolean(config.leagueId) &&
    authEnabled &&
    authenticated &&
    !devBypass &&
    typeof user?.sleeperUserId === 'string' &&
    user.sleeperUserId.length > 0;

  useEffect(() => {
    if (!showMyTeamCta || !config.leagueId) {
      setWelcomeTeamName(null);
      return;
    }
    let cancelled = false;
    fetchUsers(config.leagueId)
      .then((users) => {
        const u = Array.isArray(users) ? users.find((x) => x.user_id === user.sleeperUserId) : null;
        const label = u?.metadata?.team_name || u?.display_name || null;
        if (!cancelled) setWelcomeTeamName(label);
      })
      .catch(() => {
        if (!cancelled) setWelcomeTeamName(null);
      });
    return () => {
      cancelled = true;
    };
  }, [showMyTeamCta, user?.sleeperUserId]);

  useEffect(() => {
    if (!config.leagueId) return;
    let cancelled = false;
    fetchLeague(config.leagueId)
      .then((l) => {
        if (!cancelled) setLeague(l);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!config.leagueId) return;
    let cancelled = false;
    setHof({ status: 'loading' });
    fetchHallOfFame(config.leagueId)
      .then((rows) => {
        if (!cancelled) setHof({ status: 'ready', rows });
      })
      .catch((err) => {
        if (!cancelled) setHof({ status: 'error', message: err.message || String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="page home-page">
      <section className="home-hero" aria-label="League home">
        <div className="home-hero__inner">
          <h1 className="home-hero__title">{league?.name || 'Your league'}</h1>
          <p className="home-hero__intro">
            <span className="home-hero__intro-lead">Keepers are locked, the draft is next...</span>
          </p>
          <DraftCountdown />
          {showMyTeamCta && (
            <Link to="/me" className="home-hero__my-team">
              Welcome back{welcomeTeamName ? `, ${welcomeTeamName}` : ''}
            </Link>
          )}
        </div>
      </section>

      {!config.leagueId && <NoConfig />}
      {config.leagueId && hof.status === 'loading' && (
        <div className="card" aria-busy="true">
          <div className="skeleton" style={{ height: 20, width: '35%', marginBottom: 12 }} />
          <div className="skeleton" style={{ height: 56, width: '100%' }} />
        </div>
      )}
      {config.leagueId && hof.status === 'ready' && hof.rows?.length > 0 && (
        <HallOfFame rows={hof.rows} />
      )}
      {config.leagueId && hof.status === 'error' && (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            Could not load Hall of Fame: {hof.message}
          </p>
        </div>
      )}

      <div className="home-features">
        {canAccessKeepers() && (
          <FeatureLink
            to="/keepers"
            icon={KeeperIcon}
            title="Keeper Selection"
            body="Lock in your keepers for the upcoming season."
          />
        )}
        {canAccessRules() && (
          <FeatureLink
            to="/rules"
            icon={RulesIcon}
            title="Rule Changes"
            body="Suggest a rule and vote on what should change next season."
          />
        )}
        <FeatureLink
          to="/stats"
          icon={StatsIcon}
          title="League Stats"
          body="Standings, all-time totals and head-to-head."
        />
      </div>
    </div>
  );
}

function HallOfFame({ rows }) {
  return (
    <section className="card home-hof">
      <div className="row" style={{ marginBottom: 12, alignItems: 'baseline', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: '1.25rem' }}>Hall of Fame</h2>
        <span className="dim" style={{ fontSize: 13 }}>
          Playoff champions by season
        </span>
      </div>
      <div className="scroll-x">
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th
                style={{
                  textAlign: 'left',
                  padding: '8px 10px',
                  fontSize: 11,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  color: 'var(--color-text-dim)',
                }}
              >
                Season
              </th>
              <th
                style={{
                  textAlign: 'left',
                  padding: '8px 10px',
                  fontSize: 11,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  color: 'var(--color-text-dim)',
                }}
              >
                Champion
              </th>
              <th
                style={{
                  textAlign: 'left',
                  padding: '8px 10px',
                  fontSize: 11,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  color: 'var(--color-text-dim)',
                }}
              >
                Runner-up
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.season} style={{ borderTop: '1px solid var(--color-border)' }}>
                <td style={{ padding: '12px 10px', fontWeight: 700, whiteSpace: 'nowrap' }}>
                  {r.season}
                </td>
                <td style={{ padding: '12px 10px' }}>
                  <div className="row" style={{ gap: 10, alignItems: 'center' }}>
                    {r.champion.avatar ? (
                      <img
                        src={r.champion.avatar}
                        alt=""
                        width="28"
                        height="28"
                        style={{ borderRadius: '50%' }}
                      />
                    ) : (
                      <span style={{ width: 28, height: 28, display: 'inline-block' }} />
                    )}
                    <span className="truncate" style={{ maxWidth: 160 }} title={r.champion.name}>
                      {r.champion.name}
                    </span>
                  </div>
                </td>
                <td style={{ padding: '12px 10px' }}>
                  {r.runnerUp ? (
                    <div className="row" style={{ gap: 10, alignItems: 'center' }}>
                      {r.runnerUp.avatar ? (
                        <img
                          src={r.runnerUp.avatar}
                          alt=""
                          width="28"
                          height="28"
                          style={{ borderRadius: '50%' }}
                        />
                      ) : (
                        <span style={{ width: 28, height: 28, display: 'inline-block' }} />
                      )}
                      <span
                        className="truncate muted"
                        style={{ maxWidth: 160 }}
                        title={r.runnerUp.name}
                      >
                        {r.runnerUp.name}
                      </span>
                    </div>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function NoConfig() {
  return (
    <div className="card">
      <h3>League id not set</h3>
      <p className="muted">
        Set <code>VITE_SLEEPER_LEAGUE_ID</code> in <code>.env</code> (locally) or in your Vercel project
        settings, then redeploy.
      </p>
      <p className="dim">
        You can find your league id in the URL when you view the league on{' '}
        <a href="https://sleeper.app/" target="_blank" rel="noreferrer">
          sleeper.app
        </a>
        .
      </p>
    </div>
  );
}

function FeatureLink({ to, icon: Icon, title, body }) {
  return (
    <Link to={to} className="home-feature">
      <span className="home-feature__icon" aria-hidden="true">
        <Icon />
      </span>
      <span className="home-feature__text">
        <span className="home-feature__title">{title}</span>
        <span className="home-feature__body">{body}</span>
      </span>
      <svg
        className="home-feature__arrow"
        viewBox="0 0 24 24"
        width="20"
        height="20"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <polyline points="9 6 15 12 9 18" />
      </svg>
    </Link>
  );
}

function KeeperIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3l2.4 4.9L20 9.3l-4 3.9.9 5.6L12 16.9 7.1 18.8 8 13.2 4 9.3l5.6-1.4L12 3z" />
    </svg>
  );
}

function RulesIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 4h9l4 4v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
      <path d="M14 4v5h5" />
      <path d="M9 14h6" />
      <path d="M9 18h4" />
    </svg>
  );
}

function StatsIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 3v18h18" />
      <path d="M7 15l4-4 3 3 5-6" />
    </svg>
  );
}
