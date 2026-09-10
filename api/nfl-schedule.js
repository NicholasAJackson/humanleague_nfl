import { send } from './_db.js';
// Public: NFL schedule is not league-private. Guest browse / Home widget need this
// when the browser cannot call api.sleeper.com (CORS).

const CACHE_TTL_MS = 30 * 60 * 1000;
const STALE_TTL_MS = 12 * 60 * 60 * 1000;

/** @type {Map<string, { fetchedAt: number, games: object[] }>} */
const _cache = new Map();
/** @type {Map<string, Promise<object[]>>} */
const _inflight = new Map();

async function fetchSchedule(season) {
  const url = `https://api.sleeper.com/schedule/nfl/regular/${encodeURIComponent(season)}`;
  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'humanleague-nfl/nfl-schedule',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Sleeper schedule ${res.status}${body ? `: ${body.slice(0, 120)}` : ''}`);
  }
  const raw = await res.json();
  return Array.isArray(raw) ? raw : [];
}

async function getSchedule(season) {
  const now = Date.now();
  const hit = _cache.get(season);
  if (hit && now - hit.fetchedAt < CACHE_TTL_MS) return hit.games;

  if (_inflight.has(season)) return _inflight.get(season);

  const promise = (async () => {
    try {
      const games = await fetchSchedule(season);
      _cache.set(season, { fetchedAt: Date.now(), games });
      return games;
    } catch (err) {
      if (hit && now - hit.fetchedAt < STALE_TTL_MS) {
        console.warn('nfl-schedule: serving stale cache', err);
        return hit.games;
      }
      throw err;
    } finally {
      _inflight.delete(season);
    }
  })();

  _inflight.set(season, promise);
  return promise;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return send(res, 405, { error: 'Method not allowed' });
    }

    const season = String(req.query?.season || '').trim();
    if (!/^\d{4}$/.test(season)) {
      return send(res, 400, { error: 'season must be a 4-digit year' });
    }

    const games = await getSchedule(season);
    res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=43200');
    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(JSON.stringify({ season, games }));
  } catch (err) {
    console.error('nfl-schedule handler error', err);
    return send(res, 502, { error: 'Could not load NFL schedule (upstream unavailable)' });
  }
}
