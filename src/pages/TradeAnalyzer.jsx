import React, { useEffect, useMemo, useState } from 'react';
import { config, isConfigured } from '../config.js';
import { useAuth } from '../AuthContext.jsx';
import {
  resolveLeagueHistoryChain,
  fetchSeasonBundle,
  rosterPlayerIds,
} from '../lib/sleeper.js';
import { analyzeTrade, ecrToTradeValue } from '../lib/tradeValue.js';
import {
  needHoleLabels,
  rosterStarterNeeds,
  scoreTradeRosterImpact,
} from '../lib/rosterNeeds.js';
import { findTradeSuggestions } from '../lib/tradeFinder.js';
import './TradeAnalyzer.css';

const MAX_PER_SIDE = 5;
const NONE = '';

function formatScrapeDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function playerKey(p) {
  if (p?.sleeper_id) return `s:${p.sleeper_id}`;
  if (p?.fp_id) return `fp:${p.fp_id}`;
  return `n:${p?.name}:${p?.pos}:${p?.team}`;
}

function toTradePlayer(p) {
  return {
    name: p.name,
    pos: p.pos,
    team: p.team,
    ecr: p.ecr,
    sleeper_id: p.sleeper_id || null,
    fp_id: p.fp_id || null,
  };
}

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

function fmtUpgrade(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const v = Number(n);
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}`;
}

/** Prefer the newest linked season that still has rostered players. */
async function loadRosterContext(leagueId) {
  const chain = await resolveLeagueHistoryChain(leagueId);
  for (const meta of chain) {
    const bundle = await fetchSeasonBundle(meta.leagueId);
    const hasPlayers = (bundle.rosters || []).some((r) => rosterPlayerIds(r).length > 0);
    if (!hasPlayers) continue;
    const byOwner = new Map();
    for (const roster of bundle.rosters || []) {
      if (roster?.owner_id == null) continue;
      byOwner.set(String(roster.owner_id), new Set(rosterPlayerIds(roster)));
    }
    return {
      season: meta.season || bundle.league?.season || null,
      users: bundle.users || [],
      byOwner,
    };
  }
  return { season: null, users: [], byOwner: new Map() };
}

function SidePanel({
  title,
  sideKey,
  players,
  total,
  bonus,
  poolLabel,
  search,
  onSearchChange,
  suggestions,
  onAdd,
  onRemove,
  disabled,
}) {
  return (
    <section className="trade-side card" aria-labelledby={`trade-side-${sideKey}`}>
      <header className="trade-side__head">
        <h2 id={`trade-side-${sideKey}`} className="trade-side__title">
          {title}
        </h2>
        <div className="trade-side__total" aria-live="polite">
          <span className="trade-side__total-label">Value</span>
          <strong>{total.toFixed(1)}</strong>
          {bonus > 0 ? <span className="trade-side__bonus">+{bonus.toFixed(1)} pkg</span> : null}
        </div>
      </header>

      {poolLabel ? <p className="muted trade-side__pool">{poolLabel}</p> : null}

      <label className="trade-control">
        <span className="trade-control__label">Add player</span>
        <input
          type="search"
          enterKeyHint="search"
          autoComplete="off"
          placeholder={players.length >= MAX_PER_SIDE ? 'Side full (5 max)' : 'Search name…'}
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          disabled={disabled || players.length >= MAX_PER_SIDE}
        />
      </label>

      {search.trim() && suggestions.length > 0 && (
        <ul className="trade-suggest" role="listbox">
          {suggestions.map((p) => (
            <li key={playerKey(p)}>
              <button type="button" className="trade-suggest__btn" onClick={() => onAdd(p)}>
                <span className="trade-suggest__name">{p.name}</span>
                <span className="trade-suggest__meta">
                  {p.pos || '—'}
                  {p.team ? ` · ${p.team}` : ''}
                  {p.ecr != null ? ` · ECR ${p.ecr}` : ''}
                </span>
                <span className="trade-suggest__val">{ecrToTradeValue(p.ecr).toFixed(1)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {search.trim() && suggestions.length === 0 && (
        <p className="muted trade-suggest-empty">No matches.</p>
      )}

      <ul className="trade-players">
        {players.length === 0 && <li className="muted trade-players__empty">No players yet.</li>}
        {players.map((p) => (
          <li key={playerKey(p)} className="trade-player">
            <div className="trade-player__main">
              <span className="trade-player__name">{p.name}</span>
              <span className="trade-player__meta">
                {p.pos || '—'}
                {p.team ? ` · ${p.team}` : ''}
                {p.ecr != null ? ` · ECR ${Number(p.ecr).toFixed(1)}` : ' · unranked'}
              </span>
            </div>
            <span className="trade-player__val">{ecrToTradeValue(p.ecr).toFixed(1)}</span>
            <button
              type="button"
              className="trade-player__remove"
              aria-label={`Remove ${p.name}`}
              onClick={() => onRemove(playerKey(p))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function upgradeClass(n) {
  if (n == null || !Number.isFinite(n)) return '';
  if (n > 0.4) return 'is-up';
  if (n < -0.4) return 'is-down';
  return 'is-flat';
}

export default function TradeAnalyzer() {
  const { user } = useAuth();
  const [rankings, setRankings] = useState({ status: 'idle' });
  const [rosterCtx, setRosterCtx] = useState({ status: 'idle' });
  const [sideA, setSideA] = useState([]);
  const [sideB, setSideB] = useState([]);
  const [managerA, setManagerA] = useState(NONE);
  const [managerB, setManagerB] = useState(NONE);
  const [searchA, setSearchA] = useState('');
  const [searchB, setSearchB] = useState('');
  const [packageAdjust, setPackageAdjust] = useState(true);
  const [finderFocal, setFinderFocal] = useState(NONE);
  const [finderRan, setFinderRan] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRankings({ status: 'loading' });
    fetch('/api/rankings?page_type=redraft-overall', { credentials: 'include' })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        return data;
      })
      .then((data) => {
        if (!cancelled) setRankings({ status: 'ready', data });
      })
      .catch((err) => {
        if (!cancelled) {
          setRankings({ status: 'error', message: err.message || 'Failed to load rankings' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isConfigured()) {
      setRosterCtx({ status: 'ready', season: null, users: [], byOwner: new Map() });
      return;
    }
    let cancelled = false;
    setRosterCtx({ status: 'loading' });
    loadRosterContext(config.leagueId)
      .then((ctx) => {
        if (!cancelled) setRosterCtx({ status: 'ready', ...ctx });
      })
      .catch((err) => {
        if (!cancelled) {
          setRosterCtx({
            status: 'ready',
            season: null,
            users: [],
            byOwner: new Map(),
            message: err.message,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const players = rankings.status === 'ready' ? rankings.data.players || [] : [];
  const managers = useMemo(
    () => (rosterCtx.status === 'ready' ? managerOptions(rosterCtx.users) : []),
    [rosterCtx],
  );

  // Default finder / Side A to the logged-in manager once rosters load.
  useEffect(() => {
    if (rosterCtx.status !== 'ready' || !managers.length) return;
    const mine = user?.sleeperUserId && managers.some((m) => m.id === user.sleeperUserId)
      ? user.sleeperUserId
      : null;
    if (mine) {
      setFinderFocal((prev) => prev || mine);
      setManagerA((prev) => prev || mine);
    }
  }, [rosterCtx.status, managers, user?.sleeperUserId]);

  const ecrBySleeper = useMemo(() => {
    const m = new Map();
    for (const p of players) {
      if (p.sleeper_id) m.set(String(p.sleeper_id), p);
    }
    return m;
  }, [players]);

  /** owner id → ranked player objects for that roster */
  const rostersByOwner = useMemo(() => {
    const out = new Map();
    if (rosterCtx.status !== 'ready') return out;
    for (const [ownerId, ids] of rosterCtx.byOwner.entries()) {
      const list = [];
      for (const id of ids) {
        const row = ecrBySleeper.get(String(id));
        if (row) list.push(toTradePlayer(row));
      }
      list.sort((a, b) => Number(a.ecr) - Number(b.ecr));
      out.set(ownerId, list);
    }
    return out;
  }, [rosterCtx, ecrBySleeper]);

  const labelById = useMemo(() => {
    const m = new Map();
    for (const x of managers) m.set(x.id, x.label);
    return m;
  }, [managers]);

  const selectedKeys = useMemo(() => {
    const s = new Set();
    for (const p of sideA) s.add(playerKey(p));
    for (const p of sideB) s.add(playerKey(p));
    return s;
  }, [sideA, sideB]);

  const suggestA = useMemo(() => {
    const q = searchA.trim().toLowerCase();
    if (!q || sideA.length >= MAX_PER_SIDE) return [];
    const poolOwnerId = managerB || NONE;
    let pool = players;
    if (poolOwnerId && rosterCtx.status === 'ready') {
      const ids = rosterCtx.byOwner.get(poolOwnerId);
      pool = ids?.size
        ? players.filter((p) => p.sleeper_id && ids.has(String(p.sleeper_id)))
        : [];
    }
    const out = [];
    for (const p of pool) {
      if (!p?.name) continue;
      if (selectedKeys.has(playerKey(p))) continue;
      const hay = `${p.name} ${p.team || ''} ${p.pos || ''}`.toLowerCase();
      if (!hay.includes(q)) continue;
      out.push(p);
      if (out.length >= 8) break;
    }
    return out;
  }, [searchA, managerB, sideA.length, players, selectedKeys, rosterCtx]);

  const suggestB = useMemo(() => {
    const q = searchB.trim().toLowerCase();
    if (!q || sideB.length >= MAX_PER_SIDE) return [];
    const poolOwnerId = managerA || NONE;
    let pool = players;
    if (poolOwnerId && rosterCtx.status === 'ready') {
      const ids = rosterCtx.byOwner.get(poolOwnerId);
      pool = ids?.size
        ? players.filter((p) => p.sleeper_id && ids.has(String(p.sleeper_id)))
        : [];
    }
    const out = [];
    for (const p of pool) {
      if (!p?.name) continue;
      if (selectedKeys.has(playerKey(p))) continue;
      const hay = `${p.name} ${p.team || ''} ${p.pos || ''}`.toLowerCase();
      if (!hay.includes(q)) continue;
      out.push(p);
      if (out.length >= 8) break;
    }
    return out;
  }, [searchB, managerA, sideB.length, players, selectedKeys, rosterCtx]);

  const analysis = useMemo(
    () => analyzeTrade(sideA, sideB, { packageAdjust }),
    [sideA, sideB, packageAdjust],
  );

  const rosterImpact = useMemo(() => {
    if (!managerA || !managerB || managerA === managerB) return null;
    const rosterA = rostersByOwner.get(managerA);
    const rosterB = rostersByOwner.get(managerB);
    if (!rosterA?.length || !rosterB?.length) return null;
    if (sideA.length === 0 && sideB.length === 0) return null;
    return scoreTradeRosterImpact(rosterA, rosterB, sideA, sideB);
  }, [managerA, managerB, rostersByOwner, sideA, sideB]);

  const needsPreview = useMemo(() => {
    if (!managerA || !rostersByOwner.get(managerA)) return null;
    return needHoleLabels(rosterStarterNeeds(rostersByOwner.get(managerA)));
  }, [managerA, rostersByOwner]);

  const suggestions = useMemo(() => {
    if (!finderRan || !finderFocal) return [];
    return findTradeSuggestions({
      focalOwnerId: finderFocal,
      rostersByOwner,
      managers,
      opts: { packageAdjust },
    });
  }, [finderRan, finderFocal, rostersByOwner, managers, packageAdjust]);

  function addToSide(setter, setSearch, player) {
    setter((prev) => {
      if (prev.length >= MAX_PER_SIDE) return prev;
      const key = playerKey(player);
      if (prev.some((p) => playerKey(p) === key)) return prev;
      return [...prev, toTradePlayer(player)];
    });
    setSearch('');
  }

  function removeFromSide(setter, key) {
    setter((prev) => prev.filter((p) => playerKey(p) !== key));
  }

  function clearAll() {
    setSideA([]);
    setSideB([]);
    setSearchA('');
    setSearchB('');
  }

  function loadSuggestion(s) {
    setManagerA(finderFocal);
    setManagerB(s.partnerId);
    setSideA(s.sideAGets.map(toTradePlayer));
    setSideB(s.sideBGets.map(toTradePlayer));
    setSearchA('');
    setSearchB('');
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  function onManagerAChange(id) {
    setManagerA(id);
    if (id && id === managerB) setManagerB(NONE);
  }

  function onManagerBChange(id) {
    setManagerB(id);
    if (id && id === managerA) setManagerA(NONE);
  }

  const loading = rankings.status === 'loading' || rankings.status === 'idle';
  const error = rankings.status === 'error';
  const fair = analysis.fairness;
  const labelA = managerA ? labelById.get(managerA) || 'Side A' : 'Side A';
  const labelB = managerB ? labelById.get(managerB) || 'Side B' : 'Side B';

  return (
    <div className="page trade-page">
      <header className="page-header">
        <p className="eyebrow">Half-PPR · redraft</p>
        <h1>Trade analyzer</h1>
        <p className="muted">
          ECR value plus starter-upgrade scoring for your league. Finder suggests deals that help
          both sides.
        </p>
        {rankings.status === 'ready' && rankings.data.scrape_date && (
          <p className="trade-source">
            ECR as of <strong>{formatScrapeDate(rankings.data.scrape_date)}</strong>
            {rosterCtx.status === 'ready' && rosterCtx.season
              ? ` · Rosters from ${rosterCtx.season}`
              : null}
          </p>
        )}
      </header>

      {loading && (
        <div className="card-grid">
          <div className="skeleton" style={{ height: 160 }} />
          <div className="skeleton" style={{ height: 160 }} />
        </div>
      )}

      {error && (
        <div className="card" role="alert">
          <p>Could not load rankings: {rankings.message}</p>
        </div>
      )}

      {rankings.status === 'ready' && (
        <>
          {managers.length > 0 && (
            <div className="trade-teams card">
              <label className="trade-control">
                <span className="trade-control__label">Team A (you)</span>
                <select value={managerA} onChange={(e) => onManagerAChange(e.target.value)}>
                  <option value={NONE}>Select manager…</option>
                  {managers.map((m) => (
                    <option key={m.id} value={m.id} disabled={m.id === managerB}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="trade-control">
                <span className="trade-control__label">Team B (partner)</span>
                <select value={managerB} onChange={(e) => onManagerBChange(e.target.value)}>
                  <option value={NONE}>Select manager…</option>
                  {managers.map((m) => (
                    <option key={m.id} value={m.id} disabled={m.id === managerA}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
              {needsPreview?.length ? (
                <p className="muted trade-teams__needs">
                  {labelA} starter holes: <strong>{needsPreview.join(', ')}</strong>
                </p>
              ) : managerA ? (
                <p className="muted trade-teams__needs">{labelA} starters look filled on ECR depth.</p>
              ) : null}
            </div>
          )}

          <div className={`trade-verdict trade-verdict--${fair.band}`} role="status">
            <div className="trade-verdict__label">{fair.label}</div>
            <p className="trade-verdict__summary">{fair.summary}</p>
            {(sideA.length > 0 || sideB.length > 0) && (
              <div className="trade-verdict__scores">
                <div className={fair.winner === 'a' ? 'is-winner' : undefined}>
                  <span>{labelA} gets</span>
                  <strong>{analysis.totalA.toFixed(1)}</strong>
                </div>
                <div className="trade-verdict__vs">vs</div>
                <div className={fair.winner === 'b' ? 'is-winner' : undefined}>
                  <span>{labelB} gets</span>
                  <strong>{analysis.totalB.toFixed(1)}</strong>
                </div>
              </div>
            )}

            {rosterImpact && (
              <div className="trade-upgrade">
                <div className="trade-upgrade__title">Starter upgrade (optimal ECR lineup)</div>
                <div className="trade-upgrade__grid">
                  <div className={upgradeClass(rosterImpact.a.upgrade)}>
                    <span>{labelA}</span>
                    <strong>{fmtUpgrade(rosterImpact.a.upgrade)}</strong>
                    <em>
                      {rosterImpact.a.beforeTotal.toFixed(1)} → {rosterImpact.a.afterTotal.toFixed(1)}
                    </em>
                  </div>
                  <div className={upgradeClass(rosterImpact.b.upgrade)}>
                    <span>{labelB}</span>
                    <strong>{fmtUpgrade(rosterImpact.b.upgrade)}</strong>
                    <em>
                      {rosterImpact.b.beforeTotal.toFixed(1)} → {rosterImpact.b.afterTotal.toFixed(1)}
                    </em>
                  </div>
                </div>
                <p className="muted trade-upgrade__mutual">
                  Mutual starter change:{' '}
                  <strong className={upgradeClass(rosterImpact.mutualUpgrade)}>
                    {fmtUpgrade(rosterImpact.mutualUpgrade)}
                  </strong>
                </p>
              </div>
            )}

            {managerA && managerB && (sideA.length > 0 || sideB.length > 0) && !rosterImpact && (
              <p className="muted trade-upgrade-hint">
                Starter upgrades need both teams to have ranked roster players for this season.
              </p>
            )}
            {(!managerA || !managerB) && (sideA.length > 0 || sideB.length > 0) && (
              <p className="muted trade-upgrade-hint">
                Pick Team A and Team B to score starter upgrades for this league.
              </p>
            )}
          </div>

          <div className="trade-toolbar card">
            <label className="trade-toggle">
              <input
                type="checkbox"
                checked={packageAdjust}
                onChange={(e) => setPackageAdjust(e.target.checked)}
              />
              <span>
                Package adjust
                <span className="dim"> — boost the side giving fewer players</span>
              </span>
            </label>
            <button type="button" className="btn btn-ghost" onClick={clearAll}>
              Clear players
            </button>
          </div>

          <div className="trade-sides">
            <SidePanel
              title={`${labelA} gets`}
              sideKey="a"
              players={sideA}
              total={analysis.totalA}
              bonus={analysis.bonusA}
              poolLabel={
                managerB
                  ? `Searching ${labelById.get(managerB) || 'partner'}'s roster`
                  : 'Searching all ranked players — pick Team B to limit to their roster'
              }
              search={searchA}
              onSearchChange={setSearchA}
              suggestions={suggestA}
              onAdd={(p) => addToSide(setSideA, setSearchA, p)}
              onRemove={(key) => removeFromSide(setSideA, key)}
              disabled={loading}
            />
            <SidePanel
              title={`${labelB} gets`}
              sideKey="b"
              players={sideB}
              total={analysis.totalB}
              bonus={analysis.bonusB}
              poolLabel={
                managerA
                  ? `Searching ${labelById.get(managerA) || 'you'}'s roster`
                  : 'Searching all ranked players — pick Team A to limit to their roster'
              }
              search={searchB}
              onSearchChange={setSearchB}
              suggestions={suggestB}
              onAdd={(p) => addToSide(setSideB, setSearchB, p)}
              onRemove={(key) => removeFromSide(setSideB, key)}
              disabled={loading}
            />
          </div>

          {managers.length > 0 && (
            <section className="trade-finder card" aria-labelledby="trade-finder-title">
              <header className="trade-finder__head">
                <div>
                  <h2 id="trade-finder-title" className="trade-finder__title">
                    Trade finder
                  </h2>
                  <p className="muted trade-finder__sub">
                    Scans 1-for-1 and simple 2-for-1 packages for fair ECR deals that improve
                    starters.
                  </p>
                </div>
              </header>

              <div className="trade-finder__controls">
                <label className="trade-control">
                  <span className="trade-control__label">Find deals for</span>
                  <select
                    value={finderFocal}
                    onChange={(e) => {
                      setFinderFocal(e.target.value);
                      setFinderRan(false);
                    }}
                  >
                    <option value={NONE}>Select manager…</option>
                    {managers.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!finderFocal || rostersByOwner.size < 2}
                  onClick={() => setFinderRan(true)}
                >
                  Find trades
                </button>
              </div>

              {finderRan && suggestions.length === 0 && (
                <p className="muted">No mutual upgrades that stay within a slight ECR edge.</p>
              )}

              {suggestions.length > 0 && (
                <ul className="trade-finder__list">
                  {suggestions.map((s) => {
                    const id = [
                      s.partnerId,
                      ...s.sideBGets.map((p) => p.sleeper_id),
                      ...s.sideAGets.map((p) => p.sleeper_id),
                    ].join('-');
                    return (
                    <li key={id} className="trade-finder__item">
                      <div className="trade-finder__item-main">
                        <div className="trade-finder__partner">vs {s.partnerLabel}</div>
                        <p className="trade-finder__pitch">{s.pitch}</p>
                        <div className="trade-finder__meta">
                          <span className={`trade-finder__band trade-finder__band--${s.chart.fairness.band}`}>
                            {s.chart.fairness.label}
                          </span>
                          <span className={upgradeClass(s.impact.a.upgrade)}>
                            You {fmtUpgrade(s.impact.a.upgrade)}
                          </span>
                          <span className={upgradeClass(s.impact.b.upgrade)}>
                            Them {fmtUpgrade(s.impact.b.upgrade)}
                          </span>
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => loadSuggestion(s)}
                      >
                        Load
                      </button>
                    </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}

          <p className="muted trade-footnote">
            Chart values decay from ECR rank 1 (100 pts). Starter upgrades rebuild each roster into
            1 QB / 2 RB / 2 WR / 1 TE / 1 FLEX / 1 DST using ECR trade value. Unranked roster players
            are ignored.
          </p>
        </>
      )}
    </div>
  );
}
