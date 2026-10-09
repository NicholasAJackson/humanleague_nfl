import {
  FANTASYCALC_CACHE_TTL_MS,
  FANTASYCALC_HOME,
  FANTASYCALC_STALE_TTL_MS,
  fantasyCalcQuery,
  fantasyCalcValuesUrl,
  normalizeFantasyCalcPlayer,
  sortFantasyCalcPlayers,
} from '../src/lib/fantasyCalc.js';

// Shared by GET /api/rankings?page_type=sleeper-trade-blend (not a Vercel function).
// FantasyCalc: cache current-values; they refresh about every 3 hours.
const UA = { 'user-agent': 'humanleague-nfl/trade-values', accept: 'application/json' };

/** @type {{ fetchedAt: number, payload: object } | null} */
let _cache = null;
/** @type {Promise<object> | null} */
let _inflight = null;

async function fetchJson(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Upstream ${url} responded ${res.status}${body ? `: ${body.slice(0, 160)}` : ''}`);
  }
  return res.json();
}

async function buildPayload() {
  const query = fantasyCalcQuery();
  const url = fantasyCalcValuesUrl(query);
  const raw = await fetchJson(url);
  const rows = Array.isArray(raw) ? raw : [];
  const players = sortFantasyCalcPlayers(rows.map(normalizeFantasyCalcPlayer).filter(Boolean));

  const fetchedAt = Date.now();
  return {
    page_type: 'sleeper-trade-blend',
    source: 'fantasycalc',
    attribution: {
      name: 'FantasyCalc',
      url: FANTASYCALC_HOME,
    },
    scoring: 'HALF',
    ranking_type: 'FANTASYCALC',
    is_dynasty: query.isDynasty,
    num_qbs: Number(query.numQbs) || 1,
    num_teams: query.numTeams,
    ppr: query.ppr,
    tep: query.tep,
    scrape_date: new Date(fetchedAt).toISOString(),
    fetched_at: fetchedAt,
    count: players.length,
    players,
  };
}

export async function getTradeValuesPayload() {
  const now = Date.now();
  if (_cache && now - _cache.fetchedAt < FANTASYCALC_CACHE_TTL_MS) return _cache.payload;
  if (_inflight) return _inflight;

  const stale = _cache;
  _inflight = (async () => {
    try {
      const payload = await buildPayload();
      _cache = { fetchedAt: Date.now(), payload };
      return payload;
    } catch (err) {
      if (stale && now - stale.fetchedAt < FANTASYCALC_STALE_TTL_MS) {
        console.warn('trade-values: serving stale FantasyCalc cache', err);
        return stale.payload;
      }
      throw err;
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}
