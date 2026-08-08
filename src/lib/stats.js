import { avatarUrl } from './sleeper.js';

export function buildTeams(users, rosters) {
  const userById = Object.fromEntries(users.map((u) => [u.user_id, u]));
  return rosters.map((r) => {
    const user = userById[r.owner_id];
    return {
      rosterId: r.roster_id,
      ownerId: r.owner_id,
      name:
        user?.metadata?.team_name ||
        user?.display_name ||
        `Team ${r.roster_id}`,
      handle: user?.display_name || null,
      avatar: user?.avatar ? avatarUrl(user.avatar, true) : null,
      wins: r.settings?.wins ?? 0,
      losses: r.settings?.losses ?? 0,
      ties: r.settings?.ties ?? 0,
      fpts:
        (r.settings?.fpts ?? 0) + (r.settings?.fpts_decimal ?? 0) / 100,
      fptsAgainst:
        (r.settings?.fpts_against ?? 0) +
        (r.settings?.fpts_against_decimal ?? 0) / 100,
      maxPf:
        (r.settings?.ppts ?? 0) + (r.settings?.ppts_decimal ?? 0) / 100,
    };
  });
}

function buildWeekly(matchupsByWeek, lastRegularWeek) {
  const weekly = [];
  Object.entries(matchupsByWeek).forEach(([weekStr, matches]) => {
    const week = Number(weekStr);
    if (week > lastRegularWeek) return;
    matches.forEach((m) => {
      const startersPoints = Array.isArray(m.starters_points)
        ? m.starters_points
        : [];
      const total =
        typeof m.points === 'number'
          ? m.points
          : startersPoints.reduce((s, n) => s + (n || 0), 0);
      const playersPoints = m.players_points || {};
      const allTotal = Object.values(playersPoints).reduce(
        (s, n) => s + (Number(n) || 0),
        0
      );
      const benchPoints = Math.max(0, allTotal - total);
      weekly.push({
        week,
        rosterId: m.roster_id,
        matchupId: m.matchup_id,
        points: round2(total),
        benchPoints: round2(benchPoints),
      });
    });
  });
  return weekly;
}

/** Weeks after the regular season through `maxWeek` (Sleeper playoff window). */
export function buildPlayoffWeekly(
  matchupsByWeek,
  lastRegularWeek,
  maxWeek = 18
) {
  const weekly = [];
  Object.entries(matchupsByWeek || {}).forEach(([weekStr, matches]) => {
    const week = Number(weekStr);
    if (week <= lastRegularWeek || week > maxWeek) return;
    matches.forEach((m) => {
      const startersPoints = Array.isArray(m.starters_points)
        ? m.starters_points
        : [];
      const total =
        typeof m.points === 'number'
          ? m.points
          : startersPoints.reduce((s, n) => s + (n || 0), 0);
      const playersPoints = m.players_points || {};
      const allTotal = Object.values(playersPoints).reduce(
        (s, n) => s + (Number(n) || 0),
        0
      );
      const benchPoints = Math.max(0, allTotal - total);
      weekly.push({
        week,
        rosterId: m.roster_id,
        matchupId: m.matchup_id,
        points: round2(total),
        benchPoints: round2(benchPoints),
      });
    });
  });
  return weekly;
}

function pairsByWeek(weekly) {
  const grouped = {};
  weekly.forEach((w) => {
    if (w.matchupId == null) return;
    const key = `${w.week}-${w.matchupId}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(w);
  });
  return Object.values(grouped).filter((pair) => pair.length === 2);
}

/** Regular-season H2H matchup pairs (two rosters, same week + matchup id). */
export function getRegularSeasonMatchupPairs(bundle) {
  const weekly = buildWeekly(bundle.matchupsByWeek, bundle.lastRegularWeek);
  const scored = weekly.filter((w) => w.points > 0);
  return pairsByWeek(scored);
}

export function getPlayoffMatchupPairs(bundle) {
  const weekly = buildPlayoffWeekly(
    bundle.matchupsByWeek,
    bundle.lastRegularWeek
  );
  const scored = weekly.filter((w) => w.points > 0);
  return pairsByWeek(scored);
}

export function round2(n) {
  return Math.round(n * 100) / 100;
}

function teamLabel(teamsByRoster, rosterId) {
  return teamsByRoster[rosterId]?.name || `Team ${rosterId}`;
}

function summarizeMatchupWeeklies(weekly, teamsByRoster) {
  const scored = weekly.filter((w) => w.points > 0);
  const sortedDesc = [...scored].sort((a, b) => b.points - a.points);
  const sortedAsc = [...scored].sort((a, b) => a.points - b.points);

  const highest = sortedDesc[0]
    ? {
        ...sortedDesc[0],
        team: teamLabel(teamsByRoster, sortedDesc[0].rosterId),
      }
    : null;
  const lowest = sortedAsc[0]
    ? {
        ...sortedAsc[0],
        team: teamLabel(teamsByRoster, sortedAsc[0].rosterId),
      }
    : null;

  const pairs = pairsByWeek(scored);
  const pairsWithDiff = pairs.map(([a, b]) => {
    const winnerSide = a.points >= b.points ? a : b;
    const loserSide = a.points >= b.points ? b : a;
    return {
      week: a.week,
      diff: round2(Math.abs(a.points - b.points)),
      winner: {
        ...winnerSide,
        team: teamLabel(teamsByRoster, winnerSide.rosterId),
      },
      loser: {
        ...loserSide,
        team: teamLabel(teamsByRoster, loserSide.rosterId),
      },
    };
  });

  const blowout = pairsWithDiff.length
    ? pairsWithDiff.reduce((m, c) => (c.diff > m.diff ? c : m))
    : null;
  const closest = pairsWithDiff.length
    ? pairsWithDiff.reduce((m, c) => (c.diff < m.diff ? c : m))
    : null;

  const perRoster = {};
  scored.forEach((w) => {
    if (!perRoster[w.rosterId]) {
      perRoster[w.rosterId] = { rosterId: w.rosterId, points: [], bench: 0 };
    }
    perRoster[w.rosterId].points.push(w.points);
    perRoster[w.rosterId].bench += w.benchPoints;
  });

  const aggregates = Object.values(perRoster).map((r) => {
    const n = r.points.length || 1;
    const mean = r.points.reduce((s, n2) => s + n2, 0) / n;
    const variance =
      r.points.reduce((s, n2) => s + (n2 - mean) ** 2, 0) / n;
    const stdev = Math.sqrt(variance);
    return {
      rosterId: r.rosterId,
      team: teamLabel(teamsByRoster, r.rosterId),
      mean: round2(mean),
      stdev: round2(stdev),
      benchTotal: round2(r.bench),
      games: n,
    };
  });

  const mostConsistent = aggregates.length
    ? [...aggregates].sort((a, b) => a.stdev - b.stdev)[0]
    : null;
  const mostVolatile = aggregates.length
    ? [...aggregates].sort((a, b) => b.stdev - a.stdev)[0]
    : null;
  const mostBenched = aggregates.length
    ? [...aggregates].sort((a, b) => b.benchTotal - a.benchTotal)[0]
    : null;
  const leastBenched = aggregates.length
    ? [...aggregates].sort((a, b) => a.benchTotal - b.benchTotal)[0]
    : null;

  return {
    highest,
    lowest,
    blowout,
    closest,
    aggregates,
    mostConsistent,
    mostVolatile,
    mostBenched,
    leastBenched,
  };
}

function computePlayoffRosterTotalsFromWeekly(playoffWeekly, teamsByRoster) {
  const scored = playoffWeekly.filter((w) => w.points > 0);
  if (!scored.length) {
    return { totalsLeader: null, fewestPoints: null, mostPointsAgainst: null };
  }
  const pf = {};
  const pa = {};
  for (const w of scored) {
    pf[w.rosterId] = (pf[w.rosterId] || 0) + w.points;
  }
  for (const [a, b] of pairsByWeek(scored)) {
    pa[a.rosterId] = (pa[a.rosterId] || 0) + b.points;
    pa[b.rosterId] = (pa[b.rosterId] || 0) + a.points;
  }
  const rows = Object.keys(pf).map((rid) => {
    const rosterId = Number(rid);
    return {
      rosterId,
      fpts: round2(pf[rosterId]),
      fptsAgainst: round2(pa[rosterId] || 0),
      name: teamLabel(teamsByRoster, rosterId),
    };
  });
  return {
    totalsLeader: [...rows].sort((a, b) => b.fpts - a.fpts)[0],
    fewestPoints: [...rows].sort((a, b) => a.fpts - b.fpts)[0],
    mostPointsAgainst: [...rows].sort((a, b) => b.fptsAgainst - a.fptsAgainst)[0],
  };
}

function bracketRowHasLoserPath(row) {
  const t1f = row.t1_from;
  const t2f = row.t2_from;
  return Boolean(
    (t1f && Object.prototype.hasOwnProperty.call(t1f, 'l')) ||
      (t2f && Object.prototype.hasOwnProperty.call(t2f, 'l'))
  );
}

/** Sleeper publishes the real champion on the league object when the season is complete. */
function championRosterIdFromLeague(league) {
  const raw = league?.metadata?.latest_league_winner_roster_id;
  if (raw == null || raw === '' || String(raw) === '0') return null;
  const id = Number(raw);
  return Number.isFinite(id) ? id : null;
}

/**
 * When metadata is missing, infer champion from bracket: prefer slot `p === 1`,
 * else the deepest winners-only round (no t*_from.l feeder).
 */
function championRosterIdFromBracket(bracket) {
  if (!Array.isArray(bracket) || bracket.length === 0) return null;

  const finished = bracket.filter((row) => {
    const w = Number(row.w);
    const t1 = Number(row.t1);
    const t2 = Number(row.t2);
    return Number.isFinite(w) && Number.isFinite(t1) && Number.isFinite(t2) && t1 !== t2;
  });
  if (!finished.length) return null;

  const primary = finished.find(
    (row) => Number(row.p) === 1 && Number.isFinite(Number(row.w))
  );
  if (primary) return Number(primary.w);

  const winnersOnly = finished.filter((row) => !bracketRowHasLoserPath(row));
  const pool = winnersOnly.length ? winnersOnly : finished;
  const maxR = Math.max(...pool.map((row) => Number(row.r) || 0));
  const top = pool.filter((row) => (Number(row.r) || 0) === maxR);
  top.sort((a, b) => Number(a.m || 0) - Number(b.m || 0));
  return top.length ? Number(top[0].w) : null;
}

/** Champion roster id for a season (metadata first, then bracket). */
export function getChampionRosterId(league, winnersBracket) {
  return (
    championRosterIdFromLeague(league) ??
    championRosterIdFromBracket(winnersBracket)
  );
}

/** Runner-up roster id from the championship slot (`p === 1`) when Sleeper sets `l`. */
export function getFinalsLoserRosterId(winnersBracket) {
  if (!Array.isArray(winnersBracket)) return null;
  const row = winnersBracket.find((r) => Number(r.p) === 1);
  if (!row) return null;
  const l = Number(row.l);
  return Number.isFinite(l) ? l : null;
}

function summarizeWinnersBracket(bracket, teamsByRoster, league) {
  if (!Array.isArray(bracket) || bracket.length === 0) {
    const fromMetaOnly = championRosterIdFromLeague(league);
    return {
      championName: fromMetaOnly
        ? teamLabel(teamsByRoster, fromMetaOnly)
        : null,
      championRosterId: fromMetaOnly ?? null,
      decisiveMatches: [],
    };
  }

  const championRosterId = getChampionRosterId(league, bracket);

  const decisive = [];
  for (const row of bracket) {
    const w = row.w != null && row.w !== '' ? Number(row.w) : NaN;
    const t1 = row.t1 != null && row.t1 !== '' ? Number(row.t1) : NaN;
    const t2 = row.t2 != null && row.t2 !== '' ? Number(row.t2) : NaN;
    const r = Number(row.r);
    const m = Number(row.m);
    if (
      !Number.isFinite(w) ||
      !Number.isFinite(t1) ||
      !Number.isFinite(t2) ||
      t1 === t2
    ) {
      continue;
    }
    const lRaw = row.l;
    const loserId = Number.isFinite(Number(lRaw))
      ? Number(lRaw)
      : w === t1
        ? t2
        : t1;
    const round = Number.isFinite(r) ? r : 0;
    const matchNum = Number.isFinite(m) ? m : 0;
    const slotP = Number.isFinite(Number(row.p)) ? Number(row.p) : null;
    const consolation = bracketRowHasLoserPath(row);
    let slotLabel = '';
    if (slotP === 1) slotLabel = 'Championship';
    else if (consolation) slotLabel = 'Placement / consolation';
    else if (slotP != null) slotLabel = `Bracket slot ${slotP}`;

    decisive.push({
      round,
      match: matchNum,
      slotP,
      slotLabel,
      consolation,
      winner: teamLabel(teamsByRoster, w),
      loser: teamLabel(teamsByRoster, loserId),
    });
  }
  decisive.sort(
    (a, b) =>
      a.round - b.round ||
      a.match - b.match ||
      a.winner.localeCompare(b.winner)
  );
  const championName =
    championRosterId != null
      ? teamLabel(teamsByRoster, championRosterId)
      : null;
  return {
    championName,
    championRosterId: championRosterId ?? null,
    decisiveMatches: decisive,
  };
}

export function computeStats(bundle) {
  const {
    league,
    users,
    rosters,
    matchupsByWeek,
    lastRegularWeek,
    winnersBracket = null,
  } = bundle;

  const teams = buildTeams(users, rosters);
  const teamsByRoster = Object.fromEntries(teams.map((t) => [t.rosterId, t]));

  const standings = [...teams].sort(
    (a, b) =>
      b.wins - a.wins ||
      a.losses - b.losses ||
      b.fpts - a.fpts
  );

  const weekly = buildWeekly(matchupsByWeek, lastRegularWeek);
  const reg = summarizeMatchupWeeklies(weekly, teamsByRoster);

  const totalsLeader = teams.length
    ? [...teams].sort((a, b) => b.fpts - a.fpts)[0]
    : null;
  const fewestPoints = teams.length
    ? [...teams].sort((a, b) => a.fpts - b.fpts)[0]
    : null;
  const mostPointsAgainst = teams.length
    ? [...teams].sort((a, b) => b.fptsAgainst - a.fptsAgainst)[0]
    : null;

  const playoffWeekly = buildPlayoffWeekly(matchupsByWeek, lastRegularWeek);
  const poWeek = summarizeMatchupWeeklies(playoffWeekly, teamsByRoster);
  const poTotals = computePlayoffRosterTotalsFromWeekly(
    playoffWeekly,
    teamsByRoster
  );
  const bracket = summarizeWinnersBracket(winnersBracket, teamsByRoster, league);
  const hasPlayoffScores = playoffWeekly.some((w) => w.points > 0);
  const playoffWeeksTracked = [
    ...new Set(playoffWeekly.map((w) => w.week)),
  ].sort((a, b) => a - b);

  return {
    league,
    teams,
    standings,
    weekly,
    highest: reg.highest,
    lowest: reg.lowest,
    blowout: reg.blowout,
    closest: reg.closest,
    aggregates: reg.aggregates,
    mostConsistent: reg.mostConsistent,
    mostVolatile: reg.mostVolatile,
    mostBenched: reg.mostBenched,
    leastBenched: reg.leastBenched,
    totalsLeader,
    fewestPoints,
    mostPointsAgainst,
    weeksTracked: Object.keys(matchupsByWeek)
      .map(Number)
      .filter((w) => w <= lastRegularWeek),
    playoff: {
      weekly: playoffWeekly,
      hasScores: hasPlayoffScores,
      hasBracket: bracket.decisiveMatches.length > 0,
      weeksTracked: playoffWeeksTracked,
      playoffWeekStart: lastRegularWeek + 1,
      highest: poWeek.highest,
      lowest: poWeek.lowest,
      blowout: poWeek.blowout,
      closest: poWeek.closest,
      aggregates: poWeek.aggregates,
      mostConsistent: poWeek.mostConsistent,
      mostVolatile: poWeek.mostVolatile,
      mostBenched: poWeek.mostBenched,
      leastBenched: poWeek.leastBenched,
      totalsLeader: poTotals.totalsLeader,
      fewestPoints: poTotals.fewestPoints,
      mostPointsAgainst: poTotals.mostPointsAgainst,
      bracket,
    },
  };
}

function formatSeasonRange(seasonSet) {
  const nums = [...seasonSet]
    .map((s) => Number(s))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);
  if (!nums.length) return '';
  if (nums.length === 1) return `${nums[0]} (1 season)`;
  return `${nums[0]}–${nums[nums.length - 1]} (${nums.length} seasons)`;
}

/**
 * Merges per-season computeStats() outputs by Sleeper user_id (roster owner).
 * seasonStats: [{ season, leagueId, name?, stats }, ...] (any order).
 */
export function computeCareerByUser(seasonStats) {
  if (!seasonStats?.length) {
    return { rows: [], seasons: [] };
  }

  const seasons = [
    ...new Set(seasonStats.map((s) => String(s.season))),
  ].sort((a, b) => Number(a) - Number(b));
  const sortedNewestFirst = [...seasonStats].sort(
    (a, b) => Number(b.season) - Number(a.season)
  );

  /** @type {Record<string, any>} */
  const byUser = {};
  // First user we see win in the newest-first walk = current reigning champion.
  let latestChampionUserId = null;

  for (const { season, stats } of sortedNewestFirst) {
    const seasonKey = String(season);
    const sNum = Number(season);
    const rosterToOwner = Object.fromEntries(
      stats.teams.map((t) => [t.rosterId, t.ownerId])
    );

    for (const t of stats.teams) {
      const uid = t.ownerId;
      if (!uid) continue;
      if (!byUser[uid]) {
        byUser[uid] = {
          userId: uid,
          displayName: t.handle || t.name,
          avatar: t.avatar,
          seasonSet: new Set(),
          wins: 0,
          losses: 0,
          ties: 0,
          championships: 0,
          careerPf: 0,
          careerPa: 0,
          gamesPlayed: 0,
          benchTotal: 0,
          bestWeek: null,
          worstWeek: null,
        };
      }
      const u = byUser[uid];
      u.seasonSet.add(seasonKey);
      u.displayName = t.handle || t.name || u.displayName;
      if (t.avatar) u.avatar = t.avatar;

      u.wins += t.wins;
      u.losses += t.losses;
      u.ties += t.ties;
      u.careerPf += t.fpts;
      u.careerPa += t.fptsAgainst;
    }

    // Tally championship for the season's bracket winner (if known).
    const champRosterId = stats.playoff?.bracket?.championRosterId;
    if (champRosterId != null) {
      const champOwnerId = rosterToOwner[champRosterId];
      if (champOwnerId && byUser[champOwnerId]) {
        byUser[champOwnerId].championships += 1;
        if (latestChampionUserId == null) latestChampionUserId = champOwnerId;
      }
    }

    for (const a of stats.aggregates) {
      const uid = rosterToOwner[a.rosterId];
      if (!uid || !byUser[uid]) continue;
      const u = byUser[uid];
      u.gamesPlayed += a.games;
      u.benchTotal += a.benchTotal;
    }

    for (const w of stats.weekly) {
      if (w.points <= 0) continue;
      const uid = rosterToOwner[w.rosterId];
      if (!uid || !byUser[uid]) continue;
      const u = byUser[uid];
      if (!u.bestWeek || w.points > u.bestWeek.points) {
        u.bestWeek = { points: w.points, season: sNum, week: w.week };
      }
      if (!u.worstWeek || w.points < u.worstWeek.points) {
        u.worstWeek = { points: w.points, season: sNum, week: w.week };
      }
    }
  }

  const rows = Object.values(byUser)
    .map((u) => {
      const avgPtsPerGame =
        u.gamesPlayed > 0 ? round2(u.careerPf / u.gamesPlayed) : 0;
      return {
        userId: u.userId,
        displayName: u.displayName,
        avatar: u.avatar,
        seasonsPlayed: u.seasonSet.size,
        seasonsLabel: formatSeasonRange(u.seasonSet),
        wins: u.wins,
        losses: u.losses,
        ties: u.ties,
        championships: u.championships,
        careerPf: round2(u.careerPf),
        careerPa: round2(u.careerPa),
        gamesPlayed: u.gamesPlayed,
        avgPtsPerGame,
        benchTotal: round2(u.benchTotal),
        bestWeek: u.bestWeek,
        worstWeek: u.worstWeek,
      };
    })
    .sort(
      (a, b) =>
        b.wins - a.wins ||
        a.losses - b.losses ||
        b.careerPf - a.careerPf
    );

  return { rows, seasons, latestChampionUserId };
}
