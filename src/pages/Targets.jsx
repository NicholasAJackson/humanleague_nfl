import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { canAccessTradeAnalyzer, isConfigured } from '../config.js';
import { useAuth } from '../AuthContext.jsx';
import { useLeague } from '../LeagueContext.jsx';
import {
  resolveLeagueHistoryChain,
  fetchSeasonBundle,
  fetchUsers,
  getNflPlayersLookup,
  rosterPlayerIds,
} from '../lib/sleeper.js';
import { rosterPlayerIdSet } from '../lib/keeperRankings.js';
import { formatWeightSummary } from '../lib/tradeBlend.js';
import {
  findWaiverTargets,
  valuedPlayerFromSources,
  WAIVER_POS_ORDER,
} from '../lib/waiverUpgrades.js';
import './Targets.css';

function managerOptions(users) {
  if (!Array.isArray(users)) return [];
  return users
    .filter((u) => u.user_id)
    .map((u) => ({
      id: String(u.user_id),
      label: String(u.metadata?.team_name || u.display_name || u.user_id).trim() || String(u.user_id),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

async function loadSeasonForOwner(chain, ownerId) {
  const want = String(ownerId);
  for (const meta of chain) {
    try {
      const bundle = await fetchSeasonBundle(meta.leagueId);
      const roster = bundle.rosters?.find((r) => r.owner_id != null && String(r.owner_id) === want);
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

function fmtUpgrade(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const v = Number(n);
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}`;
}

function posHeading(pos) {
  if (pos === 'FLEX') return 'FLEX · RB / WR';
  return pos;
}

export default function Targets() {
  const { ready, authenticated, authEnabled, devBypass, user } = useAuth();
  const { leagueId, isGuest, guestOwnerId, setGuestOwnerId, guestLeagueName } = useLeague();
  const [searchParams, setSearchParams] = useSearchParams();
  const commissionerAs =
    !isGuest && authEnabled && user?.role === 'commissioner'
      ? searchParams.get('user')?.trim() || ''
      : '';

  /** Manual pick when guest, or member/shared session without a linked Sleeper id. */
  const [pickedOwnerId, setPickedOwnerId] = useState('');

  useEffect(() => {
    if (isGuest) return;
    if (commissionerAs) return;
    if (pickedOwnerId) return;
    if (typeof user?.sleeperUserId === 'string' && user.sleeperUserId) {
      setPickedOwnerId(user.sleeperUserId);
    }
  }, [isGuest, commissionerAs, pickedOwnerId, user?.sleeperUserId]);

  const effectiveOwnerId = isGuest
    ? guestOwnerId || ''
    : commissionerAs || pickedOwnerId || '';

  const canLoad =
    Boolean(ready) &&
    ((isGuest && isConfigured(leagueId)) || (authenticated && !devBypass));

  const [lookup, setLookup] = useState(null);
  const [blend, setBlend] = useState({ status: 'idle' });
  const [rosterState, setRosterState] = useState({ status: 'idle' });
  const [teamChoices, setTeamChoices] = useState({ status: 'idle', options: [] });

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
    if (!canLoad || !isConfigured(leagueId)) {
      setTeamChoices({ status: 'idle', options: [] });
      return;
    }
    let cancelled = false;
    setTeamChoices({ status: 'loading', options: [] });
    fetchUsers(leagueId)
      .then((users) => {
        if (!cancelled) setTeamChoices({ status: 'ready', options: managerOptions(users) });
      })
      .catch((err) => {
        if (!cancelled) {
          setTeamChoices({
            status: 'error',
            options: [],
            message: err?.message || 'Could not load managers',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [canLoad, leagueId]);

  useEffect(() => {
    let cancelled = false;
    if (!canLoad) {
      setBlend({ status: 'idle' });
      return;
    }
    setBlend({ status: 'loading' });
    fetch('/api/rankings?page_type=sleeper-trade-blend', { credentials: 'include' })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        return data;
      })
      .then((data) => {
        if (!cancelled) setBlend({ status: 'ready', data });
      })
      .catch((err) => {
        if (!cancelled) setBlend({ status: 'error', message: err.message || String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [canLoad]);

  const loadRoster = useCallback(async () => {
    if (!isConfigured(leagueId)) {
      setRosterState({ status: 'no-config' });
      return;
    }
    if (!effectiveOwnerId) {
      setRosterState({ status: 'needs-pick' });
      return;
    }
    setRosterState({ status: 'loading' });
    try {
      const chain = await resolveLeagueHistoryChain(leagueId);
      if (!chain.length) {
        setRosterState({ status: 'error', message: 'No linked league seasons found.' });
        return;
      }
      const hit = await loadSeasonForOwner(chain, effectiveOwnerId);
      if (!hit) {
        setRosterState({ status: 'not-found' });
        return;
      }
      const u = (hit.bundle.users || []).find((x) => String(x.user_id) === String(effectiveOwnerId));
      setRosterState({
        status: 'ready',
        roster: hit.roster,
        rosters: hit.bundle.rosters,
        meta: hit.meta,
        teamName: u?.metadata?.team_name || u?.display_name || null,
      });
    } catch (e) {
      setRosterState({ status: 'error', message: e.message || String(e) });
    }
  }, [leagueId, effectiveOwnerId]);

  useEffect(() => {
    if (!canLoad) return;
    loadRoster();
  }, [canLoad, loadRoster]);

  const result = useMemo(() => {
    if (blend.status !== 'ready' || rosterState.status !== 'ready' || !rosterState.roster) return null;
    const players = blend.data?.players || [];
    const blendById = new Map();
    for (const p of players) {
      if (p.sleeper_id) blendById.set(String(p.sleeper_id), p);
    }
    const owned = rosterPlayerIdSet(rosterState.rosters);
    const rosterPlayers = rosterPlayerIds(rosterState.roster).map((id) =>
      valuedPlayerFromSources(id, blendById, lookup),
    );
    const freeAgents = [];
    for (const p of players) {
      const sid = p.sleeper_id != null ? String(p.sleeper_id) : '';
      if (!sid || owned.has(sid)) continue;
      freeAgents.push(valuedPlayerFromSources(sid, blendById, lookup));
    }
    return findWaiverTargets({ rosterPlayers, freeAgents });
  }, [blend, rosterState, lookup]);

  const weightLine =
    blend.status === 'ready' && blend.data?.weights
      ? formatWeightSummary(blend.data.weights, (blend.data.recent_weeks || []).length)
      : '';

  function onPickTeam(e) {
    const id = e.target.value;
    if (isGuest) {
      setGuestOwnerId(id || null);
      return;
    }
    if (user?.role === 'commissioner') {
      if (id) setSearchParams({ user: id });
      else setSearchParams({});
      return;
    }
    setPickedOwnerId(id || '');
  }

  const selectValue = effectiveOwnerId;

  if (!ready) {
    return (
      <div className="page targets-page">
        <div className="skeleton" style={{ height: 24, width: '40%' }} />
        <div className="skeleton" style={{ height: 160, width: '100%' }} />
      </div>
    );
  }

  if (!isGuest && (!authEnabled || devBypass)) {
    return (
      <div className="page targets-page">
        <p className="muted">Turn on app login to use Target, or browse with a Sleeper league ID.</p>
      </div>
    );
  }

  if (!isGuest && !authenticated) {
    return (
      <div className="page targets-page">
        <p className="muted">
          <Link to="/login">Sign in</Link> or paste a league ID to see waiver targets.
        </p>
      </div>
    );
  }

  if (rosterState.status === 'no-config') {
    return (
      <div className="page targets-page">
        <p className="muted">
          {isGuest
            ? 'Paste a Sleeper league ID from the login screen to load a league.'
            : 'Set VITE_SLEEPER_LEAGUE_ID to load league data.'}
        </p>
      </div>
    );
  }

  return (
    <div className="page targets-page">
      <header className="page-header">
        <span className="eyebrow">Waiver wire</span>
        <h1>Target</h1>
        <p className="muted targets-lead">
          Top 3 free agents at every position for your roster, plus FLEX targets (RB / WR), ranked on
          the same in-season trade blend as the Trade analyzer.
          {weightLine ? ` ${weightLine}.` : ''}
          {guestLeagueName ? ` · ${guestLeagueName}` : ''}
        </p>
      </header>

      <div className="targets-toolbar card">
        <div className="targets-field">
          <label htmlFor="targets-team-pick">Team</label>
          {teamChoices.status === 'loading' || teamChoices.status === 'idle' ? (
            <p className="muted" style={{ margin: 0 }}>
              Loading managers…
            </p>
          ) : null}
          {teamChoices.status === 'error' ? (
            <p className="muted" role="alert" style={{ margin: 0 }}>
              {teamChoices.message}
            </p>
          ) : null}
          {teamChoices.status === 'ready' ? (
            <select id="targets-team-pick" value={selectValue} onChange={onPickTeam}>
              <option value="">Select a team…</option>
              {teamChoices.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : null}
        </div>
        {rosterState.status === 'ready' && rosterState.teamName ? (
          <p className="muted targets-team-meta">
            {rosterState.meta?.season ? `${rosterState.meta.season} · ` : ''}
            {rosterState.teamName}
          </p>
        ) : null}
      </div>

      {!effectiveOwnerId && (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            Choose your team to see top 3 waiver targets at each position.
          </p>
        </div>
      )}

      {effectiveOwnerId && (rosterState.status === 'loading' || rosterState.status === 'idle') && (
        <>
          <div className="skeleton" style={{ height: 120, width: '100%' }} />
          <div className="skeleton" style={{ height: 120, width: '100%' }} />
        </>
      )}

      {rosterState.status === 'error' && (
        <p className="muted" role="alert">
          {rosterState.message}
        </p>
      )}

      {rosterState.status === 'not-found' && (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            Could not find a roster with players for that manager. Pick a different team.
          </p>
        </div>
      )}

      {blend.status === 'loading' && rosterState.status === 'ready' && (
        <p className="muted">Loading waiver values…</p>
      )}
      {blend.status === 'error' && (
        <p className="muted" role="alert">
          Could not load waiver values: {blend.message}
        </p>
      )}

      {result && result.holes.length > 0 && (
        <p className="targets-holes">
          Starter holes:{' '}
          {result.holes.map((h) => (
            <span key={h} className="targets-chip">
              {h}
            </span>
          ))}
        </p>
      )}

      {result && (
        <div className="targets-by-pos">
          {WAIVER_POS_ORDER.map((pos) => {
            const rows = result.byPos[pos] || [];
            return (
              <section key={pos} className="card targets-pos-card">
                <h2 className="targets-pos-title">
                  <span
                    className={`my-team-pos my-team-pos--${pos === 'FLEX' ? 'flex' : pos.toLowerCase()}`}
                  >
                    {pos}
                  </span>
                  <span className="targets-pos-label">{posHeading(pos)}</span>
                  <span className="muted">{rows.length}/3</span>
                </h2>
                {rows.length === 0 ? (
                  <p className="muted" style={{ margin: 0 }}>
                    No unowned {pos === 'FLEX' ? 'RB/WR' : pos} players on the rankings blend.
                  </p>
                ) : (
                  <div className="targets-table-scroll">
                    <table className="targets-table">
                      <thead>
                        <tr>
                          <th>Player</th>
                          <th>Pos</th>
                          <th>Slot</th>
                          <th>Value</th>
                          <th>Upgrade</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((u) => {
                          const id = String(u.player.sleeper_id);
                          const name = u.player.name || id;
                          const p = u.player.pos || '—';
                          return (
                            <tr key={`${pos}-${id}`}>
                              <td>
                                {name}
                                {u.fillsNeed ? (
                                  <span className="targets-need">Fills hole</span>
                                ) : null}
                              </td>
                              <td>
                                <span className={`my-team-pos my-team-pos--${String(p).toLowerCase()}`}>
                                  {p}
                                </span>
                              </td>
                              <td>{u.slot}</td>
                              <td>{Number.isFinite(u.value) ? u.value.toFixed(1) : '—'}</td>
                              <td
                                className={
                                  'targets-delta' +
                                  (u.upgrade > 0.4 ? ' is-up' : u.upgrade < -0.4 ? ' is-down' : '')
                                }
                              >
                                {fmtUpgrade(u.upgrade)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      {canAccessTradeAnalyzer(user, devBypass, isGuest) ? (
        <p className="targets-footer-links">
          <Link to="/trades">Trade analyzer →</Link>
          <Link to="/me">My team →</Link>
        </p>
      ) : (
        <p className="targets-footer-links">
          <Link to="/me">My team →</Link>
        </p>
      )}
    </div>
  );
}
