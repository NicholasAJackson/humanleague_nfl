import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { areKeeperNominationsClosed, areKeeperNominationsHiddenInUi, config } from '../config.js';
import { useAuth } from '../AuthContext.jsx';
import {
  resolveLeagueHistoryChain,
  fetchUsers,
  fetchRosters,
  getNflPlayersLookup,
  rosterPlayerIds,
} from '../lib/sleeper.js';
import './Keepers.css';

function formatRevealLabel(isoRaw) {
  const ts = Date.parse(isoRaw);
  if (!Number.isFinite(ts)) return isoRaw;
  return new Date(ts).toLocaleString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function fmtNominationRow(n, lookup) {
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

export default function Keepers() {
  const { user: authUser } = useAuth();
  const lockedSleeperUserId =
    authUser && authUser.role !== 'commissioner' && typeof authUser.sleeperUserId === 'string'
      ? authUser.sleeperUserId
      : null;

  const [chain, setChain] = useState([]);
  const [chainLoading, setChainLoading] = useState(true);
  const [lookup, setLookup] = useState(null);
  const [lookupErr, setLookupErr] = useState(null);

  const [seasonLeagueId, setSeasonLeagueId] = useState('');
  const [seasonLabel, setSeasonLabel] = useState('');
  const [users, setUsers] = useState([]);
  const [rosters, setRosters] = useState([]);
  const [leagueLoading, setLeagueLoading] = useState(false);

  const [sleeperUserId, setSleeperUserId] = useState('');
  const [k1, setK1] = useState('');
  const [k2, setK2] = useState('');
  const [k3, setK3] = useState('');

  const [nameByUserId, setNameByUserId] = useState({});
  const [nominations, setNominations] = useState([]);
  const [listLoading, setListLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [formMsg, setFormMsg] = useState(null);
  const [formErr, setFormErr] = useState(null);

  const nominationsHidden = areKeeperNominationsHiddenInUi();
  const nominationsClosed = areKeeperNominationsClosed();

  useEffect(() => {
    if (!config.leagueId) {
      setChain([]);
      setChainLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const c = await resolveLeagueHistoryChain(config.leagueId);
        if (!cancelled) {
          setChain(c);
          if (c[0]) {
            setSeasonLeagueId(c[0].leagueId);
            setSeasonLabel(String(c[0].season));
          }
        }
      } finally {
        if (!cancelled) setChainLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!config.leagueId) return;
    let cancelled = false;
    fetchUsers(config.leagueId)
      .then((users) => {
        if (!cancelled && Array.isArray(users)) {
          const m = {};
          for (const u of users) {
            m[u.user_id] = u.metadata?.team_name || u.display_name || u.user_id;
          }
          setNameByUserId(m);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    getNflPlayersLookup()
      .then((m) => {
        if (!cancelled) setLookup(m);
      })
      .catch(() => {
        if (!cancelled) {
          setLookup(null);
          setLookupErr('Could not load NFL player names (offline or blocked). Roster mode still works by player id.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Always fetch — even when the league table is gated by the reveal date,
  // we still need the data to show the manager their own most recent picks.
  const loadNominations = useCallback(async () => {
    setListLoading(true);
    try {
      const res = await fetch('/api/keeper-nominations', { credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Failed (${res.status})`);
      setNominations(data.nominations || []);
    } catch (e) {
      setNominations([]);
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    loadNominations();
  }, [loadNominations]);

  useEffect(() => {
    if (lockedSleeperUserId && sleeperUserId !== lockedSleeperUserId) {
      setSleeperUserId(lockedSleeperUserId);
    }
  }, [lockedSleeperUserId, sleeperUserId]);

  useEffect(() => {
    if (!seasonLeagueId) {
      setUsers([]);
      setRosters([]);
      return;
    }
    let cancelled = false;
    setLeagueLoading(true);
    (async () => {
      try {
        const [u, r] = await Promise.all([fetchUsers(seasonLeagueId), fetchRosters(seasonLeagueId)]);
        if (!cancelled) {
          setUsers(Array.isArray(u) ? u : []);
          setRosters(Array.isArray(r) ? r : []);
        }
      } catch {
        if (!cancelled) {
          setUsers([]);
          setRosters([]);
        }
      } finally {
        if (!cancelled) setLeagueLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [seasonLeagueId]);

  const userOptions = useMemo(() => {
    const sorted = [...users].sort((a, b) => {
      const na = (a.metadata?.team_name || a.display_name || a.user_id || '').toLowerCase();
      const nb = (b.metadata?.team_name || b.display_name || b.user_id || '').toLowerCase();
      return na.localeCompare(nb);
    });
    if (!lockedSleeperUserId) return sorted;
    const mine = sorted.find((u) => u.user_id === lockedSleeperUserId);
    return mine ? [mine] : sorted;
  }, [users, lockedSleeperUserId]);

  const myNominations = useMemo(() => {
    if (!sleeperUserId) return [];
    return nominations.filter((n) => n.sleeper_user_id === sleeperUserId);
  }, [nominations, sleeperUserId]);

  const myLatestForSeason = useMemo(() => {
    if (!seasonLabel) return null;
    return myNominations.find((n) => n.source_season === seasonLabel) || null;
  }, [myNominations, seasonLabel]);

  const myLatestAny = useMemo(() => myNominations[0] || null, [myNominations]);

  const myLatest = myLatestForSeason || myLatestAny;

  const rosterPickOptions = useMemo(() => {
    if (!sleeperUserId || !rosters.length) return [];
    const roster = rosters.find((x) => x.owner_id === sleeperUserId);
    const ids = rosterPlayerIds(roster);
    const opts = ids.map((id) => {
      const meta = lookup?.get(id);
      const label = meta ? `${meta.name} (${meta.position || '?'})` : id;
      return { id, label };
    });
    opts.sort((a, b) => a.label.localeCompare(b.label));
    return opts;
  }, [sleeperUserId, rosters, lookup]);

  async function onSubmit(e) {
    e.preventDefault();
    setFormMsg(null);
    setFormErr(null);

    if (areKeeperNominationsClosed()) {
      setFormErr('Keeper nominations are locked — the reveal time has passed.');
      return;
    }
    if (!sleeperUserId) {
      setFormErr('Choose which manager you are (Sleeper account).');
      return;
    }
    if (!seasonLabel) {
      setFormErr('League season is still loading — wait a moment and try again.');
      return;
    }

    if (!k1) {
      setFormErr('Keeper 1 (guaranteed) is required — pick a player from your roster.');
      return;
    }
    const wantsExtras = Boolean(k2) || Boolean(k3);
    if (wantsExtras && (!k2 || !k3)) {
      setFormErr('To nominate a second keeper you must enter BOTH keeper 2 and 3 — one is randomised.');
      return;
    }
    if (k2 && k3 && new Set([k1, k2, k3]).size !== 3) {
      setFormErr('Pick three different players.');
      return;
    }

    const body = {
      sleeper_user_id: sleeperUserId,
      source_season: seasonLabel,
      league_id_snapshot: seasonLeagueId || null,
      nomination_kind: 'roster',
      k1_player_id: k1,
      k2_player_id: k2 || null,
      k3_player_id: k3 || null,
    };

    setSubmitting(true);
    try {
      const res = await fetch('/api/keeper-nominations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setFormMsg('Saved. Your nomination is stored; the league list stays hidden until the reveal date.');
      await loadNominations();
    } catch (err) {
      setFormErr(err.message || 'Could not save');
    } finally {
      setSubmitting(false);
    }
  }

  if (!config.leagueId) {
    return (
      <div className="page">
        <p className="muted">Set VITE_SLEEPER_LEAGUE_ID to use keeper nominations.</p>
      </div>
    );
  }

  return (
    <div className="page keepers-page">
      <header className="page-header">
        <span className="eyebrow">Off-season</span>
        <h1>Keeper nominations</h1>
      </header>

      <details className="keepers-help">
        <summary className="keepers-help__summary">
          <span className="keepers-help__icon" aria-hidden="true">?</span>
          <span className="keepers-help__label">Keeper Rules</span>
          <span className="keepers-help__hint">How keepers work</span>
          <svg
            className="keepers-help__chevron"
            viewBox="0 0 24 24"
            width="16"
            height="16"
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
        <div className="keepers-help__body">
          <p className="muted">
            <strong>Keeper 1 is your guaranteed pick.</strong> If you want a second keeper, you must nominate{' '}
            <strong>both</strong> keeper 2 <em>and</em> keeper 3 — we will have a coin flipping ceremony to decide who
            you get to keep. Picking just one keeper is fine; picking exactly two is not allowed. 
          </p>
          <p className="muted">
          You will lose the draft
            pick in the upcoming draft wherever your keeper was picked last season. E.g. Gabe Nabers was drafted in the
            3rd, meaning Georgia will lose that pick because she will obviously be keeping this <strong>ELITE</strong> player.
          </p>
        </div>
      </details>

      {lookupErr && (
        <p className="keepers-warn" role="status">
          {lookupErr}
        </p>
      )}

      {!chainLoading && chain.length === 0 && (
        <div className="card keepers-inline-notice" role="status">
          No linked league seasons found — roster source dropdown will be empty until the league chain resolves.
        </div>
      )}

      {sleeperUserId && !listLoading && (
        <section className="card keepers-mine-card" aria-live="polite">
          <p className="keepers-mine-eyebrow">Your last submitted picks</p>
          {!myLatest && (
            <p className="keepers-mine-empty">
              You haven’t submitted any keeper nominations yet. Use the form below to lock in keeper 1 (and optionally
              keepers 2 + 3 for the randomiser).
            </p>
          )}
          {myLatest && (
            <>
              {!myLatestForSeason && (
                <p className="keepers-mine-note">
                  No picks for <strong>{seasonLabel || 'the selected season'}</strong> yet — showing your most recent
                  submission for <strong>{myLatest.source_season}</strong>.
                </p>
              )}
              <p className="keepers-mine-picks">{fmtNominationRow(myLatest, lookup)}</p>
              <p className="keepers-mine-meta">
                <span className="keepers-type-pill">
                  {myLatest.nomination_kind}
                </span>
                <span>Season {myLatest.source_season}</span>
                <span>
                  Saved{' '}
                  {myLatest.updated_at ? new Date(myLatest.updated_at).toLocaleString() : '—'}
                </span>
              </p>
            </>
          )}
        </section>
      )}

      {nominationsClosed ? (
        <section className="card keepers-form-card" aria-live="polite">
          <div className="keepers-reveal-gate" role="status">
            <p className="keepers-reveal-gate__title">Nominations locked</p>
            <p className="keepers-reveal-gate__body">
              The reveal time has passed — nominations can no longer be submitted or changed.
            </p>
          </div>
        </section>
      ) : (
        <form className="card keepers-form keepers-form-card" onSubmit={onSubmit}>
          <div className="keepers-locked-season">
            <span className="keepers-label">Keepers carry into</span>
            {chainLoading || !chain[0] ? (
              <span className="keepers-locked-season__value muted">Loading league season…</span>
            ) : (
              <>
                <span className="keepers-locked-season__value">
                  {Number(chain[0].season) + 1} season
                </span>
                <span className="keepers-locked-season__sub">
                  Picked from your <strong>{chain[0].season}</strong> roster
                  {chain[0].name ? ` · ${chain[0].name}` : ''}
                </span>
              </>
            )}
          </div>

          <label>
            <span className="keepers-label">You are (Sleeper manager)</span>
            <select
              value={sleeperUserId}
              disabled={leagueLoading || !userOptions.length || Boolean(lockedSleeperUserId)}
              onChange={(e) => setSleeperUserId(e.target.value)}
              required
            >
              <option value="">Select your team…</option>
              {userOptions.map((u) => (
                <option key={u.user_id} value={u.user_id}>
                  {u.metadata?.team_name || u.display_name || u.user_id}
                </option>
              ))}
            </select>
            {lockedSleeperUserId && (
              <p className="keepers-hint keepers-hint--inline">
                You can only nominate keepers for your own team.
              </p>
            )}
            {lockedSleeperUserId && !leagueLoading && users.length > 0 && !users.some((u) => u.user_id === lockedSleeperUserId) && (
              <p className="keepers-warn">
                Your account isn’t in this season’s roster. Pick a different season or ask the commissioner to check your
                Sleeper id.
              </p>
            )}
          </label>

          <p className="keepers-hint">
            First load may take a few seconds while player names download from Sleeper.
          </p>
          <label>
            <span className="keepers-label">Keeper 1 (guaranteed)</span>
            <select value={k1} onChange={(e) => setK1(e.target.value)} required disabled={!rosterPickOptions.length}>
              <option value="">Select player…</option>
              {rosterPickOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="keepers-label">Keeper 2 (optional, randomised)</span>
            <select value={k2} onChange={(e) => setK2(e.target.value)} disabled={!rosterPickOptions.length}>
              <option value="">— skip (no second keeper) —</option>
              {rosterPickOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="keepers-label">Keeper 3 (optional, randomised)</span>
            <select value={k3} onChange={(e) => setK3(e.target.value)} disabled={!rosterPickOptions.length}>
              <option value="">— skip (no second keeper) —</option>
              {rosterPickOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          {!sleeperUserId && <p className="keepers-hint keepers-hint--inline">Select yourself first to load your roster.</p>}
          {sleeperUserId && !leagueLoading && rosterPickOptions.length === 0 && (
            <p className="keepers-warn">No players found on your roster for this league/season.</p>
          )}

          {formErr && <p className="keepers-err">{formErr}</p>}
          {formMsg && <p className="keepers-ok">{formMsg}</p>}

          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? 'Saving…' : 'Save nomination'}
          </button>
        </form>
      )}

      <section className="card keepers-list-card">
        <h2 className="keepers-list-title">All nominations</h2>
        <p className="keepers-list-lead">
          {nominationsHidden ? (
            <>
              Everyone’s picks stay private until the reveal. You can still submit or update your own nomination above;
              the full list appears here after that time.
            </>
          ) : (
            <>One row per manager per season. Nominations are locked after the reveal.</>
          )}
        </p>
        {nominationsHidden ? (
          <div className="keepers-reveal-gate" role="status">
            <p className="keepers-reveal-gate__title">Nominations hidden</p>
            <p className="keepers-reveal-gate__body">
              The league table is hidden until{' '}
              <strong>{config.keepersRevealAt ? formatRevealLabel(config.keepersRevealAt) : 'the reveal date'}</strong>.
            </p>
          </div>
        ) : (
          <>
            {listLoading && <p className="muted">Loading…</p>}
            {!listLoading && nominations.length === 0 && <p className="muted">No nominations yet.</p>}
            {!listLoading && nominations.length > 0 && (
              <div className="scroll-x">
                <div className="keepers-table-wrap">
                  <table className="keepers-table">
                    <thead>
                      <tr>
                        <th>Season</th>
                        <th>Manager</th>
                        <th>Type</th>
                        <th>Keepers</th>
                        <th>Updated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {nominations.map((n) => (
                        <tr key={n.id}>
                          <td className="tabular">{n.source_season}</td>
                          <td>
                            <div>{nameByUserId[n.sleeper_user_id] || '—'}</div>
                            <div className="keepers-mono dim" style={{ fontSize: 11, marginTop: 2 }}>
                              {n.sleeper_user_id}
                            </div>
                          </td>
                          <td>
                            <span
                              className={
                                'keepers-type-pill' +
                                (n.nomination_kind === 'freeform' ? ' keepers-type-pill--freeform' : '')
                              }
                            >
                              {n.nomination_kind}
                            </span>
                          </td>
                          <td>{fmtNominationRow(n, lookup)}</td>
                          <td className="keepers-table-date">
                            {n.updated_at ? new Date(n.updated_at).toLocaleString() : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
