import { send } from './_db.js';
// Public: ESPN/Sleeper trend proxies (not league-private). Guest browse mode needs this.

const ESPN_NEWS_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=50';
const SLEEPER_TREND_ADD = 'https://api.sleeper.app/v1/players/nfl/trending/add?lookback_hours=24&limit=50';
const SLEEPER_TREND_DROP = 'https://api.sleeper.app/v1/players/nfl/trending/drop?lookback_hours=24&limit=50';

const CACHE_TTL_MS = 15 * 60 * 1000;
const STALE_TTL_MS = 2 * 60 * 60 * 1000;

/** @type {{ fetchedAt: number, payload: object } | null} */
let _cache = null;
/** @type {Promise<object> | null} */
let _inflight = null;

function normalizeArticle(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const athletes = [];
  const teams = [];
  for (const cat of Array.isArray(raw.categories) ? raw.categories : []) {
    if (cat?.type === 'athlete' && cat.athlete?.description) {
      athletes.push({
        id: cat.athlete.id != null ? String(cat.athlete.id) : null,
        name: String(cat.athlete.description).trim(),
      });
    }
    if (cat?.type === 'team' && (cat.team?.abbreviation || cat.description)) {
      teams.push({
        id: cat.team?.id != null ? String(cat.team.id) : null,
        name: String(cat.team?.description || cat.description || '').trim(),
        abbr: String(cat.team?.abbreviation || '').trim() || null,
      });
    }
  }
  const headline = String(raw.headline || '').trim();
  if (!headline) return null;
  const link =
    raw.links?.web?.href ||
    raw.links?.mobile?.href ||
    (raw.id != null ? `https://www.espn.com/nfl/story/_/id/${raw.id}` : null);
  return {
    id: raw.id != null ? String(raw.id) : headline,
    headline,
    description: String(raw.description || '').trim() || null,
    published: raw.published || raw.lastModified || null,
    link,
    athletes,
    teams,
  };
}

function normalizeTrendRow(row, rank) {
  if (!row || row.player_id == null) return null;
  const count = Number(row.count);
  return {
    sleeper_id: String(row.player_id),
    count: Number.isFinite(count) ? count : 0,
    rank: rank + 1,
  };
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'humanleague-nfl/trade-hype',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${url} → ${res.status}${body ? `: ${body.slice(0, 120)}` : ''}`);
  }
  return res.json();
}

async function buildPayload() {
  const [newsRaw, addRaw, dropRaw] = await Promise.all([
    fetchJson(ESPN_NEWS_URL),
    fetchJson(SLEEPER_TREND_ADD),
    fetchJson(SLEEPER_TREND_DROP),
  ]);

  const articles = (Array.isArray(newsRaw?.articles) ? newsRaw.articles : [])
    .map(normalizeArticle)
    .filter(Boolean);

  const trending_add = (Array.isArray(addRaw) ? addRaw : [])
    .map((row, i) => normalizeTrendRow(row, i))
    .filter(Boolean);

  const trending_drop = (Array.isArray(dropRaw) ? dropRaw : [])
    .map((row, i) => normalizeTrendRow(row, i))
    .filter(Boolean);

  return {
    articles,
    trending_add,
    trending_drop,
    lookback_hours: 24,
    fetched_at: Date.now(),
    sources: { espn: 'nfl-news', sleeper: 'trending-add-drop' },
  };
}

async function getHypePayload() {
  const now = Date.now();
  if (_cache && now - _cache.fetchedAt < CACHE_TTL_MS) {
    return _cache.payload;
  }
  if (_inflight) return _inflight;

  const stale = _cache && now - _cache.fetchedAt < STALE_TTL_MS ? _cache.payload : null;
  _inflight = (async () => {
    try {
      const payload = await buildPayload();
      _cache = { fetchedAt: payload.fetched_at, payload };
      return payload;
    } catch (err) {
      if (stale) {
        console.warn('trade-hype: serving stale cache', err);
        return stale;
      }
      throw err;
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return send(res, 405, { error: 'Method not allowed' });
    }

    const payload = await getHypePayload();
    res.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=7200');
    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(JSON.stringify(payload));
  } catch (err) {
    console.error('trade-hype handler error', err);
    return send(res, 502, { error: 'Could not load trade hype (upstream unavailable)' });
  }
}
