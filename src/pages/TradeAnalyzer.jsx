import React, { useEffect, useMemo, useState } from 'react';
import { isConfigured } from '../config.js';
import { useAuth } from '../AuthContext.jsx';
import { useLeague } from '../LeagueContext.jsx';
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
import {
  matchTradeHype,
  formatTrendLabel,
  formatHoursAgo,
} from '../lib/tradeHype.js';
import './TradeAnalyzer.css';

const MAX_PER_SIDE = 5;
const NONE = '';
/** Flip when re-enabling ESPN news + Sleeper trending on the analyzer. */
const SHOW_TRADE_HYPE = false;

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
  poolLabel,
  options,
  onAdd,
  onRemove,
  disabled,
}) {
  const full = players.length >= MAX_PER_SIDE;
  const canPick = !disabled && !full && options.length > 0;

  return (
    <section className="trade-side card" aria-labelledby={`trade-side-${sideKey}`}>
      <header className="trade-side__head">
        <h2 id={`trade-side-${sideKey}`} className="trade-side__title">
          {title}
        </h2>
        <div className="trade-side__total" aria-live="polite">
          <span className="trade-side__total-label">Value</span>
          <strong>{total.toFixed(1)}</strong>
        </div>
      </header>

      {poolLabel ? <p className="muted trade-side__pool">{poolLabel}</p> : null}

      <label className="trade-control">
        <span className="trade-control__label">Add player</span>
        <select
          value=""
          disabled={!canPick}
          onChange={(e) => {
            const key = e.target.value;
            if (!key) return;
            const hit = options.find((p) => playerKey(p) === key);
            if (hit) onAdd(hit);
          }}
        >
          <option value="">
            {full
              ? 'Side full (5 max)'
              : !options.length
                ? 'No players available'
                : 'Select a player…'}
          </option>
          {options.map((p) => {
            const key = playerKey(p);
            const val = ecrToTradeValue(p.ecr).toFixed(1);
            const meta = [p.pos, p.team, p.ecr != null ? `ECR ${p.ecr}` : null, val]
              .filter(Boolean)
              .join(' · ');
            return (
              <option key={key} value={key}>
                {p.name} — {meta}
              </option>
            );
          })}
        </select>
      </label>

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
  const { leagueId } = useLeague();
  const [rankings, setRankings] = useState({ status: 'idle' });
  const [rosterCtx, setRosterCtx] = useState({ status: 'idle' });
  const [sideA, setSideA] = useState([]);
  const [sideB, setSideB] = useState([]);
  const [managerA, setManagerA] = useState(NONE);
  const [managerB, setManagerB] = useState(NONE);
  const [finderFocal, setFinderFocal] = useState(NONE);
  const [finderRan, setFinderRan] = useState(false);
  const [hype, setHype] = useState({ status: 'idle' });

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
    if (!SHOW_TRADE_HYPE) return undefined;
    let cancelled = false;
    setHype({ status: 'loading' });
    fetch('/api/trade-hype', { credentials: 'include' })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        return data;
      })
      .then((data) => {
        if (!cancelled) setHype({ status: 'ready', data });
      })
      .catch((err) => {
        if (!cancelled) {
          setHype({ status: 'error', message: err.message || 'Failed to load hype' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isConfigured(leagueId)) {
      setRosterCtx({ status: 'ready', season: null, users: [], byOwner: new Map() });
      return;
    }
    let cancelled = false;
    setRosterCtx({ status: 'loading' });
    loadRosterContext(leagueId)
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
  }, [leagueId]);

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

  /** Side A receives from Team B's roster; Side B receives from Team A's. */
  const optionsA = useMemo(() => {
    if (!managerB) return [];
    const roster = rostersByOwner.get(managerB) || [];
    return roster.filter((p) => !selectedKeys.has(playerKey(p)));
  }, [managerB, rostersByOwner, selectedKeys]);

  const optionsB = useMemo(() => {
    if (!managerA) return [];
    const roster = rostersByOwner.get(managerA) || [];
    return roster.filter((p) => !selectedKeys.has(playerKey(p)));
  }, [managerA, rostersByOwner, selectedKeys]);

  const analysis = useMemo(
    () => analyzeTrade(sideA, sideB, { packageAdjust: true }),
    [sideA, sideB],
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
      opts: { packageAdjust: true },
    });
  }, [finderRan, finderFocal, rostersByOwner, managers]);

  const tradePlayersTagged = useMemo(() => {
    const out = [];
    for (const p of sideA) out.push({ ...p, _side: 'a' });
    for (const p of sideB) out.push({ ...p, _side: 'b' });
    return out;
  }, [sideA, sideB]);

  const hypeMatch = useMemo(() => {
    if (hype.status !== 'ready' || tradePlayersTagged.length === 0) {
      return { items: [], newsCount: 0, trendCount: 0 };
    }
    return matchTradeHype(tradePlayersTagged, hype.data);
  }, [hype, tradePlayersTagged]);

  function addToSide(setter, player) {
    setter((prev) => {
      if (prev.length >= MAX_PER_SIDE) return prev;
      const key = playerKey(player);
      if (prev.some((p) => playerKey(p) === key)) return prev;
      return [...prev, toTradePlayer(player)];
    });
  }

  function removeFromSide(setter, key) {
    setter((prev) => prev.filter((p) => playerKey(p) !== key));
  }

  function clearAll() {
    setSideA([]);
    setSideB([]);
  }

  function loadSuggestion(s) {
    setManagerA(finderFocal);
    setManagerB(s.partnerId);
    setSideA(s.sideAGets.map(toTradePlayer));
    setSideB(s.sideBGets.map(toTradePlayer));
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
        {rankings.status === 'ready' && rankings.data.scrape_date && (
          <p className="trade-source">
            ECR as of <strong>{formatScrapeDate(rankings.data.scrape_date)}</strong>
            {rosterCtx.status === 'ready' && rosterCtx.season
              ? ` · Rosters from ${rosterCtx.season}`
              : null}
          </p>
        )}
      </header>

      <details className="trade-help">
        <summary className="trade-help__summary">
          <span className="trade-help__icon" aria-hidden="true">
            ?
          </span>
          <span className="trade-help__label">How it calculates</span>
          <span className="trade-help__hint">Simple explainer</span>
          <svg
            className="trade-help__chevron"
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
        <div className="trade-help__body">
          <ol className="trade-help__steps">
            <li>
              <strong>Player value</strong> — each player gets points from their Half-PPR expert rank
              (ECR). Better ranks = more points. Top guys are worth much more than depth pieces.
            </li>
            <li>
              <strong>Fair deal?</strong> — we add up both sides. If the totals are close, it&apos;s
              Fair; a bit off is a Slight edge; way off is Lopsided. Uneven player counts get a small
              boost on the thinner side.
            </li>
            <li>
              <strong>Starter upgrade</strong> — we rebuild each team&apos;s best lineup (QB, RBs,
              WRs, TE, FLEX, DST) before and after the trade. Green means your starters got better.
            </li>
            <li>
              <strong>Trade finder</strong> — scans simple swaps across the league and keeps deals
              that look fair on value <em>and</em> help at least one starting lineup.
            </li>
          </ol>
          <p className="muted trade-help__note">
            This is a guide, trade at your own risk...
          </p>
        </div>
      </details>

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

          {managers.length > 0 && (
            <p className="muted trade-bridge">
              {managerA && managerB
                ? 'Add players from each roster below.'
                : 'Pick both teams, then add players from each roster.'}
              {(sideA.length > 0 || sideB.length > 0) && (
                <>
                  {' '}
                  <button type="button" className="trade-bridge__clear" onClick={clearAll}>
                    Clear deal
                  </button>
                </>
              )}
            </p>
          )}

          <div className="trade-sides">
            <SidePanel
              title={`${labelA} gets`}
              sideKey="a"
              players={sideA}
              total={analysis.totalA}
              poolLabel={
                managerB
                  ? `From ${labelById.get(managerB) || 'partner'}'s roster`
                  : 'Pick Team B to choose from their roster'
              }
              options={optionsA}
              onAdd={(p) => addToSide(setSideA, p)}
              onRemove={(key) => removeFromSide(setSideA, key)}
              disabled={loading || !managerB}
            />
            <SidePanel
              title={`${labelB} gets`}
              sideKey="b"
              players={sideB}
              total={analysis.totalB}
              poolLabel={
                managerA
                  ? `From ${labelById.get(managerA) || 'you'}'s roster`
                  : 'Pick Team A to choose from their roster'
              }
              options={optionsB}
              onAdd={(p) => addToSide(setSideB, p)}
              onRemove={(key) => removeFromSide(setSideB, key)}
              disabled={loading || !managerA}
            />
          </div>

          {(sideA.length > 0 || sideB.length > 0) && (
            <div className={`trade-verdict trade-verdict--${fair.band}`} role="status">
              <div className="trade-verdict__label">{fair.label}</div>
              <p className="trade-verdict__summary">{fair.summary}</p>
              <div className="trade-verdict__scores">
                <div className={fair.winner === 'a' ? 'is-winner' : undefined}>
                  <span>{labelA} gets</span>
                  <strong>{analysis.totalA.toFixed(1)}</strong>
                  {sideA.length > 0 && (
                    <p className="trade-verdict__players">
                      {sideA.map((p) => p.name).join(', ')}
                    </p>
                  )}
                </div>
                <div className="trade-verdict__vs">vs</div>
                <div className={fair.winner === 'b' ? 'is-winner' : undefined}>
                  <span>{labelB} gets</span>
                  <strong>{analysis.totalB.toFixed(1)}</strong>
                  {sideB.length > 0 && (
                    <p className="trade-verdict__players">
                      {sideB.map((p) => p.name).join(', ')}
                    </p>
                  )}
                </div>
              </div>

              {rosterImpact && (
                <div className="trade-upgrade">
                  <div className="trade-upgrade__title">Starter upgrade?</div>
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
                </div>
              )}

              {managerA && managerB && !rosterImpact && (
                <p className="muted trade-upgrade-hint">
                  Starter upgrades need both teams to have ranked roster players for this season.
                </p>
              )}
              {(!managerA || !managerB) && (
                <p className="muted trade-upgrade-hint">
                  Pick Team A and Team B to score starter upgrades for this league.
                </p>
              )}

              <div className="trade-verdict__actions">
                <button type="button" className="btn btn-ghost" onClick={clearAll}>
                  Clear players
                </button>
              </div>
            </div>
          )}

          {SHOW_TRADE_HYPE && (sideA.length > 0 || sideB.length > 0) && (
            <section className="trade-hype card" aria-labelledby="trade-hype-title">
              <header className="trade-hype__head">
                <h2 id="trade-hype-title" className="trade-hype__title">
                  Any Hype?
                </h2>
                <p className="muted trade-hype__sub">
                  ESPN headlines + Sleeper waiver buzz (adds/drops, last 24h) for players in this
                  deal.
                </p>
              </header>

              {hype.status === 'loading' || hype.status === 'idle' ? (
                <p className="muted">Loading news &amp; trends…</p>
              ) : null}
              {hype.status === 'error' && (
                <p className="muted" role="alert">
                  Could not load hype: {hype.message}
                </p>
              )}
              {hype.status === 'ready' && hypeMatch.items.length === 0 && (
                <p className="muted">
                  No matching ESPN headlines or Sleeper trending hits for these players right now.
                </p>
              )}
              {hype.status === 'ready' && hypeMatch.items.length > 0 && (
                <ul className="trade-hype__list">
                  {hypeMatch.items.map((it) => {
                    const addLabel = formatTrendLabel(it.trending_add, 'add');
                    const dropLabel = formatTrendLabel(it.trending_drop, 'drop');
                    const sideLabel =
                      it.side === 'a' ? `${labelA} gets` : it.side === 'b' ? `${labelB} gets` : null;
                    return (
                      <li key={`${it.sleeper_id || it.name}-${it.side}`} className="trade-hype__player">
                        <div className="trade-hype__player-head">
                          <div>
                            <strong className="trade-hype__name">{it.name}</strong>
                            <span className="trade-hype__meta">
                              {[it.pos, it.team, sideLabel].filter(Boolean).join(' · ')}
                            </span>
                          </div>
                          <div className="trade-hype__badges">
                            {addLabel && (
                              <span className="trade-hype__badge trade-hype__badge--add" title={addLabel}>
                                Hot add #{it.trending_add.rank}
                              </span>
                            )}
                            {dropLabel && (
                              <span
                                className="trade-hype__badge trade-hype__badge--drop"
                                title={dropLabel}
                              >
                                Hot drop #{it.trending_drop.rank}
                              </span>
                            )}
                          </div>
                        </div>
                        {(addLabel || dropLabel) && (
                          <ul className="trade-hype__trends">
                            {addLabel && <li>{addLabel}</li>}
                            {dropLabel && <li>{dropLabel}</li>}
                          </ul>
                        )}
                        {it.news.length > 0 && (
                          <ul className="trade-hype__news">
                            {it.news.map((n) => (
                              <li key={n.id}>
                                {n.link ? (
                                  <a href={n.link} target="_blank" rel="noopener noreferrer">
                                    {n.headline}
                                  </a>
                                ) : (
                                  <span>{n.headline}</span>
                                )}
                                {formatHoursAgo(n.hours_ago) && (
                                  <span className="trade-hype__when">{formatHoursAgo(n.hours_ago)}</span>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}

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

          {/* <p className="muted trade-footnote">
            Chart values decay from ECR rank 1 (100 pts). Starter upgrades rebuild each roster into
            1 QB / 2 RB / 2 WR / 1 TE / 2 FLEX / 1 DST using ECR trade value. Unranked roster players
            are ignored.
          </p> */}
        </>
      )}
    </div>
  );
}
