import React, { useEffect, useMemo, useState } from 'react';
import { useLeague } from '../LeagueContext.jsx';
import { fetchLeagueHistoryBundles } from '../lib/sleeper.js';
import { computeStats, computeCareerByUser } from '../lib/stats.js';
import {
  collectAllOwnersFromBundles,
  computeHeadToHeadRecords,
  listH2hGamesBetweenUsers,
  summarizeH2hGames,
} from '../lib/h2h.js';
import './Stats.css';

// Toggle sections on/off without deleting the JSX. Flip a flag to true to
// re-enable a section. The render order below mirrors what the user sees;
// reorder the JSX blocks rather than these flags if you want a new ordering.
const SECTION_VISIBILITY = {
  career: true,
  playoffs: true,
  standings: true,
  h2hExplorer: true,
  highlights: false,
  profiles: false,
  leagueH2h: false,
};

export default function Stats() {
  const { leagueId } = useLeague();
  const [state, setState] = useState({ status: 'loading' });
  const [managerA, setManagerA] = useState('');
  const [managerB, setManagerB] = useState('');

  async function load({ force = false } = {}) {
    setState({ status: 'loading' });
    if (!leagueId) {
      setState({ status: 'no-config' });
      return;
    }
    try {
      const entries = await fetchLeagueHistoryBundles(leagueId, { force });
      if (!entries.length) {
        setState({ status: 'no-data' });
        return;
      }
      const bundles = entries.map((e) => e.bundle);
      const seasonStats = entries.map((e) => ({
        season: e.season,
        leagueId: e.leagueId,
        name: e.name,
        stats: computeStats(e.bundle),
      }));
      const latestStats = seasonStats[0]?.stats || null;
      const career = computeCareerByUser(seasonStats);
      const usersById = collectAllOwnersFromBundles(bundles);
      const leagueWide = {
        regular: computeHeadToHeadRecords(bundles, { scope: 'regular' }).rows,
        playoff: computeHeadToHeadRecords(bundles, { scope: 'playoff' }).rows,
      };
      const seasons = [...new Set(entries.map((e) => String(e.season)))].sort(
        (a, b) => Number(a) - Number(b),
      );
      const seasonsLabel =
        seasons.length > 1
          ? `${seasons[0]}–${seasons[seasons.length - 1]}`
          : seasons[0] || '';
      setState({
        status: 'ready',
        bundles,
        usersById,
        seasonStats,
        latestStats,
        career,
        leagueWide,
        seasonCount: entries.length,
        seasonsLabel,
      });
    } catch (err) {
      setState({ status: 'error', error: err.message || String(err) });
    }
  }

  useEffect(() => {
    load();
  }, [leagueId]);

  const userOptions = useMemo(() => {
    if (state.status !== 'ready') return [];
    return Object.keys(state.usersById)
      .map((id) => ({ id, label: state.usersById[id]?.displayName || id }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [state]);

  const games = useMemo(() => {
    if (state.status !== 'ready' || !managerA || !managerB || managerA === managerB) {
      return [];
    }
    return listH2hGamesBetweenUsers(state.bundles, managerA, managerB);
  }, [state, managerA, managerB]);

  const summary = useMemo(() => {
    if (!games.length || !managerA || !managerB) return null;
    return summarizeH2hGames(games, managerA, managerB);
  }, [games, managerA, managerB]);

  const gamesBySeason = useMemo(() => {
    const map = new Map();
    for (const g of games) {
      if (!map.has(g.season)) map.set(g.season, []);
      map.get(g.season).push(g);
    }
    return [...map.entries()].sort((a, b) => Number(b[0]) - Number(a[0]));
  }, [games]);

  function onPickA(id) {
    setManagerA(id);
    if (id && id === managerB) setManagerB('');
  }
  function onPickB(id) {
    setManagerB(id);
    if (id && id === managerA) setManagerA('');
  }

  const stats = state.latestStats;

  const headerSubtitle = (() => {
    if (state.status !== 'ready' || !stats) {
      return 'Standings, scoring, career totals, and head-to-head — all in one place.';
    }
    const regW = stats.weeksTracked.length;
    const poW = stats.playoff?.weeksTracked?.length || 0;
    const poBit = poW > 0 ? ` · ${poW} playoff week${poW === 1 ? '' : 's'}` : '';
    return state.seasonCount > 1
      ? `Latest on record: ${stats.league.season} · ${state.seasonCount} linked seasons (${state.seasonsLabel}) · ${regW} regular-season weeks${poBit}`
      : `${stats.league.season} season · ${regW} regular-season weeks${poBit}`;
  })();

  return (
    <div className="page insights-page">
      <header className="page-header">
        <span className="eyebrow">League stats</span>
        <h1>{stats?.league?.name || 'League stats'}</h1>
        <p className="muted">{headerSubtitle}</p>
      </header>

      {state.status === 'no-config' && (
        <div className="card">
          <h3>League id not set</h3>
          <p className="muted">
            Set <code>VITE_SLEEPER_LEAGUE_ID</code> and reload.
          </p>
        </div>
      )}

      {state.status === 'no-data' && (
        <div className="card">
          <h3>No leagues loaded</h3>
          <p className="muted">Could not resolve a league history for this id.</p>
        </div>
      )}

      {state.status === 'loading' && <Loading />}

      {state.status === 'error' && (
        <div className="card">
          <h3>Could not load stats</h3>
          <p className="muted">{state.error}</p>
          <button type="button" className="btn" onClick={() => load({ force: true })}>
            Try again
          </button>
        </div>
      )}

      {state.status === 'ready' && stats && (
        <>
          <div className="insights-toolbar">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => load({ force: true })}
            >
              Refresh
            </button>
          </div>

          {SECTION_VISIBILITY.career && (
            <CollapsibleSection
              id="career"
              title="All Time Standings"
              sub={`${state.seasonCount} season${state.seasonCount === 1 ? '' : 's'} (${state.seasonsLabel})`}
            >
              <CareerTable career={state.career} seasonCount={state.seasonCount} />
            </CollapsibleSection>
          )}

          {SECTION_VISIBILITY.playoffs && (
            <CollapsibleSection
              id="playoffs"
              title="Playoffs Last Season"
              sub={`${stats.league.season} bracket + playoff-only stats`}
            >
              <PlayoffSection playoff={stats.playoff} season={stats.league.season} />
            </CollapsibleSection>
          )}

          {SECTION_VISIBILITY.standings && (
            <CollapsibleSection
              id="standings"
              title="Latest Season Standings"
              sub={`${stats.league.season} final order`}
            >
              <Standings stats={stats} />
            </CollapsibleSection>
          )}

          {SECTION_VISIBILITY.h2hExplorer && (
            <CollapsibleSection
              id="h2h-explorer"
              title="Head to Head"
              sub="Pick two managers, see every meeting"
            >
              <H2hExplorer
                userOptions={userOptions}
                managerA={managerA}
                managerB={managerB}
                onPickA={onPickA}
                onPickB={onPickB}
                games={games}
                gamesBySeason={gamesBySeason}
                summary={summary}
                usersById={state.usersById}
              />
            </CollapsibleSection>
          )}

          {SECTION_VISIBILITY.highlights && (
            <CollapsibleSection
              id="highlights"
              title="Latest season highlights"
              sub="Best week, worst week, blowouts, closest games"
            >
              <Highlights stats={stats} />
            </CollapsibleSection>
          )}

          {SECTION_VISIBILITY.profiles && (
            <CollapsibleSection
              id="profiles"
              title="Manager profiles"
              sub="Consistency, volatility, bench points"
            >
              <Aggregates stats={stats} />
            </CollapsibleSection>
          )}

          {SECTION_VISIBILITY.leagueH2h && (
            <CollapsibleSection
              id="league-h2h"
              title="League-wide head-to-head"
              sub="Every pair — regular season + playoffs"
            >
              <LeagueWideH2H leagueWide={state.leagueWide} usersById={state.usersById} />
            </CollapsibleSection>
          )}
        </>
      )}
    </div>
  );
}

function CollapsibleSection({ id, title, sub, children }) {
  return (
    <details className="insights-section" id={id}>
      <summary className="insights-section__summary">
        <span className="insights-section__title">{title}</span>
        {sub && <span className="insights-section__sub">{sub}</span>}
        <svg
          className="insights-section__chevron"
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
      </summary>
      <div className="insights-section__body">{children}</div>
    </details>
  );
}

function Loading() {
  return (
    <>
      <div className="skeleton" style={{ height: 24, width: '40%' }} />
      <div className="card-grid">
        <div className="skeleton" style={{ height: 140 }} />
        <div className="skeleton" style={{ height: 140 }} />
        <div className="skeleton" style={{ height: 140 }} />
      </div>
      <div className="skeleton" style={{ height: 240 }} />
    </>
  );
}

function Standings({ stats }) {
  return (
    <div className="scroll-x">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Team</th>
            <th>Record</th>
            <th>PF</th>
            <th>PA</th>
          </tr>
        </thead>
        <tbody>
          {stats.standings.map((t, i) => (
            <tr key={t.rosterId}>
              <td>{i + 1}</td>
              <td>
                <div className="row" style={{ gap: 10 }}>
                  {t.avatar ? (
                    <img src={t.avatar} alt="" width="22" height="22" style={{ borderRadius: '50%' }} />
                  ) : (
                    <span style={{ width: 22, height: 22, display: 'inline-block' }} />
                  )}
                  <span className="truncate" style={{ maxWidth: 180 }}>
                    {t.name}
                  </span>
                </div>
              </td>
              <td>
                {t.wins}-{t.losses}
                {t.ties ? `-${t.ties}` : ''}
              </td>
              <td>{t.fpts.toFixed(2)}</td>
              <td>{t.fptsAgainst.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Highlights({ stats }) {
  return (
    <div className="card-grid">
      {stats.highest && (
        <StatCard
          title="Highest single week"
          primary={`${stats.highest.points.toFixed(2)} pts`}
          secondary={`${stats.highest.team} · Week ${stats.highest.week}`}
        />
      )}
      {stats.lowest && (
        <StatCard
          title="Lowest single week"
          primary={`${stats.lowest.points.toFixed(2)} pts`}
          secondary={`${stats.lowest.team} · Week ${stats.lowest.week}`}
        />
      )}
      {stats.blowout && (
        <StatCard
          title="Biggest blowout"
          primary={`${stats.blowout.diff.toFixed(2)} margin`}
          secondary={`${stats.blowout.winner.team} (${stats.blowout.winner.points.toFixed(
            2,
          )}) over ${stats.blowout.loser.team} (${stats.blowout.loser.points.toFixed(2)}) · Week ${
            stats.blowout.week
          }`}
        />
      )}
      {stats.closest && (
        <StatCard
          title="Closest matchup"
          primary={`${stats.closest.diff.toFixed(2)} margin`}
          secondary={`${stats.closest.winner.team} edged ${stats.closest.loser.team} · Week ${stats.closest.week}`}
        />
      )}
      {stats.totalsLeader && (
        <StatCard
          title="Most points scored"
          primary={`${stats.totalsLeader.fpts.toFixed(2)} pts`}
          secondary={stats.totalsLeader.name}
        />
      )}
      {stats.fewestPoints && (
        <StatCard
          title="Fewest points scored"
          primary={`${stats.fewestPoints.fpts.toFixed(2)} pts`}
          secondary={stats.fewestPoints.name}
        />
      )}
      {stats.mostPointsAgainst && (
        <StatCard
          title="Most points against (unlucky)"
          primary={`${stats.mostPointsAgainst.fptsAgainst.toFixed(2)} pts`}
          secondary={stats.mostPointsAgainst.name}
        />
      )}
    </div>
  );
}

function Aggregates({ stats }) {
  return (
    <div className="card-grid">
      {stats.mostConsistent && (
        <StatCard
          title="Most consistent"
          primary={`σ ${stats.mostConsistent.stdev.toFixed(2)}`}
          secondary={`${stats.mostConsistent.team} · avg ${stats.mostConsistent.mean.toFixed(2)} pts/wk`}
        />
      )}
      {stats.mostVolatile && (
        <StatCard
          title="Most volatile"
          primary={`σ ${stats.mostVolatile.stdev.toFixed(2)}`}
          secondary={`${stats.mostVolatile.team} · avg ${stats.mostVolatile.mean.toFixed(2)} pts/wk`}
        />
      )}
      {stats.mostBenched && (
        <StatCard
          title="Bench points left behind"
          primary={`${stats.mostBenched.benchTotal.toFixed(2)} pts`}
          secondary={stats.mostBenched.team}
        />
      )}
      {stats.leastBenched && (
        <StatCard
          title="Tightest lineup"
          primary={`${stats.leastBenched.benchTotal.toFixed(2)} bench pts`}
          secondary={stats.leastBenched.team}
        />
      )}
    </div>
  );
}

function PlayoffSection({ playoff, season }) {
  if (!playoff) {
    return (
      <p className="muted">No playoff data available for this season.</p>
    );
  }
  const showScores = playoff.hasScores;
  const showBracket = playoff.hasBracket;
  if (!showScores && !showBracket) {
    return (
      <p className="muted">
        No playoff scores or winners bracket in Sleeper yet for this league (season not started, still
        in regular season, or data not published).
        
      </p>
    );
  }

  return (
    <>
      <p className="muted" style={{ marginTop: 0, marginBottom: 12 }}>
        Playoff weeks are week {playoff.playoffWeekStart} and later (through week 18). Highlights and
        manager profiles below use <strong>only</strong> those weeks. It sucks to come 2nd, right Mike?
      </p>

      {showBracket && (playoff.bracket?.championName || playoff.bracket?.decisiveMatches?.length) ? (
        <div className="card" style={{ marginBottom: 12 }}>
          {playoff.bracket.championName && (
            <p style={{ fontSize: 'var(--fs-lg)', fontWeight: 700, marginBottom: 8 }}>
              Champion {season}: {playoff.bracket.championName}
            </p>
          )}
          {playoff.bracket.decisiveMatches.length > 0 && (
            <>
              <h4 style={{ marginBottom: 8 }}>Winners bracket</h4>
              <div className="scroll-x">
                <table>
                  <thead>
                    <tr>
                      <th>Rd</th>
                      <th>M</th>
                      <th>Game</th>
                      <th>Winner</th>
                      <th>Loser</th>
                    </tr>
                  </thead>
                  <tbody>
                    {playoff.bracket.decisiveMatches.map((m, i) => (
                      <tr key={`${m.round}-${m.match}-${i}`}>
                        <td>{m.round}</td>
                        <td className="muted">{m.match || '—'}</td>
                        <td className="muted" style={{ fontSize: '0.92em' }}>
                          {m.slotLabel || '—'}
                        </td>
                        <td>{m.winner}</td>
                        <td className="muted">{m.loser}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      ) : null}

      {showScores ? (
        <>
          <h4 style={{ marginBottom: 8 }}>Playoff highlights</h4>
          <Highlights stats={playoff} />
          <h4 style={{ marginBottom: 8, marginTop: 16 }}>Playoff manager profiles</h4>
          <Aggregates stats={playoff} />
        </>
      ) : (
        <p className="muted dim">
          Bracket results above; weekly playoff scores not available in matchups yet.
        </p>
      )}
    </>
  );
}

function CareerTable({ career, seasonCount }) {
  const { rows, latestChampionUserId } = career;
  if (!rows.length) {
    return <p className="muted">No manager rows could be built from the loaded seasons.</p>;
  }
  return (
    <>
      <p className="muted" style={{ marginTop: 0, marginBottom: 12 }}>
        Imagine having the best record over 2 years and not having a championship. What's that feel like Mike?
      </p>
      <div className="scroll-x">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Manager</th>
              <th title="Championships won across linked seasons">Titles</th>
              <th>W-L-T</th>
              <th>Career PF</th>
              <th>Career PA</th>
              <th>Avg / game</th>
              <th>Best week</th>
              <th>Worst week</th>
              <th>Bench pts</th>
              <th>Seasons</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const isReigning = !!latestChampionUserId && r.userId === latestChampionUserId;
              return (
              <tr key={r.userId}>
                <td>{i + 1}</td>
                <td>
                  <div className="row" style={{ gap: 10 }}>
                    {r.avatar ? (
                      <img
                        src={r.avatar}
                        alt=""
                        width="22"
                        height="22"
                        style={{ borderRadius: '50%' }}
                      />
                    ) : (
                      <span style={{ width: 22, height: 22, display: 'inline-block' }} />
                    )}
                    {isReigning ? (
                      <span
                        className="manager-on-fire"
                        title={`${r.userId} · reigning champion`}
                      >
                        {r.displayName}
                      </span>
                    ) : (
                      <span className="truncate" style={{ maxWidth: 160 }} title={r.userId}>
                        {r.displayName}
                      </span>
                    )}
                  </div>
                </td>
                <td
                  className={r.championships > 0 ? '' : 'muted'}
                  style={{ fontWeight: r.championships > 0 ? 650 : 400 }}
                >
                  {r.championships > 0 ? r.championships : '—'}
                </td>
                <td>
                  {r.wins}-{r.losses}
                  {r.ties ? `-${r.ties}` : ''}
                </td>
                <td>{r.careerPf.toFixed(2)}</td>
                <td>{r.careerPa.toFixed(2)}</td>
                <td>{r.gamesPlayed ? r.avgPtsPerGame.toFixed(2) : '—'}</td>
                <td className="muted" style={{ fontSize: '0.92em' }}>
                  {r.bestWeek
                    ? `${r.bestWeek.points.toFixed(2)} (${r.bestWeek.season} w${r.bestWeek.week})`
                    : '—'}
                </td>
                <td className="muted" style={{ fontSize: '0.92em' }}>
                  {r.worstWeek
                    ? `${r.worstWeek.points.toFixed(2)} (${r.worstWeek.season} w${r.worstWeek.week})`
                    : '—'}
                </td>
                <td>{r.benchTotal.toFixed(2)}</td>
                <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                  {r.seasonsLabel}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function LeagueWideH2H({ leagueWide, usersById }) {
  return (
    <>
      <p className="muted" style={{ marginTop: 0, marginBottom: 12 }}>
        Aggregated W–L–T across every pair of managers. Two scopes below: regular-season weeks and
        playoff weeks.
      </p>
      <h4 style={{ marginBottom: 8 }}>Regular season</h4>
      {!leagueWide.regular.length ? (
        <p className="muted">No rows.</p>
      ) : (
        <H2hTable rows={leagueWide.regular} usersById={usersById} />
      )}
      <h4 style={{ marginTop: 16, marginBottom: 8 }}>Playoffs</h4>
      {!leagueWide.playoff.length ? (
        <p className="muted">No rows.</p>
      ) : (
        <H2hTable rows={leagueWide.playoff} usersById={usersById} />
      )}
    </>
  );
}

function H2hExplorer({
  userOptions,
  managerA,
  managerB,
  onPickA,
  onPickB,
  games,
  gamesBySeason,
  summary,
  usersById,
}) {
  return (
    <>
      <div className="insights-h2h-pickers">
        <label>
          <span className="dim">Manager A</span>
          <select value={managerA} onChange={(e) => onPickA(e.target.value)}>
            <option value="">Select…</option>
            {userOptions.map((u) => (
              <option key={u.id} value={u.id} disabled={u.id === managerB}>
                {u.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="dim">Manager B</span>
          <select value={managerB} onChange={(e) => onPickB(e.target.value)}>
            <option value="">Select…</option>
            {userOptions.map((u) => (
              <option key={u.id} value={u.id} disabled={u.id === managerA}>
                {u.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!managerA || !managerB ? (
        <p className="muted">
          Pick <strong>Manager A</strong> and <strong>Manager B</strong> to load every week they faced
          each other.
        </p>
      ) : managerA === managerB ? (
        <p className="muted">Pick two different managers.</p>
      ) : !games.length ? (
        <p className="muted">
          No Sleeper weeks found where these two managers were paired in the same matchup.
        </p>
      ) : (
        <>
          <H2hSummary
            summary={summary}
            metaA={usersById[managerA]}
            metaB={usersById[managerB]}
            idA={managerA}
            idB={managerB}
          />
          <h4 style={{ marginTop: 16, marginBottom: 8 }}>Every meeting ({games.length} games)</h4>
          <p className="muted" style={{ marginTop: 0, marginBottom: 12, fontSize: '0.95em' }}>
            Newest first. Margin is A minus B (positive means A outscored B that week).
          </p>
          <div className="scroll-x">
            <table className="insights-h2h-detail">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Bracket</th>
                  <th style={{ textAlign: 'right' }}>A PF</th>
                  <th style={{ textAlign: 'right' }}>B PF</th>
                  <th style={{ textAlign: 'right' }}>Margin (A−B)</th>
                  <th>Result</th>
                </tr>
              </thead>
              {gamesBySeason.map(([season, rows]) => (
                <tbody key={season}>
                  <tr className="insights-h2h-season-row">
                    <td colSpan={6}>
                      <strong>{season}</strong>
                      {rows[0]?.leagueName ? (
                        <span className="muted"> · {rows[0].leagueName}</span>
                      ) : null}
                    </td>
                  </tr>
                  {rows.map((g, idx) => (
                    <tr key={`${g.season}-${g.week}-${g.phase}-${idx}`}>
                      <td>{g.moniker}</td>
                      <td className="muted" style={{ fontSize: '0.92em', whiteSpace: 'nowrap' }}>
                        {g.phase === 'playoff' && g.bracketRound != null
                          ? `Winners · Rd ${g.bracketRound}`
                          : '—'}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{g.scoreA.toFixed(2)}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{g.scoreB.toFixed(2)}</td>
                      <td
                        style={{
                          textAlign: 'right',
                          fontVariantNumeric: 'tabular-nums',
                          color:
                            g.margin > 0
                              ? 'var(--color-accent, #38bdf8)'
                              : g.margin < 0
                                ? '#f472b6'
                                : undefined,
                        }}
                      >
                        {g.margin > 0 ? '+' : ''}
                        {g.margin.toFixed(2)}
                      </td>
                      <td>
                        {g.winnerUserId === managerA ? (
                          <span style={{ fontWeight: 600 }}>A wins</span>
                        ) : g.winnerUserId === managerB ? (
                          <span style={{ fontWeight: 600 }}>B wins</span>
                        ) : (
                          <span className="muted">Tie</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
        </>
      )}
    </>
  );
}

function H2hSummary({ summary, metaA, metaB, idA, idB }) {
  if (!summary) return null;
  const nameA = metaA?.displayName || idA;
  const nameB = metaB?.displayName || idB;
  return (
    <div className="card-grid">
      <StatCard
        title="Series record"
        primary={`${summary.winsA}–${summary.winsB}${summary.ties ? `–${summary.ties}` : ''}`}
        secondary={`${nameA} vs ${nameB}`}
      />
      <StatCard
        title="Total points"
        primary={`${summary.pfA.toFixed(1)} / ${summary.pfB.toFixed(1)}`}
        secondary="Sum of every listed game"
      />
      <StatCard
        title="Avg per game"
        primary={`${summary.avgA.toFixed(1)} / ${summary.avgB.toFixed(1)}`}
        secondary={`${summary.games} game${summary.games === 1 ? '' : 's'}`}
      />
      <StatCard
        title="Games by phase"
        primary={`${summary.regGames} reg · ${summary.poGames} post`}
        secondary="Regular vs playoff weeks"
      />
    </div>
  );
}

function H2hTable({ rows, usersById }) {
  return (
    <div className="scroll-x">
      <table>
        <thead>
          <tr>
            <th>Manager A</th>
            <th>Record (A–B–T)</th>
            <th>Manager B</th>
            <th>Games</th>
            <th>Avg PF</th>
            <th>Total PF</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.userA}-${r.userB}`}>
              <td>
                <ManagerCell userId={r.userA} meta={usersById[r.userA]} strong={r.winsA > r.winsB} />
              </td>
              <td style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
                {r.winsA}–{r.winsB}
                {r.ties ? `–${r.ties}` : ''}
              </td>
              <td>
                <ManagerCell userId={r.userB} meta={usersById[r.userB]} strong={r.winsB > r.winsA} />
              </td>
              <td>{r.games}</td>
              <td className="muted" style={{ fontSize: '0.92em', whiteSpace: 'nowrap' }}>
                {r.avgA.toFixed(1)} / {r.avgB.toFixed(1)}
              </td>
              <td className="muted" style={{ fontSize: '0.92em', whiteSpace: 'nowrap' }}>
                {r.pfA.toFixed(1)} / {r.pfB.toFixed(1)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ManagerCell({ userId, meta, strong }) {
  const name = meta?.displayName || userId;
  return (
    <div className="row" style={{ gap: 8, alignItems: 'center' }}>
      {meta?.avatar ? (
        <img src={meta.avatar} alt="" width="24" height="24" style={{ borderRadius: '50%' }} />
      ) : (
        <span style={{ width: 24, height: 24, display: 'inline-block' }} />
      )}
      <span
        className="truncate"
        style={{ maxWidth: 140, fontWeight: strong ? 700 : 500 }}
        title={userId}
      >
        {name}
      </span>
    </div>
  );
}

function StatCard({ title, primary, secondary }) {
  return (
    <div className="card">
      <div
        className="dim"
        style={{ textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 11 }}
      >
        {title}
      </div>
      <div style={{ fontSize: 'var(--fs-2xl)', fontWeight: 700, marginTop: 4 }}>{primary}</div>
      {secondary && <div className="muted" style={{ marginTop: 4 }}>{secondary}</div>}
    </div>
  );
}
