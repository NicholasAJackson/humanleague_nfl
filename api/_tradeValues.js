import {
  TRADE_BLEND_DEFAULTS,
  blendTradePlayers,
  blendWeights,
  scoredNflWeeks,
} from '../src/lib/tradeBlend.js';

// Shared by GET /api/rankings?page_type=sleeper-trade-blend (not a Vercel function).

const CACHE_TTL_MS = 30 * 60 * 1000;
const STALE_TTL_MS = 6 * 60 * 60 * 1000;
const SLEEPER_ADP_MAX = 500;
const SKILL_POS = new Set(['QB', 'RB', 'WR', 'TE', 'DST']);
const UA = { 'user-agent': 'humanleague-nfl/trade-values', accept: 'application/json' };

/** @type {{ fetchedAt: number, payload: object } | null} */
let _cache = null;
/** @type {Promise<object> | null} */
let _inflight = null;

function toNum(v) {
  if (v == null || v === '' || v === 'NA') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizePos(raw) {
  const p = String(raw || '')
    .trim()
    .toUpperCase();
  if (p === 'DEF') return 'DST';
  return p;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Upstream ${url} responded ${res.status}${body ? `: ${body.slice(0, 160)}` : ''}`);
  }
  return res.json();
}

function byeByTeamFromSchedule(games) {
  const weeksByTeam = new Map();
  const allWeeks = new Set();
  for (const g of games || []) {
    const w = Number(g.week);
    if (!Number.isFinite(w) || w < 1 || w > 18) continue;
    allWeeks.add(w);
    for (const t of [g.home, g.away]) {
      const team = String(t || '')
        .trim()
        .toUpperCase();
      if (!team) continue;
      if (!weeksByTeam.has(team)) weeksByTeam.set(team, new Set());
      weeksByTeam.get(team).add(w);
    }
  }
  const weekList = [...allWeeks].sort((a, b) => a - b);
  const byeByTeam = new Map();
  for (const [team, weeks] of weeksByTeam) {
    const missing = weekList.filter((w) => !weeks.has(w));
    if (missing.length === 1) byeByTeam.set(team, missing[0]);
    else if (missing.length > 1) {
      const mid = missing.find((w) => w >= 5 && w <= 14) ?? missing[0];
      byeByTeam.set(team, mid);
    }
  }
  return byeByTeam;
}

function normalizeProjRow(row, byeByTeam) {
  const stats = row && row.stats && typeof row.stats === 'object' ? row.stats : {};
  const player = row && row.player && typeof row.player === 'object' ? row.player : {};
  const pos = normalizePos(player.position || (player.fantasy_positions || [])[0]);
  if (!SKILL_POS.has(pos)) return null;

  const sleeperId = row.player_id != null ? String(row.player_id) : null;
  if (!sleeperId) return null;

  const first = String(player.first_name || '').trim();
  const last = String(player.last_name || '').trim();
  const name = `${first} ${last}`.trim() || sleeperId;
  const team = String(player.team || row.team || (pos === 'DST' ? sleeperId : '')).trim();
  const adp = toNum(stats.adp_half_ppr);
  const ptsSeason = toNum(stats.pts_half_ppr);
  const injury = String(player.injury_status || '').trim() || null;
  const bye =
    team && byeByTeam instanceof Map && byeByTeam.has(team.toUpperCase())
      ? byeByTeam.get(team.toUpperCase())
      : null;

  const adpOk = adp != null && adp > 0 && adp < SLEEPER_ADP_MAX;
  if ((ptsSeason == null || ptsSeason <= 0) && !adpOk) return null;

  return {
    name,
    pos,
    team,
    sleeper_id: sleeperId,
    fp_id: null,
    adp: adpOk ? adp : null,
    pts_season_proj: ptsSeason != null && ptsSeason > 0 ? ptsSeason : null,
    injury_status: injury,
    bye,
  };
}

function statsMapFromPayload(raw) {
  const out = new Map();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, row] of Object.entries(raw)) {
    if (!row || typeof row !== 'object') continue;
    out.set(String(id), row);
  }
  return out;
}

function ytdFromSeasonStats(raw) {
  const out = new Map();
  for (const [id, row] of statsMapFromPayload(raw)) {
    const pts = toNum(row.pts_half_ppr);
    if (pts != null) out.set(id, pts);
  }
  return out;
}

async function fetchNflState() {
  const state = await fetchJson('https://api.sleeper.app/v1/state/nfl');
  const season = String(state.league_season || state.season || '').trim();
  if (!/^\d{4}$/.test(season)) throw new Error('Sleeper NFL state missing season');
  return {
    season,
    week: Number(state.week) || Number(state.display_week) || null,
    display_week: Number(state.display_week) || Number(state.week) || null,
    season_type: String(state.season_type || ''),
  };
}

async function buildPayload() {
  const state = await fetchNflState();
  const { season } = state;

  const projParams = new URLSearchParams({
    season_type: 'regular',
    order_by: 'pts_half_ppr',
  });
  for (const pos of ['QB', 'RB', 'WR', 'TE', 'DEF']) {
    projParams.append('position[]', pos);
  }

  const [games, projRaw, seasonStats] = await Promise.all([
    fetchJson(`https://api.sleeper.com/schedule/nfl/regular/${encodeURIComponent(season)}`).then(
      (raw) => (Array.isArray(raw) ? raw : []),
    ),
    fetchJson(`https://api.sleeper.com/projections/nfl/${season}?${projParams}`),
    fetchJson(`https://api.sleeper.app/v1/stats/nfl/regular/${encodeURIComponent(season)}`).catch(
      (err) => {
        console.warn('trade-values: season stats unavailable', err);
        return {};
      },
    ),
  ]);

  const scoredWeeks = scoredNflWeeks(games);
  const recentWeeks = scoredWeeks.slice(-TRADE_BLEND_DEFAULTS.recentWeeksMax);
  const weights = blendWeights(scoredWeeks.length);

  const weeklyEntries = await Promise.all(
    recentWeeks.map(async (week) => {
      try {
        const raw = await fetchJson(
          `https://api.sleeper.app/v1/stats/nfl/regular/${encodeURIComponent(season)}/${week}`,
        );
        return [week, statsMapFromPayload(raw)];
      } catch (err) {
        console.warn(`trade-values: week ${week} stats unavailable`, err);
        return [week, new Map()];
      }
    }),
  );
  const weeklyStatsByWeek = new Map(weeklyEntries);

  const byeByTeam = byeByTeamFromSchedule(games);
  const projRows = Array.isArray(projRaw) ? projRaw : [];
  const inputs = projRows.map((row) => normalizeProjRow(row, byeByTeam)).filter(Boolean);

  const blended = blendTradePlayers(inputs, {
    ytdById: ytdFromSeasonStats(seasonStats),
    weeklyStatsByWeek,
    recentWeeks,
    games,
    weights,
  });
  const players = blended.map((p) => {
    const { weights_used, pts_season_proj, ...rest } = p;
    return rest;
  });

  let latestMs = 0;
  for (const row of projRows) {
    const ms = Number(row.updated_at || row.last_modified || 0);
    if (Number.isFinite(ms) && ms > latestMs) latestMs = ms;
  }

  return {
    page_type: 'sleeper-trade-blend',
    source: 'sleeper-blend',
    scoring: 'HALF',
    ranking_type: 'BLEND',
    season,
    nfl_week: state.week,
    display_week: state.display_week,
    scored_weeks: scoredWeeks,
    recent_weeks: recentWeeks,
    weights,
    scrape_date: latestMs > 0 ? new Date(latestMs).toISOString() : null,
    fetched_at: Date.now(),
    count: players.length,
    players,
  };
}

export async function getTradeValuesPayload() {
  const now = Date.now();
  if (_cache && now - _cache.fetchedAt < CACHE_TTL_MS) return _cache.payload;
  if (_inflight) return _inflight;

  const stale = _cache;
  _inflight = (async () => {
    try {
      const payload = await buildPayload();
      _cache = { fetchedAt: Date.now(), payload };
      return payload;
    } catch (err) {
      if (stale && now - stale.fetchedAt < STALE_TTL_MS) {
        console.warn('trade-values: serving stale cache', err);
        return stale.payload;
      }
      throw err;
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}
