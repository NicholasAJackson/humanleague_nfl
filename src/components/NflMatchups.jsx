import React, { useEffect, useMemo, useState } from 'react';
import {
  fetchNflState,
  fetchNflSchedule,
  fetchMatchups,
  fetchUsers,
  fetchRosters,
  getNflPlayersLookup,
} from '../lib/sleeper.js';
import { buildNflGameCards, weeksInSchedule } from '../lib/nflMatchups.js';
import './NflMatchups.css';

function formatGameDate(dateStr) {
  const s = String(dateStr || '');
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return dateStr || '';
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return dt.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function statusLabel(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'complete') return 'Final';
  if (s === 'in_progress' || s === 'live') return 'Live';
  return null;
}

function fmtPts(n) {
  if (n == null || !Number.isFinite(n)) return null;
  return n.toFixed(1);
}

function starterCountLabel(n) {
  if (n === 1) return '1 starter';
  return `${n} starters`;
}

function Chevron() {
  return (
    <svg
      className="nfl-matchups-chevron"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function PosPill({ pos }) {
  const p = String(pos || '').toLowerCase();
  return <span className={`nfl-matchups-pos nfl-matchups-pos--${p}`}>{pos || '—'}</span>;
}

function StarterList({ title, pointsTotal, starters, viewerOwnerId, emptyLabel, showPoints }) {
  const pts = showPoints ? fmtPts(pointsTotal) : null;
  return (
    <div className="nfl-matchups-side">
      <h3 className="nfl-matchups-side__title">
        <span>{title}</span>
        {pts ? <span className="nfl-matchups-side__pts">{pts}</span> : null}
      </h3>
      {starters.length === 0 ? (
        <p className="muted nfl-matchups-empty">{emptyLabel}</p>
      ) : (
        <ul className="nfl-matchups-players">
          {starters.map((p) => {
            const yours = viewerOwnerId && p.ownerId === viewerOwnerId;
            const playerPts = showPoints ? fmtPts(p.points) : null;
            return (
              <li
                key={`${p.rosterId}:${p.playerId}`}
                className={'nfl-matchups-player' + (yours ? ' nfl-matchups-player--yours' : '')}
              >
                <span className="nfl-matchups-player__name">{p.name}</span>
                <PosPill pos={p.position} />
                <span
                  className={
                    'nfl-matchups-player__pts' +
                    (playerPts ? '' : ' nfl-matchups-player__pts--empty')
                  }
                >
                  {playerPts ?? '—'}
                </span>
                <span className="nfl-matchups-player__team" title={p.fantasyTeam}>
                  {yours ? 'You' : p.fantasyTeam}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default function NflMatchups({ leagueId, viewerOwnerId }) {
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const [nflState, setNflState] = useState(null);
  const [schedule, setSchedule] = useState([]);
  const [users, setUsers] = useState([]);
  const [rosters, setRosters] = useState([]);
  const [lookup, setLookup] = useState(null);
  const [matchups, setMatchups] = useState([]);
  const [matchupsStatus, setMatchupsStatus] = useState('idle');
  const [selectedWeek, setSelectedWeek] = useState(null);

  const season = String(nflState?.league_season || nflState?.season || '').trim();
  const displayWeek = Number(nflState?.display_week || nflState?.week || 1) || 1;
  const weekList = useMemo(() => {
    const fromSched = weeksInSchedule(schedule);
    return fromSched.length ? fromSched : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
  }, [schedule]);
  const minWeek = weekList[0];
  const maxWeek = weekList[weekList.length - 1];
  const week = selectedWeek ?? displayWeek;

  useEffect(() => {
    if (!leagueId) return undefined;
    let cancelled = false;
    setStatus('loading');
    setError(null);

    Promise.all([
      fetchNflState(),
      fetchUsers(leagueId),
      fetchRosters(leagueId),
      getNflPlayersLookup(),
    ])
      .then(async ([state, u, r, map]) => {
        const y = String(state?.league_season || state?.season || '').trim();
        const games = /^\d{4}$/.test(y) ? await fetchNflSchedule(y) : [];
        if (cancelled) return;
        setNflState(state);
        setSchedule(Array.isArray(games) ? games : []);
        setUsers(Array.isArray(u) ? u : []);
        setRosters(Array.isArray(r) ? r : []);
        setLookup(map);
        const dw = Number(state?.display_week || state?.week || 1) || 1;
        setSelectedWeek((prev) => (prev == null ? dw : prev));
        setStatus('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message || String(err));
        setStatus('error');
      });

    return () => {
      cancelled = true;
    };
  }, [leagueId]);

  useEffect(() => {
    if (!leagueId || week == null) return undefined;
    let cancelled = false;
    setMatchupsStatus('loading');
    fetchMatchups(leagueId, week)
      .then((data) => {
        if (cancelled) return;
        setMatchups(Array.isArray(data) ? data : []);
        setMatchupsStatus('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setMatchups([]);
        setMatchupsStatus('ready');
      });
    return () => {
      cancelled = true;
    };
  }, [leagueId, week]);

  const joined = useMemo(() => {
    if (status !== 'ready' || !lookup) {
      return { cards: [], bye: [], byeYouCount: 0, byePoints: null, byeHasScoring: false };
    }
    return buildNflGameCards({
      games: schedule,
      week,
      matchups,
      rosters,
      users,
      playersLookup: lookup,
      viewerOwnerId,
      matchupsLoaded: matchupsStatus === 'ready',
      allowRosterFallback: week === displayWeek,
    });
  }, [status, lookup, schedule, week, displayWeek, matchups, matchupsStatus, rosters, users, viewerOwnerId]);

  if (!leagueId) return null;

  if (status === 'idle' || status === 'loading') {
    return (
      <section className="nfl-matchups" aria-busy="true" aria-label="NFL matchups">
        <div className="nfl-matchups-head">
          <div className="skeleton" style={{ height: 22, width: '42%' }} />
          <div className="skeleton" style={{ height: 16, width: '58%', marginTop: 8 }} />
        </div>
        <div className="skeleton" style={{ height: 56, width: '100%', marginTop: 12 }} />
        <div className="skeleton" style={{ height: 56, width: '100%', marginTop: 8 }} />
        <div className="skeleton" style={{ height: 56, width: '100%', marginTop: 8 }} />
      </section>
    );
  }

  if (status === 'error') {
    return (
      <section className="nfl-matchups card">
        <h2 className="nfl-matchups-title">NFL matchups</h2>
        <p className="muted" style={{ margin: 0 }} role="alert">
          Could not load this week&apos;s games: {error}
        </p>
      </section>
    );
  }

  return (
    <section className="nfl-matchups" aria-label="NFL matchups">
      <div className="nfl-matchups-head">
        <div className="nfl-matchups-head__text">
          <h2 className="nfl-matchups-title">NFL matchups</h2>
          <p className="muted nfl-matchups-sub">
            League starters in each real game{season ? ` · ${season}` : ''}
          </p>
        </div>
        <div className="nfl-matchups-week" role="group" aria-label="NFL week">
          <button
            type="button"
            className="nfl-matchups-week__btn"
            disabled={week <= minWeek}
            onClick={() => setSelectedWeek((w) => Math.max(minWeek, (w ?? week) - 1))}
            aria-label="Previous week"
          >
            ‹
          </button>
          <span className="nfl-matchups-week__label">Week {week}</span>
          <button
            type="button"
            className="nfl-matchups-week__btn"
            disabled={week >= maxWeek}
            onClick={() => setSelectedWeek((w) => Math.min(maxWeek, (w ?? week) + 1))}
            aria-label="Next week"
          >
            ›
          </button>
        </div>
      </div>

      {joined.cards.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          No NFL games found for week {week}.
        </p>
      ) : (
        <div className="nfl-matchups-list" aria-busy={matchupsStatus !== 'ready'}>
          {joined.cards.map((game) => {
            const badge = statusLabel(game.status);
            const yours = game.youCount > 0;
            return (
              <details
                key={game.gameId}
                className={'nfl-matchups-game' + (yours ? ' nfl-matchups-game--yours' : '')}
              >
                <summary className="nfl-matchups-game__summary">
                  <span className="nfl-matchups-game__matchup">
                    {game.away} <span className="nfl-matchups-game__at">@</span> {game.home}
                  </span>
                  <span className="nfl-matchups-game__meta">
                    <span>{formatGameDate(game.date)}</span>
                    {badge ? <span className="nfl-matchups-game__badge">{badge}</span> : null}
                    {game.hasScoring && fmtPts(game.pointsTotal) ? (
                      <span className="nfl-matchups-game__pts">{fmtPts(game.pointsTotal)} pts</span>
                    ) : (
                      <span>{starterCountLabel(game.starterCount)}</span>
                    )}
                    {yours ? <span className="nfl-matchups-game__you">You: {game.youCount}</span> : null}
                  </span>
                  <Chevron />
                </summary>
                <div className="nfl-matchups-game__body">
                  <StarterList
                    title={game.away}
                    pointsTotal={game.awayPoints}
                    starters={game.awayStarters}
                    viewerOwnerId={viewerOwnerId}
                    emptyLabel="No league starters"
                    showPoints={game.hasScoring}
                  />
                  <StarterList
                    title={game.home}
                    pointsTotal={game.homePoints}
                    starters={game.homeStarters}
                    viewerOwnerId={viewerOwnerId}
                    emptyLabel="No league starters"
                    showPoints={game.hasScoring}
                  />
                </div>
              </details>
            );
          })}
        </div>
      )}

      {joined.bye.length > 0 && (
        <details className="nfl-matchups-game nfl-matchups-bye">
          <summary className="nfl-matchups-game__summary">
            <span className="nfl-matchups-game__matchup">On bye</span>
            <span className="nfl-matchups-game__meta">
              {joined.byeHasScoring && fmtPts(joined.byePoints) ? (
                <span className="nfl-matchups-game__pts">{fmtPts(joined.byePoints)} pts</span>
              ) : (
                <span>{starterCountLabel(joined.bye.length)}</span>
              )}
              {joined.byeYouCount > 0 ? (
                <span className="nfl-matchups-game__you">You: {joined.byeYouCount}</span>
              ) : null}
            </span>
            <Chevron />
          </summary>
          <div className="nfl-matchups-game__body nfl-matchups-game__body--bye">
            <StarterList
              title="Started, NFL team on bye"
              pointsTotal={joined.byePoints}
              starters={joined.bye}
              viewerOwnerId={viewerOwnerId}
              emptyLabel=""
              showPoints={joined.byeHasScoring}
            />
          </div>
        </details>
      )}
    </section>
  );
}
