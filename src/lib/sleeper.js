const BASE = 'https://api.sleeper.app/v1';

const PREV_CACHE_KEY = 'sleeper:prev-league-id';
const STATS_CACHE_KEY = 'sleeper:season-cache:v2';
const STATS_TTL_MS = 1000 * 60 * 60 * 24;

async function getJSON(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    throw new Error(`Sleeper ${path} failed: ${res.status}`);
  }
  return res.json();
}

export function fetchLeague(leagueId) {
  return getJSON(`/league/${leagueId}`);
}

export function fetchUsers(leagueId) {
  return getJSON(`/league/${leagueId}/users`);
}

export function fetchRosters(leagueId) {
  return getJSON(`/league/${leagueId}/rosters`);
}

export function fetchMatchups(leagueId, week) {
  return getJSON(`/league/${leagueId}/matchups/${week}`);
}

export function fetchPlayoffBracket(leagueId, kind = 'winners') {
  return getJSON(`/league/${leagueId}/${kind}_bracket`);
}

/** League draft list (startup, rookie, etc.). */
export function fetchLeagueDrafts(leagueId) {
  return getJSON(`/league/${leagueId}/drafts`);
}

/** All picks for a draft (includes `metadata` with player names). */
export function fetchDraftPicks(draftId) {
  return getJSON(`/draft/${draftId}/picks`);
}

/** One shared in-memory map for the SPA session (Sleeper NFL players blob is large). */
let _nflPlayersLookupPromise = null;

/**
 * Resolves to Map(player_id -> { name, position }) for labeling roster players.
 * First call downloads `/players/nfl`; keep usage to pages that need it.
 */
/** Player ids on a roster (`players` may be array or map). */
export function rosterPlayerIds(roster) {
  if (!roster) return [];
  const p = roster.players;
  if (Array.isArray(p)) {
    return [...new Set(p.map((id) => String(id)).filter(Boolean))];
  }
  if (p && typeof p === 'object') {
    return [...new Set(Object.keys(p).map(String).filter(Boolean))];
  }
  return [];
}

export function getNflPlayersLookup() {
  if (!_nflPlayersLookupPromise) {
    _nflPlayersLookupPromise = getJSON('/players/nfl').then((data) => {
      const map = new Map();
      if (!data || typeof data !== 'object') return map;
      for (const [id, p] of Object.entries(data)) {
        if (!p || typeof id !== 'string' || id.length > 12) continue;
        const fn = p.first_name || '';
        const ln = p.last_name || '';
        const name = `${fn} ${ln}`.trim() || id;
        map.set(id, {
          name,
          position: p.position || '',
          team: p.team ? String(p.team) : '',
        });
      }
      return map;
    });
  }
  return _nflPlayersLookupPromise;
}

export function avatarUrl(avatar, thumb = false) {
  if (!avatar) return null;
  return `https://sleepercdn.com/avatars${thumb ? '/thumbs' : ''}/${avatar}`;
}

function readJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

export async function resolvePreviousLeagueId(currentLeagueId) {
  if (!currentLeagueId) return null;
  const cache = readJSON(PREV_CACHE_KEY) || {};
  if (cache[currentLeagueId]) return cache[currentLeagueId];

  const league = await fetchLeague(currentLeagueId);
  let prev = league.previous_league_id;

  if (!prev || prev === '0') {
    if (league.status === 'complete') {
      cache[currentLeagueId] = currentLeagueId;
      writeJSON(PREV_CACHE_KEY, cache);
      return currentLeagueId;
    }
    return null;
  }

  cache[currentLeagueId] = prev;
  writeJSON(PREV_CACHE_KEY, cache);
  return prev;
}

/**
 * Walks Sleeper’s previous_league_id chain starting from the **configured**
 * league (current season, e.g. 2026), then each older linked season (2025…).
 * Order: newest first.
 */
export async function resolveLeagueHistoryChain(currentLeagueId) {
  if (!currentLeagueId) return [];

  const out = [];
  const seen = new Set();
  const maxSeasons = 50;
  let id = currentLeagueId;

  while (id && !seen.has(id) && out.length < maxSeasons) {
    seen.add(id);
    const league = await fetchLeague(id);
    out.push({
      leagueId: id,
      season: league.season,
      name: league.name || `Season ${league.season}`,
    });
    const prev = league.previous_league_id;
    if (!prev || prev === '0' || prev === id) break;
    id = prev;
  }
  return out;
}

/**
 * Loads every linked season (newest first): metadata + fetchSeasonBundle payload.
 */
export async function fetchLeagueHistoryBundles(leagueId, { force = false } = {}) {
  const chain = await resolveLeagueHistoryChain(leagueId);
  if (!chain.length) return [];
  if (force) {
    chain.forEach(({ leagueId: lid }) => clearSeasonCache(lid));
  }
  const out = [];
  for (const meta of chain) {
    const bundle = await fetchSeasonBundle(meta.leagueId, { force });
    out.push({ ...meta, bundle });
  }
  return out;
}

export async function fetchSeasonBundle(leagueId, { force = false } = {}) {
  const cache = readJSON(STATS_CACHE_KEY) || {};
  const entry = cache[leagueId];
  if (!force && entry && Date.now() - entry.cachedAt < STATS_TTL_MS) {
    return entry.data;
  }

  const [league, users, rosters, winnersBracket] = await Promise.all([
    fetchLeague(leagueId),
    fetchUsers(leagueId),
    fetchRosters(leagueId),
    fetchPlayoffBracket(leagueId, 'winners').catch(() => null),
  ]);

  const playoffStart = Number(league.settings?.playoff_week_start) || 15;
  const lastRegularWeek = Math.max(1, playoffStart - 1);
  const totalWeeksGuess = Math.min(18, lastRegularWeek + 4);

  const weeks = Array.from({ length: totalWeeksGuess }, (_, i) => i + 1);
  const matchupsByWeek = {};
  await Promise.all(
    weeks.map(async (week) => {
      try {
        const data = await fetchMatchups(leagueId, week);
        if (Array.isArray(data) && data.length > 0) {
          matchupsByWeek[week] = data;
        }
      } catch {
      }
    })
  );

  const data = {
    league,
    users,
    rosters,
    matchupsByWeek,
    lastRegularWeek,
    winnersBracket,
    fetchedAt: Date.now(),
  };

  cache[leagueId] = { cachedAt: Date.now(), data };
  writeJSON(STATS_CACHE_KEY, cache);
  return data;
}

export function clearSeasonCache(leagueId) {
  const cache = readJSON(STATS_CACHE_KEY) || {};
  if (leagueId) {
    delete cache[leagueId];
  }
  writeJSON(STATS_CACHE_KEY, cache);
}
