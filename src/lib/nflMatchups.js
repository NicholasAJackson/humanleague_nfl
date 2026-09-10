const POS_ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'DST', 'DEF'];

export function normalizeNflTeam(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase();
}

export function normalizeStarterPos(pos) {
  const p = String(pos || '')
    .trim()
    .toUpperCase();
  if (p === 'DEF') return 'DST';
  return p;
}

function positionRank(pos) {
  const p = normalizeStarterPos(pos);
  const i = POS_ORDER.indexOf(p);
  return i === -1 ? 50 : i;
}

/**
 * NFL team abbreviation for a Sleeper player id.
 * DEF/DST often use the team code as the player id when `team` is empty.
 */
export function playerNflTeam(playerId, lookup) {
  const id = String(playerId || '');
  if (!id) return '';
  const meta = lookup?.get(id);
  const fromMeta = normalizeNflTeam(meta?.team);
  if (fromMeta) return fromMeta;
  const pos = String(meta?.position || '').toUpperCase();
  if (pos === 'DEF' || pos === 'DST') return normalizeNflTeam(id);
  if (!meta && /^[A-Z]{2,4}$/i.test(id)) return normalizeNflTeam(id);
  return '';
}

export function weeksInSchedule(games) {
  const set = new Set();
  for (const g of games || []) {
    const w = Number(g.week);
    if (Number.isFinite(w) && w >= 1 && w <= 22) set.add(w);
  }
  return [...set].sort((a, b) => a - b);
}

export function gamesForWeek(games, week) {
  const w = Number(week);
  return (games || []).filter((g) => {
    if (Number(g.week) !== w) return false;
    const status = String(g.status || '').toLowerCase();
    return status !== 'canceled' && status !== 'cancelled';
  });
}

function teamLabel(usersById, ownerId, rosterId) {
  const user = ownerId != null ? usersById.get(String(ownerId)) : null;
  return (
    user?.metadata?.team_name ||
    user?.display_name ||
    (rosterId != null ? `Team ${rosterId}` : 'Unknown team')
  );
}

function readPlayerPoints(matchup, playerId, starterIndex) {
  const id = String(playerId);
  const map = matchup?.players_points;
  if (map && typeof map === 'object') {
    const raw = map[id] ?? map[playerId];
    const n = Number(raw);
    if (raw != null && Number.isFinite(n)) return n;
  }
  const arr = Array.isArray(matchup?.starters_points) ? matchup.starters_points : [];
  if (starterIndex != null && starterIndex >= 0) {
    const n = Number(arr[starterIndex]);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function starterRowsFromMatchups(matchups, rosterById, usersById, lookup) {
  const rows = [];
  const seen = new Set();
  for (const m of matchups || []) {
    const rosterId = m?.roster_id;
    const roster = rosterId != null ? rosterById.get(Number(rosterId)) : null;
    const ownerId = roster?.owner_id != null ? String(roster.owner_id) : null;
    const ids = Array.isArray(m?.starters) ? m.starters : [];
    ids.forEach((raw, index) => {
      const id = raw != null ? String(raw).trim() : '';
      if (!id || id === '0') return;
      const key = `${rosterId}:${id}`;
      if (seen.has(key)) return;
      seen.add(key);
      rows.push(
        makeStarterRow(id, rosterId, ownerId, usersById, lookup, readPlayerPoints(m, id, index)),
      );
    });
  }
  return rows;
}

function starterRowsFromRosters(rosters, usersById, lookup) {
  const rows = [];
  const seen = new Set();
  for (const roster of rosters || []) {
    const rosterId = roster?.roster_id;
    const ownerId = roster?.owner_id != null ? String(roster.owner_id) : null;
    const ids = Array.isArray(roster?.starters) ? roster.starters : [];
    for (const raw of ids) {
      const id = raw != null ? String(raw).trim() : '';
      if (!id || id === '0') continue;
      const key = `${rosterId}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(makeStarterRow(id, rosterId, ownerId, usersById, lookup));
    }
  }
  return rows;
}

function makeStarterRow(playerId, rosterId, ownerId, usersById, lookup, points = null) {
  const meta = lookup?.get(String(playerId));
  const pos = normalizeStarterPos(meta?.position);
  return {
    playerId: String(playerId),
    name: meta?.name || String(playerId),
    position: pos || '—',
    nflTeam: playerNflTeam(playerId, lookup),
    rosterId,
    ownerId,
    fantasyTeam: teamLabel(usersById, ownerId, rosterId),
    points: points != null && Number.isFinite(Number(points)) ? Number(points) : null,
  };
}

function sumPoints(rows) {
  let sum = 0;
  let any = false;
  for (const r of rows || []) {
    if (r.points != null && Number.isFinite(r.points)) {
      sum += r.points;
      any = true;
    }
  }
  return any ? Math.round(sum * 10) / 10 : null;
}

function scoringStarted(rows, status) {
  const s = String(status || '').toLowerCase();
  if (s === 'complete' || s === 'in_progress' || s === 'live') return true;
  return (rows || []).some((r) => r.points != null && Number(r.points) !== 0);
}

function sortStarters(a, b) {
  const rp = positionRank(a.position) - positionRank(b.position);
  if (rp !== 0) return rp;
  return String(a.name).localeCompare(String(b.name));
}

function parseGameDate(dateStr) {
  const s = String(dateStr || '');
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * Join weekly fantasy starters onto NFL games for one week.
 * Uses matchup `starters` when present; otherwise current roster starters.
 */
export function buildNflGameCards({
  games,
  week,
  matchups,
  rosters,
  users,
  playersLookup,
  viewerOwnerId,
  matchupsLoaded = true,
  allowRosterFallback = true,
} = {}) {
  const weekGames = gamesForWeek(games, week).map((g) => ({
    gameId: g.game_id != null ? String(g.game_id) : `${g.away}-${g.home}-${g.date}`,
    away: normalizeNflTeam(g.away),
    home: normalizeNflTeam(g.home),
    date: g.date || '',
    dateMs: parseGameDate(g.date)?.getTime() ?? 0,
    status: String(g.status || '').toLowerCase() || 'pre_game',
  }));

  const gameByTeam = new Map();
  const playing = new Set();
  for (const g of weekGames) {
    if (g.away) {
      gameByTeam.set(g.away, g);
      playing.add(g.away);
    }
    if (g.home) {
      gameByTeam.set(g.home, g);
      playing.add(g.home);
    }
  }

  const usersById = new Map(
    (users || []).map((u) => [String(u.user_id), u]),
  );
  const rosterById = new Map(
    (rosters || []).map((r) => [Number(r.roster_id), r]),
  );

  const hasMatchupStarters =
    matchupsLoaded &&
    (matchups || []).some(
      (m) => Array.isArray(m?.starters) && m.starters.some((id) => id && String(id) !== '0'),
    );
  const starters = hasMatchupStarters
    ? starterRowsFromMatchups(matchups, rosterById, usersById, playersLookup)
    : matchupsLoaded && allowRosterFallback
      ? starterRowsFromRosters(rosters, usersById, playersLookup)
      : [];

  const viewer = viewerOwnerId != null && String(viewerOwnerId).length > 0
    ? String(viewerOwnerId)
    : null;

  const awayByGame = new Map();
  const homeByGame = new Map();
  const bye = [];

  for (const row of starters) {
    if (!row.nflTeam) continue;
    const game = gameByTeam.get(row.nflTeam);
    if (game) {
      const bucket = row.nflTeam === game.away ? awayByGame : homeByGame;
      if (!bucket.has(game.gameId)) bucket.set(game.gameId, []);
      bucket.get(game.gameId).push(row);
    } else if (!playing.has(row.nflTeam)) {
      bye.push(row);
    }
  }

  const cards = weekGames.map((g) => {
    const awayStarters = (awayByGame.get(g.gameId) || []).slice().sort(sortStarters);
    const homeStarters = (homeByGame.get(g.gameId) || []).slice().sort(sortStarters);
    const all = [...awayStarters, ...homeStarters];
    const youCount = viewer
      ? all.filter((p) => p.ownerId === viewer).length
      : 0;
    const awayPoints = sumPoints(awayStarters);
    const homePoints = sumPoints(homeStarters);
    const pointsTotal = sumPoints(all);
    return {
      ...g,
      awayStarters,
      homeStarters,
      starterCount: all.length,
      youCount,
      awayPoints,
      homePoints,
      pointsTotal,
      hasScoring: scoringStarted(all, g.status),
    };
  });

  cards.sort((a, b) => {
    const you = (b.youCount > 0 ? 1 : 0) - (a.youCount > 0 ? 1 : 0);
    if (you !== 0) return you;
    if (a.dateMs !== b.dateMs) return a.dateMs - b.dateMs;
    return `${a.away}@${a.home}`.localeCompare(`${b.away}@${b.home}`);
  });

  return {
    cards,
    bye: bye.slice().sort(sortStarters),
    byeYouCount: viewer ? bye.filter((p) => p.ownerId === viewer).length : 0,
    byePoints: sumPoints(bye),
    byeHasScoring: scoringStarted(bye, null),
  };
}
