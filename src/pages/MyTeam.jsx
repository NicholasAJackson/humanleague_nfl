import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { config, leagueFormat, canAccessKeepers } from '../config.js';
import { useAuth } from '../AuthContext.jsx';
import BottomSheet from '../components/BottomSheet.jsx';
import {
  resolveLeagueHistoryChain,
  fetchSeasonBundle,
  getNflPlayersLookup,
  rosterPlayerIds,
} from '../lib/sleeper.js';
import { computeStats, getRegularSeasonMatchupPairs } from '../lib/stats.js';
import { loadKeeperRankingsContext } from '../lib/loadKeeperRankingsContext.js';
import './MyTeam.css';

function fmtNominationRow(n, lookup) {
  if (!n) return '';
  if (n.nomination_kind === 'freeform') {
    return [n.k1_text, n.k2_text, n.k3_text].filter(Boolean).join(' · ');
  }
  const ids = [n.k1_player_id, n.k2_player_id, n.k3_player_id].filter(Boolean);
  if (!lookup) return ids.join(' · ');
  return ids
    .map((id) => {
      const x = lookup.get(id);
      return x ? `${x.name} (${x.position || '?'})` : id;
    })
    .join(' · ');
}

function fmtPf(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(2);
}

function positionRank(pos) {
  const p = String(pos || '').toUpperCase();
  const order = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DST'];
  const i = order.indexOf(p);
  return i === -1 ? 50 : i;
}

/** Latest contiguous regular-season W/L streak (ties stop the streak). */
function computeWinLossStreak(bundle, rosterId) {
  const pairs = getRegularSeasonMatchupPairs(bundle);
  const rows = [];
  for (const [a, b] of pairs) {
    const mine = a.rosterId === rosterId ? a : b.rosterId === rosterId ? b : null;
    if (!mine) continue;
    const opp = mine.rosterId === a.rosterId ? b : a;
    rows.push({
      week: mine.week,
      tie: mine.points === opp.points,
      win: mine.points > opp.points,
    });
  }
  rows.sort((x, y) => y.week - x.week);
  let i = 0;
  while (i < rows.length && rows[i].tie) i++;
  if (i >= rows.length) return null;
  const wins = rows[i].win;
  let n = 0;
  for (; i < rows.length; i++) {
    const r = rows[i];
    if (r.tie || r.win !== wins) break;
    n++;
  }
  return `${wins ? 'W' : 'L'}${n}`;
}

function fmtRankingsNum(n, digits = 1) {
  if (n == null || !Number.isFinite(n)) return '—';
  return Number(n).toFixed(digits);
}

function formatRankingsDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function PlayerRankingsSheet({
  open,
  onClose,
  focusPlayerId,
  lookup,
  ecrRankings,
  keeperCtx,
  ecrPlayer,
  keeperRow,
}) {
  const meta = focusPlayerId ? lookup?.get(String(focusPlayerId)) : null;
  const titleName = meta?.name || (focusPlayerId ? String(focusPlayerId) : 'Player');

  return (
    <BottomSheet open={open} onClose={onClose} title={titleName}>
      <div className="my-team-rankings-sheet">
        {ecrRankings.status === 'loading' || ecrRankings.status === 'idle' ? (
          <p className="muted my-team-rankings-sheet__status">Loading expert rankings…</p>
        ) : null}
        {ecrRankings.status === 'error' && (
          <p className="muted my-team-rankings-sheet__status" role="alert">
            Could not load rankings: {ecrRankings.message}
          </p>
        )}

        {ecrRankings.status === 'ready' && !ecrPlayer && (
          <p className="muted my-team-rankings-sheet__status">
            No expert consensus row for this player (missing FantasyPros ↔ Sleeper id mapping in the public
            dataset).
          </p>
        )}

        {ecrRankings.status === 'ready' && ecrPlayer && (
          <section className="my-team-rankings-block">
            <h3 className="my-team-rankings-block__title">Expert consensus (redraft)</h3>
            {ecrRankings.data?.scrape_date && (
              <p className="muted my-team-rankings-block__meta">
                As of <strong>{formatRankingsDate(ecrRankings.data.scrape_date)}</strong>
              </p>
            )}
            <dl className="my-team-rankings-dl">
              <div>
                <dt>ECR rank</dt>
                <dd>{ecrPlayer.ecr ?? '—'}</dd>
              </div>
              <div>
                <dt>Pos</dt>
                <dd>
                  <span className={`my-team-pos my-team-pos--${(ecrPlayer.pos || '').toLowerCase()}`}>
                    {ecrPlayer.pos || '—'}
                  </span>
                </dd>
              </div>
              <div>
                <dt>NFL team</dt>
                <dd>{ecrPlayer.team || '—'}</dd>
              </div>
              <div>
                <dt>Bye</dt>
                <dd>{ecrPlayer.bye ?? '—'}</dd>
              </div>
              <div>
                <dt>SD</dt>
                <dd title="Standard deviation across experts">{fmtRankingsNum(ecrPlayer.sd, 1)}</dd>
              </div>
              <div>
                <dt>Best / worst</dt>
                <dd>
                  {ecrPlayer.best != null && ecrPlayer.worst != null
                    ? `${ecrPlayer.best} / ${ecrPlayer.worst}`
                    : '—'}
                </dd>
              </div>
              <div>
                <dt>Owned</dt>
                <dd>
                  {ecrPlayer.owned_avg != null ? `${Math.round(ecrPlayer.owned_avg)}%` : '—'}
                </dd>
              </div>
            </dl>
          </section>
        )}

        <section className="my-team-rankings-block">
          <h3 className="my-team-rankings-block__title">Keeper: draft vs consensus</h3>
          {ecrRankings.status === 'error' ? (
            <p className="muted my-team-rankings-sheet__status">
              Keeper comparison needs expert rankings data loaded above.
            </p>
          ) : keeperCtx.status === 'idle' || keeperCtx.status === 'loading' ? (
            <p className="muted my-team-rankings-sheet__status">Loading keeper comparison…</p>
          ) : keeperCtx.status === 'no-league' ? (
            <p className="muted my-team-rankings-sheet__status">
              Set <code className="my-team-rankings-code">VITE_SLEEPER_LEAGUE_ID</code> to enable this section.
            </p>
          ) : keeperCtx.status === 'no-draft' ? (
            <p className="muted my-team-rankings-sheet__status">{keeperCtx.message}</p>
          ) : keeperCtx.status === 'error' ? (
            <p className="muted my-team-rankings-sheet__status" role="alert">
              {keeperCtx.message}
            </p>
          ) : keeperCtx.status === 'ready' ? (
            <>
              <p className="muted my-team-rankings-block__meta">
                <strong>{keeperCtx.season}</strong>
                {keeperCtx.leagueName ? ` · ${keeperCtx.leagueName}` : ''}
                {keeperCtx.draftLabel ? ` · Draft: ${keeperCtx.draftLabel}` : ''}
              </p>
              {!keeperRow ? (
                <p className="muted my-team-rankings-sheet__status">
                  This player isn’t on a roster in that league season’s keeper comparison (same scope as the
                  Rankings → keeper view).
                </p>
              ) : (
                <dl className="my-team-rankings-dl">
                  <div>
                    <dt>Pick ({keeperCtx.season})</dt>
                    <dd>{keeperRow.draft_pick_overall != null ? keeperRow.draft_pick_overall : '—'}</dd>
                  </div>
                  <div>
                    <dt>RD cost</dt>
                    <dd>{keeperRow.round_lost ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>RD ECR</dt>
                    <dd>
                      {keeperRow.ecr_implied_round != null
                        ? keeperRow.ecr_implied_round
                        : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt>ECR</dt>
                    <dd>{keeperRow.ecr ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>Delta</dt>
                    <dd
                      className={
                        keeperRow.keeper_delta != null && keeperRow.keeper_delta > 0
                          ? 'my-team-rankings-dl__delta-pos'
                          : undefined
                      }
                    >
                      {keeperRow.keeper_delta != null ? fmtRankingsNum(keeperRow.keeper_delta, 1) : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt>Manager</dt>
                    <dd>{keeperRow.manager_label || '—'}</dd>
                  </div>
                </dl>
              )}
              <p className="muted my-team-rankings-footnote">
                RD ECR = round implied by consensus rank (ceil(rank ÷ {leagueFormat.teamCount})). Delta =
                startup overall pick minus ECR; undrafted players use a mid–round {leagueFormat.undraftedKeeperRound}{' '}
                proxy — same as the Rankings page footnote.
              </p>
            </>
          ) : null}
        </section>

        <p className="muted my-team-rankings-sheet__hint">
          <Link to="/rankings" onClick={onClose}>
            Open full Rankings page →
          </Link>
        </p>
      </div>
    </BottomSheet>
  );
}

function nextRegularOpponent(bundle, rosterId, playedWeeksDesc) {
  const lastRegularWeek = bundle.lastRegularWeek || 14;
  const lastPlayed = playedWeeksDesc[0];
  if (!lastPlayed || lastPlayed >= lastRegularWeek) return null;
  const nextWeek = lastPlayed + 1;
  const ms = bundle.matchupsByWeek[nextWeek];
  if (!Array.isArray(ms)) return null;
  const mine = ms.find((m) => m.roster_id === rosterId);
  if (!mine?.matchup_id) return null;
  const opp = ms.find((m) => m.roster_id !== rosterId && m.matchup_id === mine.matchup_id);
  if (!opp) return null;
  return { week: nextWeek, oppRosterId: opp.roster_id };
}

async function loadSeasonForOwner(chain, ownerId) {
  for (const meta of chain) {
    try {
      const bundle = await fetchSeasonBundle(meta.leagueId);
      const roster = bundle.rosters?.find((r) => r.owner_id === ownerId);
      const ids = roster ? rosterPlayerIds(roster) : [];
      if (roster && ids.length > 0) {
        return { meta, bundle, roster };
      }
    } catch {
      // try older season
    }
  }
  return null;
}

function RosterTable({ roster, lookup, onViewRankings }) {
  const starters = Array.isArray(roster.starters) ? roster.starters.map(String).filter(Boolean) : [];
  const starterSet = new Set(starters);
  const reserve = new Set((roster.reserve || []).map(String));
  const allIds = rosterPlayerIds(roster);

  const rowIdsBenchIr = useMemo(() => {
    const benchIds = allIds.filter((id) => !starterSet.has(id) && !reserve.has(id));
    benchIds.sort((a, b) => {
      const pa = lookup?.get(a)?.position || '';
      const pb = lookup?.get(b)?.position || '';
      const rp = positionRank(pa) - positionRank(pb);
      if (rp !== 0) return rp;
      const na = lookup?.get(a)?.name || a;
      const nb = lookup?.get(b)?.name || b;
      return na.localeCompare(nb);
    });
    const irIds = [...reserve].filter((id) => allIds.includes(id));
    irIds.sort((a, b) => {
      const na = lookup?.get(a)?.name || a;
      const nb = lookup?.get(b)?.name || b;
      return na.localeCompare(nb);
    });
    return { benchIds, irIds };
  }, [allIds, starterSet, reserve, lookup]);

  function Row({ id }) {
    const meta = lookup?.get(id);
    const name = meta?.name || id;
    const pos = meta?.position || '—';
    const tm = meta?.team || '—';
    return (
      <tr>
        <td>
          {onViewRankings ? (
            <button
              type="button"
              className="my-team-roster__player-hit"
              onClick={() => onViewRankings(id)}
              aria-label={`Rankings and keeper value for ${name}`}
            >
              {name}
            </button>
          ) : (
            name
          )}
        </td>
        <td>{pos}</td>
        <td>{tm}</td>
      </tr>
    );
  }

  return (
    <div className="my-team-roster-scroll">
      <table className="my-team-roster">
        <thead>
          <tr>
            <th>Player</th>
            <th>Pos</th>
            <th>NFL</th>
          </tr>
        </thead>
        <tbody>
          {starters.length > 0 && (
            <>
              <tr className="my-team-roster__sec-title">
                <td colSpan={3}>
                  Starters ({starters.length})
                </td>
              </tr>
              {starters.map((id) => (
                <Row key={`s-${id}`} id={id} />
              ))}
            </>
          )}
          {rowIdsBenchIr.benchIds.length > 0 && (
            <>
              <tr className="my-team-roster__sec-title">
                <td colSpan={3}>Bench ({rowIdsBenchIr.benchIds.length})</td>
              </tr>
              {rowIdsBenchIr.benchIds.map((id) => (
                <Row key={`b-${id}`} id={id} />
              ))}
            </>
          )}
          {rowIdsBenchIr.irIds.length > 0 && (
            <>
              <tr className="my-team-roster__sec-title">
                <td colSpan={3}>IR / reserve ({rowIdsBenchIr.irIds.length})</td>
              </tr>
              {rowIdsBenchIr.irIds.map((id) => (
                <Row key={`r-${id}`} id={id} />
              ))}
            </>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default function MyTeam() {
  const { ready, authenticated, authEnabled, devBypass, user } = useAuth();
  const [searchParams] = useSearchParams();
  const commissionerAs =
    authEnabled && user?.role === 'commissioner' ? searchParams.get('user')?.trim() || '' : '';

  const effectiveOwnerId = commissionerAs || user?.sleeperUserId || '';

  const [lookup, setLookup] = useState(null);
  const [state, setState] = useState({ status: 'idle' });
  const [nominations, setNominations] = useState([]);
  const [rankingsFocusId, setRankingsFocusId] = useState(null);
  const [ecrRankings, setEcrRankings] = useState({ status: 'idle' });
  const [keeperCtx, setKeeperCtx] = useState({ status: 'idle' });

  useEffect(() => {
    let cancelled = false;
    getNflPlayersLookup().then((m) => {
      if (!cancelled) setLookup(m);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!ready || !authenticated || devBypass) {
      setEcrRankings({ status: 'idle' });
      return;
    }
    setEcrRankings({ status: 'loading' });
    fetch('/api/rankings?page_type=redraft-overall', { credentials: 'include' })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        return data;
      })
      .then((data) => {
        if (!cancelled) setEcrRankings({ status: 'ready', data });
      })
      .catch((err) => {
        if (!cancelled)
          setEcrRankings({ status: 'error', message: err.message || String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [ready, authenticated, devBypass]);

  const ecrReadyData = ecrRankings.status === 'ready' ? ecrRankings.data : null;

  useEffect(() => {
    let cancelled = false;
    if (!ready || !authenticated || devBypass) {
      setKeeperCtx({ status: 'idle' });
      return;
    }
    if (ecrRankings.status === 'error') {
      setKeeperCtx({ status: 'idle' });
      return;
    }
    if (!ecrReadyData?.players?.length) {
      setKeeperCtx({ status: 'idle' });
      return;
    }
    setKeeperCtx({ status: 'loading' });
    loadKeeperRankingsContext(ecrReadyData.players)
      .then((k) => {
        if (!cancelled) setKeeperCtx(k);
      })
      .catch((e) => {
        if (!cancelled) setKeeperCtx({ status: 'error', message: e.message || String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [ready, authenticated, devBypass, ecrRankings.status, ecrReadyData]);

  const ecrBySleeper = useMemo(() => {
    if (ecrRankings.status !== 'ready') return null;
    const m = new Map();
    for (const p of ecrRankings.data.players) {
      if (p.sleeper_id) m.set(String(p.sleeper_id), p);
    }
    return m;
  }, [ecrRankings]);

  const keeperBySleeper = useMemo(() => {
    if (keeperCtx.status !== 'ready') return null;
    const m = new Map();
    for (const r of keeperCtx.rows) {
      if (r.sleeper_id) m.set(String(r.sleeper_id), r);
    }
    return m;
  }, [keeperCtx]);

  const focusEcrPlayer =
    rankingsFocusId != null && ecrBySleeper ? ecrBySleeper.get(String(rankingsFocusId)) : null;
  const focusKeeperRow =
    rankingsFocusId != null && keeperBySleeper ? keeperBySleeper.get(String(rankingsFocusId)) : null;

  const load = useCallback(async () => {
    if (!config.leagueId) {
      setState({ status: 'no-config' });
      return;
    }
    if (!effectiveOwnerId) {
      setState({ status: 'needs-member' });
      return;
    }

    setState({ status: 'loading' });
    try {
      const chain = await resolveLeagueHistoryChain(config.leagueId);
      if (!chain.length) {
        setState({ status: 'error', message: 'No linked league seasons found.' });
        return;
      }
      const hit = await loadSeasonForOwner(chain, effectiveOwnerId);
      if (!hit) {
        setState({ status: 'not-found' });
        return;
      }

      const stats = computeStats(hit.bundle);
      const team = stats.teams.find((t) => t.ownerId === effectiveOwnerId);
      const rosterId = hit.roster.roster_id;
      const rank =
        team != null ? stats.standings.findIndex((t) => t.rosterId === team.rosterId) + 1 : null;

      const myWeekly = stats.weekly
        .filter((w) => w.rosterId === rosterId && w.points > 0)
        .sort((a, b) => b.week - a.week);
      const playedWeeksDesc = [...new Set(myWeekly.map((w) => w.week))].sort((a, b) => b - a);

      let bestWeek = null;
      let worstWeek = null;
      for (const w of myWeekly) {
        if (!bestWeek || w.points > bestWeek.points) bestWeek = w;
        if (!worstWeek || w.points < worstWeek.points) worstWeek = w;
      }

      const streak = computeWinLossStreak(hit.bundle, rosterId);
      const next = nextRegularOpponent(hit.bundle, rosterId, playedWeeksDesc);
      let nextLabel = null;
      if (next && team) {
        const oppTeam = stats.teams.find((t) => t.rosterId === next.oppRosterId);
        nextLabel = oppTeam
          ? `${oppTeam.name} (${oppTeam.wins}-${oppTeam.losses}${oppTeam.ties ? `-${oppTeam.ties}` : ''})`
          : null;
      }

      setState({
        status: 'ready',
        meta: hit.meta,
        bundle: hit.bundle,
        roster: hit.roster,
        stats,
        team,
        rank,
        bestWeek,
        worstWeek,
        streak,
        nextWeek: next?.week ?? null,
        nextOpponentLabel: nextLabel,
      });
    } catch (e) {
      setState({ status: 'error', message: e.message || String(e) });
    }
  }, [effectiveOwnerId]);

  useEffect(() => {
    if (!ready || !authenticated || devBypass) return;
    load();
  }, [ready, authenticated, devBypass, load]);

  useEffect(() => {
    if (!ready || !authenticated || devBypass) return;
    let cancelled = false;
    fetch('/api/keeper-nominations', { credentials: 'include' })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || String(res.status));
        return data.nominations || [];
      })
      .then((rows) => {
        if (!cancelled) setNominations(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (!cancelled) setNominations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [ready, authenticated, devBypass]);

  const seasonLabel = state.status === 'ready' ? String(state.meta.season) : '';
  const myNominations = useMemo(() => {
    if (!effectiveOwnerId) return [];
    return nominations.filter((n) => n.sleeper_user_id === effectiveOwnerId);
  }, [nominations, effectiveOwnerId]);

  const myLatestForSeason = useMemo(() => {
    if (!seasonLabel) return null;
    return myNominations.find((n) => n.source_season === seasonLabel) || null;
  }, [myNominations, seasonLabel]);

  const myLatestAny = useMemo(() => myNominations[0] || null, [myNominations]);
  const myLatest = myLatestForSeason || myLatestAny;

  if (!ready) {
    return (
      <div className="page my-team-page">
        <div className="skeleton" style={{ height: 24, width: '45%' }} />
        <div className="skeleton" style={{ height: 120, width: '100%' }} />
      </div>
    );
  }

  if (!authEnabled || devBypass) {
    return (
      <div className="page my-team-page">
        <p className="muted">Turn on app login to use My team.</p>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="page my-team-page">
        <p className="muted">
          <Link to="/login">Sign in</Link> to see your roster.
        </p>
      </div>
    );
  }

  if (state.status === 'needs-member') {
    return (
      <div className="page my-team-page">
        <header className="page-header">
          <span className="eyebrow">Your roster</span>
          <h1>My team</h1>
        </header>
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            Sign in with your <strong>member</strong> account (linked to your Sleeper user id) to see your roster here.
            Shared site-password-only sessions can’t identify which team is yours.
          </p>
          {user?.role === 'commissioner' && (
            <p className="muted" style={{ marginTop: 12 }}>
              Commissioners can preview any manager’s page with{' '}
              <code style={{ fontSize: 13 }}>?user=&lt;sleeper_user_id&gt;</code> on this URL.
            </p>
          )}
        </div>
      </div>
    );
  }

  if (state.status === 'no-config') {
    return (
      <div className="page my-team-page">
        <p className="muted">Set VITE_SLEEPER_LEAGUE_ID to load league data.</p>
      </div>
    );
  }

  if (state.status === 'loading' || state.status === 'idle') {
    return (
      <div className="page my-team-page">
        <div className="skeleton" style={{ height: 22, width: '40%' }} />
        <div className="skeleton" style={{ height: 140, width: '100%' }} />
        <div className="skeleton" style={{ height: 220, width: '100%' }} />
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="page my-team-page">
        <p className="muted" role="alert">
          {state.message}
        </p>
      </div>
    );
  }

  if (state.status === 'not-found') {
    return (
      <div className="page my-team-page">
        <header className="page-header">
          <span className="eyebrow">Your roster</span>
          <h1>My team</h1>
        </header>
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            Could not find a linked season where this Sleeper account has players on a roster. If you joined late or the
            league rolled over, ask the commissioner to verify your Sleeper user id on your login account.
          </p>
        </div>
      </div>
    );
  }

  const { team, roster, rank, bestWeek, worstWeek, streak, nextWeek, nextOpponentLabel, meta } = state;

  return (
    <div className="page my-team-page">
      <header className="page-header">
        <span className="eyebrow">Your roster</span>
        <h1>My team</h1>
      </header>

      {commissionerAs && (
        <p className="muted" style={{ margin: '-8px 0 0' }}>
          Commissioner view-as <code style={{ fontSize: 13 }}>{commissionerAs}</code>.{' '}
          <Link to="/me">Back to my team</Link>
        </p>
      )}

      <section className="card my-team-head">
        <div className="my-team-brand">
          {team?.avatar ? (
            <img src={team.avatar} alt="" width={56} height={56} />
          ) : (
            <div style={{ width: 56, height: 56, borderRadius: 12, background: 'rgba(100,116,139,0.25)' }} aria-hidden />
          )}
          <div className="my-team-brand__meta">
            <h2 className="my-team-brand__title">{team?.name || 'Your team'}</h2>
            <p className="muted">
              {team?.handle ? `${team.handle} · ` : ''}
              {meta.season} season
              {meta.name ? ` · ${meta.name}` : ''}
            </p>
          </div>
        </div>

        <div className="my-team-summary-grid">
          <div className="my-team-stat">
            <div className="my-team-stat__label">Record</div>
            <div className="my-team-stat__value">
              {team ? `${team.wins}-${team.losses}${team.ties ? `-${team.ties}` : ''}` : '—'}
            </div>
          </div>
          <div className="my-team-stat">
            <div className="my-team-stat__label">PF</div>
            <div className="my-team-stat__value">{team ? fmtPf(team.fpts) : '—'}</div>
          </div>
          <div className="my-team-stat">
            <div className="my-team-stat__label">PA</div>
            <div className="my-team-stat__value">{team ? fmtPf(team.fptsAgainst) : '—'}</div>
          </div>
          <div className="my-team-stat">
            <div className="my-team-stat__label">Standing</div>
            <div className="my-team-stat__value">{rank != null ? `#${rank}` : '—'}</div>
          </div>
          <div className="my-team-stat">
            <div className="my-team-stat__label">Best week</div>
            <div className="my-team-stat__value">{bestWeek ? `${fmtPf(bestWeek.points)} · W${bestWeek.week}` : '—'}</div>
          </div>
          <div className="my-team-stat">
            <div className="my-team-stat__label">Worst week</div>
            <div className="my-team-stat__value">{worstWeek ? `${fmtPf(worstWeek.points)} · W${worstWeek.week}` : '—'}</div>
          </div>
          <div className="my-team-stat">
            <div className="my-team-stat__label">Streak</div>
            <div className="my-team-stat__value">{streak ?? '—'}</div>
          </div>
          <div className="my-team-stat">
            <div className="my-team-stat__label">Next opp.</div>
            <div className="my-team-stat__value" style={{ fontSize: '0.95rem' }}>
              {nextWeek != null && nextOpponentLabel ? (
                <>
                  W{nextWeek} · {nextOpponentLabel}
                </>
              ) : (
                '—'
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="card my-team-roster-card">
        <h2>Roster</h2>
        <p className="muted my-team-roster-hint">Tap a player name for expert / keeper stats (same data as Rankings).</p>
        <RosterTable roster={roster} lookup={lookup} onViewRankings={(id) => setRankingsFocusId(id)} />
      </section>

      <PlayerRankingsSheet
        open={rankingsFocusId != null}
        onClose={() => setRankingsFocusId(null)}
        focusPlayerId={rankingsFocusId}
        lookup={lookup}
        ecrRankings={ecrRankings}
        keeperCtx={keeperCtx}
        ecrPlayer={focusEcrPlayer}
        keeperRow={focusKeeperRow}
      />

      <section className="card my-team-keepers-card">
        <h2 style={{ margin: 0, fontSize: '1.05rem' }}>Keeper nominations</h2>
        <p className="muted" style={{ marginTop: 8 }}>
          Latest submission from the Keepers page (same season when available).
        </p>
        {!myLatest && <p className="muted">No nominations saved yet.</p>}
        {myLatest && (
          <>
            {!myLatestForSeason && seasonLabel && (
              <p className="muted" style={{ fontSize: 13 }}>
                Nothing on file for <strong>{seasonLabel}</strong> — showing season <strong>{myLatest.source_season}</strong>.
              </p>
            )}
            <p className="my-team-keepers-picks">{fmtNominationRow(myLatest, lookup)}</p>
            <div className="my-team-keepers-meta">
              <span>{myLatest.nomination_kind}</span>
              <span>Season {myLatest.source_season}</span>
              <span>{myLatest.updated_at ? new Date(myLatest.updated_at).toLocaleString() : ''}</span>
            </div>
          </>
        )}
        {canAccessKeepers() ? (
          <p style={{ marginTop: 14 }}>
            <Link to="/keepers">Edit on Keepers page →</Link>
          </p>
        ) : null}
      </section>
    </div>
  );
}
