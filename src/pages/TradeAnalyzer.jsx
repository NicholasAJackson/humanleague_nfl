import React, { useEffect, useMemo, useState } from 'react';
import { isConfigured } from '../config.js';
import { useAuth } from '../AuthContext.jsx';
import { useLeague } from '../LeagueContext.jsx';
import {
  resolveLeagueHistoryChain,
  fetchSeasonBundle,
  fetchLeagueTrades,
  getNflPlayersLookup,
  rosterPlayerIds,
} from '../lib/sleeper.js';
import {
  analyzeTrade,
  playerTradeValue,
  ecrToTradeValue,
  TRADE_VALUE_DEFAULTS,
  fmtTradeValue,
  fmtTradeDelta,
} from '../lib/tradeValue.js';
import FantasyCalcAttribution from '../components/FantasyCalcAttribution.jsx';
import {
  needHoleLabels,
  rosterStarterNeeds,
  scoreTradeRosterImpact,
} from '../lib/rosterNeeds.js';
import { findTradeSuggestions } from '../lib/tradeFinder.js';
import { gradeLeagueTrades } from '../lib/leagueTrades.js';
import { leagueMarketMovers, fmtTrend30d } from '../lib/tradeMarket.js';
import { peekPendingTrade, consumePendingTrade } from '../lib/pendingTrade.js';
import {
  matchTradeHype,
  formatTrendLabel,
  formatHoursAgo,
} from '../lib/tradeHype.js';
import './TradeAnalyzer.css';

const MAX_PER_SIDE = 5;
const NONE = '';
/** Flip when re-enabling ESPN news + Sleeper trending on the analyzer.
 *  Also restore `api/_trade-hype.js` → `api/trade-hype.js`.
 */
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
  const adp = Number(p.adp);
  const hasAdp = Number.isFinite(adp) && adp >= 1;
  const explicit = p.value != null ? Number(p.value) : null;
  const hasValue = explicit != null && Number.isFinite(explicit);
  const rank = Number(p.ecr);
  const hasRank = Number.isFinite(rank) && rank >= 1;
  return {
    name: p.name,
    pos: p.pos,
    team: p.team,
    ecr: hasRank ? rank : null,
    value: hasValue ? Math.round(explicit * 10) / 10 : hasRank ? ecrToTradeValue(rank) : hasAdp ? ecrToTradeValue(adp) : null,
    adp: hasAdp ? adp : null,
    pts_ros: Number.isFinite(Number(p.pts_ros)) ? Number(p.pts_ros) : Number.isFinite(Number(p.pts_half_ppr)) ? Number(p.pts_half_ppr) : null,
    pts_ytd: Number.isFinite(Number(p.pts_ytd)) ? Number(p.pts_ytd) : null,
    pts_recent: Number.isFinite(Number(p.pts_recent)) ? Number(p.pts_recent) : null,
    recent_games: Number.isFinite(Number(p.recent_games)) ? Number(p.recent_games) : null,
    injury_status: String(p.injury_status || '').trim() || null,
    bye: Number.isFinite(Number(p.bye)) ? Number(p.bye) : null,
    trend_30d: Number.isFinite(Number(p.trend_30d)) ? Number(p.trend_30d) : null,
    sleeper_id: p.sleeper_id || null,
    fp_id: p.fp_id || null,
  };
}

function playerSignals(p) {
  const bits = [];
  if (p.pos) bits.push(p.pos);
  if (p.team) bits.push(p.team);
  if (p.ecr != null) bits.push(`#${p.ecr}`);
  if (p.trend_30d != null && p.trend_30d !== 0) {
    const t = Number(p.trend_30d);
    bits.push(`30d ${t > 0 ? '+' : ''}${Math.round(t)}`);
  }
  if (p.injury_status) bits.push(p.injury_status);
  if (p.bye != null) bits.push(`Bye ${p.bye}`);
  return bits.join(' · ');
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
  return fmtTradeDelta(n);
}

/** Prefer the newest linked season that still has rostered players. */
async function loadRosterContext(leagueId) {
  const chain = await resolveLeagueHistoryChain(leagueId);
  for (const meta of chain) {
    const bundle = await fetchSeasonBundle(meta.leagueId);
    const hasPlayers = (bundle.rosters || []).some((r) => rosterPlayerIds(r).length > 0);
    if (!hasPlayers) continue;
    const byOwner = new Map();
    const rosterToOwner = new Map();
    for (const roster of bundle.rosters || []) {
      if (roster?.owner_id == null) continue;
      const oid = String(roster.owner_id);
      byOwner.set(oid, new Set(rosterPlayerIds(roster)));
      if (roster.roster_id != null) {
        rosterToOwner.set(Number(roster.roster_id), oid);
      }
    }
    return {
      season: meta.season || bundle.league?.season || null,
      users: bundle.users || [],
      byOwner,
      rosterToOwner,
    };
  }
  return { season: null, users: [], byOwner: new Map(), rosterToOwner: new Map() };
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
          <strong>{fmtTradeValue(total)}</strong>
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
            const val = fmtTradeValue(playerTradeValue(p));
            const meta = [p.pos, p.team, val].filter(Boolean).join(' · ');
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
          <li
            key={playerKey(p)}
            className={
              'trade-player' + (p.injury_status ? ' trade-player--injured' : '')
            }
          >
            <div className="trade-player__main">
              <span className="trade-player__name">{p.name}</span>
              <span className="trade-player__meta">{playerSignals(p) || 'FantasyCalc'}</span>
            </div>
            <span className="trade-player__val">{fmtTradeValue(playerTradeValue(p))}</span>
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

function historyBandText(row) {
  const fair = row.chart?.fairness;
  if (!fair || fair.band === 'empty') return 'No FantasyCalc values';
  const [a, b] = row.sides;
  const winner = fair.winner === 'a' ? a.label : fair.winner === 'b' ? b.label : null;
  if (fair.band === 'fair' && fair.winner === 'even') return 'Fair today';
  if (fair.band === 'fair') return `Fair · ${winner} by ${fair.gapPct}%`;
  if (fair.band === 'slight') return `${winner} slight edge (${fair.gapPct}%)`;
  return `${winner} won on today's values (${fair.gapPct}%)`;
}

function sideAssetsLine(side, extra) {
  const names = (side.received || []).map((p) => p.name).join(', ');
  const bits = [names || null, extra].filter(Boolean);
  return bits.join(' · ') || '—';
}

function MarketList({ title, kind, rows }) {
  return (
    <div className="trade-market__col">
      <h3 className="trade-market__col-title">{title}</h3>
      {rows.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          None over the value cutoff.
        </p>
      ) : (
        <ul className="trade-market__list">
          {rows.map((r) => (
            <li key={r.sleeper_id} className="trade-market__row">
              <div>
                <strong>{r.name}</strong>
                <span className="muted">
                  {[r.pos, r.team, r.ownerLabel].filter(Boolean).join(' · ')}
                </span>
              </div>
              <div className="trade-market__nums">
                <span className={kind === 'up' ? 'is-up' : 'is-down'}>{fmtTrend30d(r.trend)}</span>
                <span className="muted">{fmtTradeValue(r.value)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
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
  const [finderPos, setFinderPos] = useState(NONE);
  const [finderOfferId, setFinderOfferId] = useState(NONE);
  const [finderRan, setFinderRan] = useState(false);
  const [hype, setHype] = useState({ status: 'idle' });
  const [rawTrades, setRawTrades] = useState({ status: 'idle', trades: [] });
  const [lookup, setLookup] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setRankings({ status: 'loading' });
    fetch('/api/rankings?page_type=sleeper-trade-blend', { credentials: 'include' })
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
      setRosterCtx({
        status: 'ready',
        season: null,
        users: [],
        byOwner: new Map(),
        rosterToOwner: new Map(),
      });
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
            rosterToOwner: new Map(),
            message: err.message,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [leagueId]);

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
    if (!isConfigured(leagueId)) {
      setRawTrades({ status: 'ready', trades: [] });
      return;
    }
    let cancelled = false;
    setRawTrades({ status: 'loading', trades: [] });
    fetchLeagueTrades(leagueId)
      .then((trades) => {
        if (!cancelled) setRawTrades({ status: 'ready', trades });
      })
      .catch((err) => {
        if (!cancelled) {
          setRawTrades({
            status: 'error',
            trades: [],
            message: err.message || 'Could not load trades',
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

  useEffect(() => {
    if (rankings.status !== 'ready' || rosterCtx.status !== 'ready') return;
    const pending = peekPendingTrade();
    if (!pending) return;
    if (pending.managerA) setManagerA(String(pending.managerA));
    if (pending.managerB) setManagerB(String(pending.managerB));
    if (Array.isArray(pending.sideA)) setSideA(pending.sideA.map(toTradePlayer));
    if (Array.isArray(pending.sideB)) setSideB(pending.sideB.map(toTradePlayer));
    if (pending.managerA) setFinderFocal((prev) => prev || String(pending.managerA));
  }, [rankings.status, rosterCtx.status]);

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
      list.sort((a, b) => {
        const dv = playerTradeValue(b) - playerTradeValue(a);
        if (dv !== 0) return dv;
        const ae = Number(a.ecr);
        const be = Number(b.ecr);
        if (Number.isFinite(ae) && Number.isFinite(be) && ae !== be) return ae - be;
        return String(a.name || '').localeCompare(String(b.name || ''));
      });
      out.set(ownerId, list);
    }
    return out;
  }, [rosterCtx, ecrBySleeper]);

  const labelById = useMemo(() => {
    const m = new Map();
    for (const x of managers) m.set(x.id, x.label);
    return m;
  }, [managers]);

  const leagueTradeRows = useMemo(() => {
    if (rawTrades.status !== 'ready' || rankings.status !== 'ready') return [];
    return gradeLeagueTrades(rawTrades.trades, {
      rosterToOwner: rosterCtx.rosterToOwner || new Map(),
      playerById: ecrBySleeper,
      lookup,
      ownerLabel: (ownerId, rid) =>
        (ownerId && labelById.get(String(ownerId))) || `Roster ${rid}`,
    });
  }, [
    rawTrades,
    rankings.status,
    rosterCtx.rosterToOwner,
    ecrBySleeper,
    lookup,
    labelById,
  ]);

  const market = useMemo(() => {
    if (rankings.status !== 'ready' || rostersByOwner.size === 0) {
      return { sellHigh: [], buyLow: [] };
    }
    return leagueMarketMovers({
      players,
      rostersByOwner,
      ownerLabel: (id) => labelById.get(String(id)) || 'Unknown',
    });
  }, [rankings.status, players, rostersByOwner, labelById]);

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
    () =>
      analyzeTrade(sideA, sideB, {
        packageAdjust: true,
        ...TRADE_VALUE_DEFAULTS,
      }),
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

  const finderOfferOptions = useMemo(() => {
    if (!finderFocal) return [];
    return rostersByOwner.get(finderFocal) || [];
  }, [finderFocal, rostersByOwner]);

  const suggestions = useMemo(() => {
    if (!finderRan || !finderFocal) return [];
    return findTradeSuggestions({
      focalOwnerId: finderFocal,
      rostersByOwner,
      managers,
      opts: {
        packageAdjust: true,
        wantPos: finderPos || null,
        offerPlayerIds: finderOfferId ? [finderOfferId] : null,
        ...TRADE_VALUE_DEFAULTS,
      },
    });
  }, [finderRan, finderFocal, finderPos, finderOfferId, rostersByOwner, managers]);

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
    consumePendingTrade();
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

  function loadHistoryTrade(row) {
    if (!row?.loadable) return;
    const [a, b] = row.sides;
    setManagerA(a.ownerId);
    setManagerB(b.ownerId);
    setSideA((a.received || []).map(toTradePlayer));
    setSideB((b.received || []).map(toTradePlayer));
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
        <p className="eyebrow">Half-PPR · FantasyCalc redraft</p>
        <h1>Trade analyzer</h1>
        {rankings.status === 'ready' && (
          <p className="trade-source">
            {rankings.data.num_teams || 10}-team · {rankings.data.num_qbs || 1}QB ·{' '}
            {rankings.data.ppr === 0.5 ? 'Half-PPR' : `${rankings.data.ppr ?? 0.5} PPR`}
            {rankings.data.scrape_date ? (
              <>
                {' '}
                · updated <strong>{formatScrapeDate(rankings.data.scrape_date)}</strong>
              </>
            ) : null}
            {rosterCtx.status === 'ready' && rosterCtx.season
              ? ` · Rosters from ${rosterCtx.season}`
              : null}
          </p>
        )}
        <FantasyCalcAttribution extra="Kickers and DST are not in this list." />
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
              <strong>Player value</strong> — each player uses{' '}
              <a href="https://fantasycalc.com" target="_blank" rel="noopener noreferrer">
                FantasyCalc
              </a>{' '}
              redraft trade value for this league format (10-team, 1QB, Half-PPR). Those numbers come
              from real public-league trades, recency-weighted, not from draft ADP or projections.
            </li>
            <li>
              <strong>Fair deal?</strong> — we add up both sides. If the totals are close, it&apos;s
              Fair; a bit off is a Slight edge; way off is Lopsided. Uneven player counts get a
              FantasyCalc-style bench/waiver boost on the thinner side.
            </li>
            <li>
              <strong>Starter upgrade</strong> — we rebuild each team&apos;s best lineup (QB, RBs,
              WRs, TE, FLEX, DST) before and after the trade using those values. Green means
              your starters got better. DST has no FantasyCalc value, so that slot doesn&apos;t move
              the upgrade math.
            </li>
            <li>
              <strong>Trade finder</strong> — scans simple swaps across the league and keeps deals
              that look fair on FantasyCalc value <em>and</em> help at least one starting lineup. If
              you pick a position you want, it only hits teams that can spare one and never suggests a
              same-position swap.
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
          <p>Could not load trade values: {rankings.message}</p>
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
                <p className="muted trade-teams__needs">{labelA} starters look filled on FantasyCalc depth.</p>
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
                  <strong>{fmtTradeValue(analysis.totalA)}</strong>
                  {sideA.length > 0 && (
                    <p className="trade-verdict__players">
                      {sideA.map((p) => p.name).join(', ')}
                    </p>
                  )}
                </div>
                <div className="trade-verdict__vs">vs</div>
                <div className={fair.winner === 'b' ? 'is-winner' : undefined}>
                  <span>{labelB} gets</span>
                  <strong>{fmtTradeValue(analysis.totalB)}</strong>
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
                        {fmtTradeValue(rosterImpact.a.beforeTotal)} → {fmtTradeValue(rosterImpact.a.afterTotal)}
                      </em>
                    </div>
                    <div className={upgradeClass(rosterImpact.b.upgrade)}>
                      <span>{labelB}</span>
                      <strong>{fmtUpgrade(rosterImpact.b.upgrade)}</strong>
                      <em>
                        {fmtTradeValue(rosterImpact.b.beforeTotal)} → {fmtTradeValue(rosterImpact.b.afterTotal)}
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

          {(market.sellHigh.length > 0 || market.buyLow.length > 0) && (
            <section className="trade-market card" aria-labelledby="trade-market-title">
              <header className="trade-finder__head">
                <div>
                  <h2 id="trade-market-title" className="trade-finder__title">
                    Sell high / buy low
                  </h2>
                  <p className="muted trade-finder__sub">
                    Biggest FantasyCalc 30-day value moves among rostered players. Risers are sell-high
                    candidates; fallers are buy-lows.
                  </p>
                </div>
              </header>
              <div className="trade-market__grid">
                <MarketList title="Sell high" kind="up" rows={market.sellHigh} />
                <MarketList title="Buy low" kind="down" rows={market.buyLow} />
              </div>
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
                    Pick a player you&apos;re willing to move and the position you need (e.g. RB after
                    an injury). Scans 1-for-1 through 2-for-2 and 3-for-1 packages for fair FantasyCalc
                    deals that improve starters. Extra pieces are added around your offer when needed
                    to balance value.
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
                      setFinderOfferId(NONE);
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
                <label className="trade-control">
                  <span className="trade-control__label">I&apos;m offering</span>
                  <select
                    value={finderOfferId}
                    onChange={(e) => {
                      setFinderOfferId(e.target.value);
                      setFinderRan(false);
                    }}
                    disabled={!finderFocal}
                  >
                    <option value={NONE}>Any / auto-pick sends</option>
                    {finderOfferOptions.map((p) => (
                      <option key={playerKey(p)} value={String(p.sleeper_id)}>
                        {p.name} ({p.pos || '?'}) · {fmtTradeValue(playerTradeValue(p))}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="trade-control">
                  <span className="trade-control__label">Looking for</span>
                  <select
                    value={finderPos}
                    onChange={(e) => {
                      setFinderPos(e.target.value);
                      setFinderRan(false);
                    }}
                  >
                    <option value={NONE}>Any position</option>
                    {['QB', 'RB', 'WR', 'TE', 'DST'].map((pos) => (
                      <option key={pos} value={pos}>
                        {pos}
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
                <p className="muted">
                  {finderOfferId && finderPos
                    ? `No fair ${finderPos} deals using that offer. Try a different player, loosen to “Any position”, or build the trade manually above.`
                    : finderPos
                      ? `No fair ${finderPos} deals found. Try selecting a specific player you’re offering, or build the trade manually above.`
                      : 'No mutual upgrades that stay within a slight value edge. Try picking a player you’re offering and a position you need.'}
                </p>
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
                          <span className="trade-finder__shape">
                            {s.sideBGets.length}-for-{s.sideAGets.length}
                          </span>
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

          <section className="trade-history card" aria-labelledby="trade-history-title">
            <header className="trade-finder__head">
              <div>
                <h2 id="trade-history-title" className="trade-finder__title">
                  League trades
                </h2>
                <p className="muted trade-finder__sub">
                  Completed Sleeper trades this season, graded with <em>today&apos;s</em> FantasyCalc
                  values — not what they were worth on the day.
                </p>
              </div>
            </header>
            {rawTrades.status === 'loading' || rawTrades.status === 'idle' ? (
              <p className="muted">Loading league trades…</p>
            ) : null}
            {rawTrades.status === 'error' ? (
              <p className="muted" role="alert">
                {rawTrades.message}
              </p>
            ) : null}
            {rawTrades.status === 'ready' && leagueTradeRows.length === 0 ? (
              <p className="muted">No completed trades in Sleeper for this season yet.</p>
            ) : null}
            {leagueTradeRows.length > 0 ? (
              <ul className="trade-history__list">
                {leagueTradeRows.map((row) => {
                  const band = row.chart?.fairness?.band || 'empty';
                  return (
                    <li key={row.id} className="trade-history__item">
                      <div className="trade-history__main">
                        <div className="trade-history__when">{row.when}</div>
                        {row.sides.map((side, i) => (
                          <p key={side.rosterId} className="trade-history__deal">
                            <strong>{side.label}</strong> gets {sideAssetsLine(side, row.extras[i])}
                          </p>
                        ))}
                        <div className="trade-finder__meta">
                          <span className={`trade-finder__band trade-finder__band--${band}`}>
                            {historyBandText(row)}
                          </span>
                          {row.chart ? (
                            <span className="muted">
                              {fmtTradeValue(row.chart.totalA)} vs {fmtTradeValue(row.chart.totalB)}
                            </span>
                          ) : null}
                          {row.missing > 0 ? (
                            <span className="muted">
                              {row.missing} player{row.missing === 1 ? '' : 's'} not on FantasyCalc
                            </span>
                          ) : null}
                        </div>
                      </div>
                      {row.loadable ? (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => loadHistoryTrade(row)}
                        >
                          Load
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </section>

          {/* <p className="muted trade-footnote">
            Values decay from Sleeper ADP rank 1 (100 pts). Starter upgrades rebuild each roster into
            1 QB / 2 RB / 2 WR / 1 TE / 2 FLEX / 1 DST. Players without ADP
            are ignored.
          </p> */}
        </>
      )}
    </div>
  );
}
