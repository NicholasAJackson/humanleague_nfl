import { send } from './_db.js';
import { assertSiteAuth } from './_auth.js';

const ECR_URL = 'https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_fpecr_latest.csv';
const IDS_URL = 'https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv';
const FP_API_BASE = 'https://api.fantasypros.com/public/v2/json';

const ECR_PAGE_TYPES = new Set(['redraft-overall']);
const FP_PAGE_TYPES = new Set(['fp-ecr-half']);
const SLEEPER_ADP_PAGE_TYPES = new Set(['sleeper-adp-half']);

const ALLOWED_PAGE_TYPES = new Set([
  ...ECR_PAGE_TYPES,
  ...FP_PAGE_TYPES,
  ...SLEEPER_ADP_PAGE_TYPES,
]);

const DEFAULT_PAGE_TYPE = 'redraft-overall';

/** ttl matches DynastyProcess's weekly-fantasypros cron — 1h is fine for warm cache hits. */
const CACHE_TTL_MS = 60 * 60 * 1000;
const STALE_TTL_MS = 24 * 60 * 60 * 1000;
/** Live FantasyPros consensus — shorter TTL so rankings stay fresher. */
const FP_CACHE_TTL_MS = 30 * 60 * 1000;
const FP_STALE_TTL_MS = 6 * 60 * 60 * 1000;
/** Sleeper platform ADP — same cadence as live FP lists. */
const SLEEPER_ADP_CACHE_TTL_MS = 30 * 60 * 1000;
const SLEEPER_ADP_STALE_TTL_MS = 6 * 60 * 60 * 1000;

/** Sleeper fills missing ADP with ~999; keep only real draft-board values. */
const SLEEPER_ADP_MAX = 500;

let _cache = {
  fetchedAt: 0,
  ecrByPageType: null,
  idMap: null,
  scrapeDate: null,
};
let _inflight = null;

/** @type {Map<string, { fetchedAt: number, scrapeDate: string|null, players: object[] }>} */
const _fpCache = new Map();
/** @type {Map<string, Promise<object>>} */
const _fpInflight = new Map();

/** @type {{ fetchedAt: number, scrapeDate: string|null, players: object[], page_type?: string } | null} */
let _sleeperAdpCache = null;
/** @type {Promise<object> | null} */
let _sleeperAdpInflight = null;

/** Minimal RFC 4180 CSV parser. Handles quoted fields and embedded commas/newlines. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\r') {
      // swallow \r so \r\n collapses to one row break
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function rowsToObjects(rows) {
  if (!rows.length) return [];
  const header = rows[0];
  const out = new Array(rows.length - 1);
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length === 1 && r[0] === '') continue; // trailing blank line
    const obj = {};
    for (let j = 0; j < header.length; j++) {
      obj[header[j]] = r[j];
    }
    out[i - 1] = obj;
  }
  return out.filter(Boolean);
}

function isMissing(v) {
  return v == null || v === '' || v === 'NA';
}

function toNum(v) {
  if (isMissing(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'humanleague-nfl/rankings' } });
  if (!res.ok) {
    throw new Error(`Upstream ${url} responded ${res.status}`);
  }
  return res.text();
}

/** Active NFL fantasy season for FantasyPros consensus (draft year). */
function fantasyProsSeason() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-based
  // Jan–Feb: still often preseason of the upcoming calendar year.
  if (month <= 1) return y;
  return y;
}

function fantasyProsApiKey() {
  return String(process.env.FANTASYPROS_API_KEY || '').trim();
}

async function buildIdMap() {
  const idsText = await fetchText(IDS_URL);
  const idRows = rowsToObjects(parseCsv(idsText));
  const idMap = new Map();
  for (const r of idRows) {
    const fp = r.fantasypros_id;
    const sl = r.sleeper_id;
    if (isMissing(fp) || isMissing(sl)) continue;
    idMap.set(String(fp), String(sl));
  }
  return idMap;
}

async function buildCache() {
  const [ecrText, idMap] = await Promise.all([fetchText(ECR_URL), buildIdMap()]);

  const ecrRows = rowsToObjects(parseCsv(ecrText));
  const ecrByPageType = new Map();
  let scrapeDate = null;

  for (const r of ecrRows) {
    const pageType = r.page_type;
    if (!pageType || !ECR_PAGE_TYPES.has(pageType)) continue;
    const ecr = toNum(r.ecr);
    if (ecr == null) continue;
    if (!scrapeDate && r.scrape_date) scrapeDate = r.scrape_date;

    const fpId = isMissing(r.id) ? null : String(r.id);
    const sleeperId = fpId ? idMap.get(fpId) || null : null;

    const player = {
      ecr,
      sd: toNum(r.sd),
      best: toNum(r.best),
      worst: toNum(r.worst),
      name: r.player || '',
      pos: r.pos || '',
      team: r.tm || r.team || '',
      bye: toNum(r.bye),
      owned_avg: toNum(r.player_owned_avg),
      rank_delta: toNum(r.rank_delta),
      fp_id: fpId,
      sleeper_id: sleeperId,
    };

    let bucket = ecrByPageType.get(pageType);
    if (!bucket) {
      bucket = [];
      ecrByPageType.set(pageType, bucket);
    }
    bucket.push(player);
  }

  for (const list of ecrByPageType.values()) {
    list.sort((a, b) => a.ecr - b.ecr);
  }

  return { ecrByPageType, idMap, scrapeDate, fetchedAt: Date.now() };
}

async function getCache() {
  const now = Date.now();
  if (_cache.ecrByPageType && now - _cache.fetchedAt < CACHE_TTL_MS) {
    return _cache;
  }
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const next = await buildCache();
      _cache = next;
      return _cache;
    } catch (err) {
      if (_cache.ecrByPageType && now - _cache.fetchedAt < STALE_TTL_MS) {
        console.warn('rankings: upstream fetch failed, serving stale cache', err);
        return _cache;
      }
      throw err;
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

/** Ensure we have a FantasyPros → Sleeper id map (reuse DynastyProcess cache when warm). */
async function getIdMap() {
  if (_cache.idMap && Date.now() - _cache.fetchedAt < STALE_TTL_MS) {
    return _cache.idMap;
  }
  try {
    const cache = await getCache();
    return cache.idMap;
  } catch {
    return buildIdMap();
  }
}

function normalizeFpPlayer(p, idMap) {
  const fpId = p.player_id != null ? String(p.player_id) : null;
  const rank =
    toNum(p.rank_ecr) ??
    toNum(p.rank_adp) ??
    toNum(p.rank_ave);
  const posRaw = String(p.player_position_id || p.player_positions || '').split(',')[0].trim();
  return {
    ecr: rank,
    sd: toNum(p.rank_std),
    best: toNum(p.rank_min),
    worst: toNum(p.rank_max),
    name: p.player_name || '',
    pos: posRaw,
    team: p.player_team_id || '',
    bye: toNum(p.player_bye_week),
    owned_avg: toNum(p.player_owned_avg),
    rank_delta: null,
    fp_id: fpId,
    sleeper_id: fpId ? idMap.get(fpId) || null : null,
  };
}

function parseFpLastUpdated(raw, year) {
  if (!raw) return null;
  const s = String(raw).trim();
  // FantasyPros often returns "7/11" style dates
  const mdy = /^(\d{1,2})\/(\d{1,2})$/.exec(s);
  if (mdy) {
    const month = Number(mdy[1]);
    const day = Number(mdy[2]);
    const y = year || new Date().getUTCFullYear();
    const iso = new Date(Date.UTC(y, month - 1, day));
    if (!Number.isNaN(iso.getTime())) return iso.toISOString();
  }
  const parsed = Date.parse(s);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  return s;
}

async function fetchFantasyProsConsensus(pageType, idMap) {
  const apiKey = fantasyProsApiKey();
  if (!apiKey) {
    const err = new Error('FANTASYPROS_API_KEY is not configured');
    err.code = 'FP_KEY_MISSING';
    throw err;
  }

  const season = fantasyProsSeason();
  const params = new URLSearchParams({
    position: 'ALL',
    scoring: 'HALF',
  });

  const url = `${FP_API_BASE}/nfl/${season}/consensus-rankings?${params}`;
  const res = await fetch(url, {
    headers: {
      'x-api-key': apiKey,
      'user-agent': 'humanleague-nfl/rankings',
      accept: 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`FantasyPros API responded ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }

  const data = await res.json();
  const rawPlayers = Array.isArray(data.players) ? data.players : [];
  const players = rawPlayers
    .map((p) => normalizeFpPlayer(p, idMap))
    .filter((p) => p.ecr != null);
  players.sort((a, b) => a.ecr - b.ecr);

  return {
    page_type: pageType,
    scrape_date: parseFpLastUpdated(data.last_updated, Number(data.year) || season),
    fetched_at: Date.now(),
    count: players.length,
    players,
    source: 'fantasypros',
    scoring: data.scoring || 'HALF',
    ranking_type: data.type || 'Preseason',
  };
}

async function getFantasyProsRankings(pageType) {
  const now = Date.now();
  const hit = _fpCache.get(pageType);
  if (hit && now - hit.fetched_at < FP_CACHE_TTL_MS) {
    return hit;
  }

  const existing = _fpInflight.get(pageType);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const idMap = await getIdMap();
      const next = await fetchFantasyProsConsensus(pageType, idMap);
      _fpCache.set(pageType, next);
      return next;
    } catch (err) {
      if (hit && now - hit.fetched_at < FP_STALE_TTL_MS) {
        console.warn('rankings: FantasyPros fetch failed, serving stale cache', err);
        return hit;
      }
      throw err;
    } finally {
      _fpInflight.delete(pageType);
    }
  })();

  _fpInflight.set(pageType, promise);
  return promise;
}

async function fetchSleeperNflSeason() {
  const res = await fetch('https://api.sleeper.app/v1/state/nfl', {
    headers: { 'user-agent': 'humanleague-nfl/rankings', accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Sleeper NFL state responded ${res.status}`);
  }
  const state = await res.json();
  const season = String(state.league_season || state.season || '').trim();
  if (!/^\d{4}$/.test(season)) {
    throw new Error('Sleeper NFL state missing season');
  }
  return season;
}

function normalizeSleeperPos(raw) {
  const pos = String(raw || '').trim().toUpperCase();
  if (pos === 'DEF') return 'DST';
  return pos;
}

function normalizeSleeperAdpPlayer(row) {
  const stats = row && row.stats && typeof row.stats === 'object' ? row.stats : {};
  const adp = toNum(stats.adp_half_ppr);
  if (adp == null || adp <= 0 || adp >= SLEEPER_ADP_MAX) return null;

  const player = row.player && typeof row.player === 'object' ? row.player : {};
  const first = String(player.first_name || '').trim();
  const last = String(player.last_name || '').trim();
  const name = `${first} ${last}`.trim() || String(row.player_id || '');
  const pos = normalizeSleeperPos(player.position || (player.fantasy_positions || [])[0]);
  const sleeperId = row.player_id != null ? String(row.player_id) : null;

  return {
    ecr: adp,
    sd: null,
    best: null,
    worst: null,
    name,
    pos,
    team: String(player.team || row.team || '').trim(),
    bye: null,
    owned_avg: null,
    rank_delta: null,
    fp_id: null,
    sleeper_id: sleeperId,
  };
}

async function fetchSleeperAdpHalf() {
  const season = await fetchSleeperNflSeason();
  const params = new URLSearchParams({
    season_type: 'regular',
    order_by: 'adp_half_ppr',
  });
  for (const pos of ['QB', 'RB', 'WR', 'TE', 'DEF']) {
    params.append('position[]', pos);
  }

  const url = `https://api.sleeper.com/projections/nfl/${season}?${params}`;
  const res = await fetch(url, {
    headers: { 'user-agent': 'humanleague-nfl/rankings', accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Sleeper projections responded ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }

  const raw = await res.json();
  const rows = Array.isArray(raw) ? raw : [];
  const players = rows.map(normalizeSleeperAdpPlayer).filter(Boolean);
  players.sort((a, b) => a.ecr - b.ecr);

  let latestMs = 0;
  for (const row of rows) {
    const ms = Number(row.updated_at || row.last_modified || 0);
    if (Number.isFinite(ms) && ms > latestMs) latestMs = ms;
  }

  return {
    page_type: 'sleeper-adp-half',
    scrape_date: latestMs > 0 ? new Date(latestMs).toISOString() : null,
    fetched_at: Date.now(),
    count: players.length,
    players,
    source: 'sleeper',
    scoring: 'HALF',
    ranking_type: 'ADP',
    season,
  };
}

async function getSleeperAdpRankings() {
  const now = Date.now();
  if (_sleeperAdpCache && now - _sleeperAdpCache.fetched_at < SLEEPER_ADP_CACHE_TTL_MS) {
    return _sleeperAdpCache;
  }
  if (_sleeperAdpInflight) return _sleeperAdpInflight;

  const stale = _sleeperAdpCache;
  _sleeperAdpInflight = (async () => {
    try {
      const next = await fetchSleeperAdpHalf();
      _sleeperAdpCache = next;
      return next;
    } catch (err) {
      if (stale && now - stale.fetched_at < SLEEPER_ADP_STALE_TTL_MS) {
        console.warn('rankings: Sleeper ADP fetch failed, serving stale cache', err);
        return stale;
      }
      throw err;
    } finally {
      _sleeperAdpInflight = null;
    }
  })();
  return _sleeperAdpInflight;
}

export default async function handler(req, res) {
  try {
    if (!assertSiteAuth(req, res, send)) return;

    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return send(res, 405, { error: 'Method not allowed' });
    }

    const url = new URL(req.url, 'http://localhost');
    const requested = String(url.searchParams.get('page_type') || DEFAULT_PAGE_TYPE);
    const pageType = ALLOWED_PAGE_TYPES.has(requested) ? requested : DEFAULT_PAGE_TYPE;

    if (FP_PAGE_TYPES.has(pageType)) {
      if (!fantasyProsApiKey()) {
        return send(res, 503, {
          error: 'FantasyPros live rankings require FANTASYPROS_API_KEY on the server',
        });
      }
      try {
        const payload = await getFantasyProsRankings(pageType);
        res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=21600');
        res.status(200);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.send(JSON.stringify(payload));
        return;
      } catch (err) {
        if (err && err.code === 'FP_KEY_MISSING') {
          return send(res, 503, {
            error: 'FantasyPros live rankings require FANTASYPROS_API_KEY on the server',
          });
        }
        throw err;
      }
    }

    if (SLEEPER_ADP_PAGE_TYPES.has(pageType)) {
      const payload = await getSleeperAdpRankings();
      res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=21600');
      res.status(200);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.send(JSON.stringify(payload));
      return;
    }

    const cache = await getCache();
    const players = cache.ecrByPageType.get(pageType) || [];

    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(
      JSON.stringify({
        page_type: pageType,
        scrape_date: cache.scrapeDate,
        fetched_at: cache.fetchedAt,
        count: players.length,
        players,
        source: 'dynastyprocess',
      }),
    );
  } catch (err) {
    console.error('rankings handler error', err);
    return send(res, 502, { error: 'Could not load rankings (upstream unavailable)' });
  }
}
