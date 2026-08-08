import { leagueFormat } from '../config.js';
import {
  normalizeDraftPos,
  rosterStarterNeeds,
  positionFillsStarterNeed,
} from './rosterNeeds.js';

export {
  normalizeDraftPos,
  getStarterSlots,
  rosterStarterNeeds,
  positionFillsStarterNeed,
} from './rosterNeeds.js';

/** Fisher–Yates shuffle; optional `rng` for tests (`() => 0..1`). */
export function shuffleDraftSlots(userIds, rng = Math.random) {
  const a = [...userIds];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Place `fixedUserId` at `fixedSlotIndex` (0-based round-1 pick), shuffle everyone else into the remaining slots.
 */
export function shuffleDraftSlotsWithFixed(userIds, fixedUserId, fixedSlotIndex, rng = Math.random) {
  const ids = [...new Set((userIds || []).map(String).filter(Boolean))];
  const fixed = String(fixedUserId || '');
  if (!fixed || !ids.includes(fixed)) return shuffleDraftSlots(ids, rng);
  const n = ids.length;
  const slot = Math.max(0, Math.min(n - 1, Math.floor(Number(fixedSlotIndex)) || 0));
  const others = shuffleDraftSlots(
    ids.filter((id) => id !== fixed),
    rng,
  );
  const out = new Array(n);
  let oi = 0;
  for (let i = 0; i < n; i++) {
    out[i] = i === slot ? fixed : others[oi++];
  }
  return out;
}

/** Official league draft order (Sleeper display_name, round-1 pick 1 → 10). */
export const FIXED_MOCK_DRAFT_ORDER_DISPLAY_NAMES = [
  'EaglesWrexham',
  'DanTheDallasFan',
  'LennyLemon',
  'NanananaNutman',
  'JackLeeman',
  'DavieRocket',
  'GeorgiaJackson',
  'ScufDaddy1',
  'CarlNeverLose',
  'NicholasJackson7',
];

/**
 * Resolve Sleeper user_ids in `orderedNames` order (case-insensitive display_name).
 * Appends any unmatched league users at the end so the board still fills.
 */
export function resolveSlotOrderFromDisplayNames(
  users,
  orderedNames = FIXED_MOCK_DRAFT_ORDER_DISPLAY_NAMES,
) {
  const list = Array.isArray(users) ? users : [];
  const byName = new Map();
  for (const u of list) {
    const name = String(u?.display_name || '').trim().toLowerCase();
    const id = u?.user_id != null ? String(u.user_id) : '';
    if (name && id && !byName.has(name)) byName.set(name, id);
  }
  const seen = new Set();
  const out = [];
  for (const raw of orderedNames || []) {
    const id = byName.get(String(raw || '').trim().toLowerCase());
    if (id && !seen.has(id)) {
      out.push(id);
      seen.add(id);
    }
  }
  for (const u of list) {
    const id = u?.user_id != null ? String(u.user_id) : '';
    if (id && !seen.has(id)) {
      out.push(id);
      seen.add(id);
    }
  }
  return out;
}

/** Round 1 = slot index order 0..n-1; round 2 = reverse; snake thereafter. */
export function snakeRoundUserIds(slotOrderUserIds, roundNumber) {
  const n = slotOrderUserIds.length;
  if (n === 0) return [];
  const forward = roundNumber % 2 === 1;
  const out = [];
  if (forward) {
    for (let i = 0; i < n; i++) out.push(slotOrderUserIds[i]);
  } else {
    for (let i = n - 1; i >= 0; i--) out.push(slotOrderUserIds[i]);
  }
  return out;
}

export function keeperSlotsFilled(nomination) {
  if (!nomination) return 0;
  if (nomination.nomination_kind === 'freeform') {
    return [nomination.k1_text, nomination.k2_text, nomination.k3_text].filter(Boolean).length;
  }
  return [nomination.k1_player_id, nomination.k2_player_id, nomination.k3_player_id].filter(Boolean).length;
}

export function keeperPlayerIdsFromNomination(nomination) {
  if (!nomination || nomination.nomination_kind !== 'roster') return [];
  return [nomination.k1_player_id, nomination.k2_player_id, nomination.k3_player_id]
    .filter(Boolean)
    .map(String);
}

/** Sleeper ids removed from the draft pool (roster keeper nominations only). */
export function takenIdsFromKeeperNominations(nominationsByUserId) {
  const set = new Set();
  if (!nominationsByUserId) return set;
  for (const n of nominationsByUserId.values()) {
    for (const id of keeperPlayerIdsFromNomination(n)) {
      set.add(id);
    }
  }
  return set;
}

export function remainingPicksPerUser(users, nominationByUserId, targetRosterSize) {
  const m = new Map();
  for (const u of users) {
    const uid = u?.user_id;
    if (!uid) continue;
    const kept = keeperSlotsFilled(nominationByUserId.get(uid));
    m.set(uid, Math.max(0, targetRosterSize - kept));
  }
  return m;
}

/**
 * Jitter ranks so two teams sharing a source still disagree slightly.
 * Keep early-board noise tiny so ADP order stays intact for studs.
 * @param {object[]} players — share `ecr` rank field
 */
export function jitterRankingBoard(players, rng = Math.random, sigma = 0.55) {
  const list = (players || [])
    .filter((p) => p && p.sleeper_id)
    .map((p) => {
      const base = Number(p.ecr);
      const rank = Number.isFinite(base) ? base : 9999;
      // Top ~2 rounds: almost no shuffle. Mid board: light noise.
      const scale = rank <= 12 ? 0.2 : rank <= 36 ? 0.55 : 1;
      const noise = (rng() + rng() + rng() - 1.5) * (2 * sigma) * scale;
      return { ...p, ecr: Math.max(0.1, rank + noise) };
    });
  list.sort((a, b) => (a.ecr ?? 99999) - (b.ecr ?? 99999));
  return list;
}

/**
 * Assign each team a cheat sheet from available boards (FantasyPros: random expert/ADP per bot).
 * @param {string[]} userIds
 * @param {Array<{ id: string, label: string, players: object[] }>} boards
 * @returns {Map<string, { id: string, label: string, players: object[] }>}
 */
export function assignTeamCheatSheets(userIds, boards, rng = Math.random) {
  const m = new Map();
  const sources = (boards || []).filter((b) => Array.isArray(b.players) && b.players.length > 0);
  if (!userIds?.length || !sources.length) return m;

  for (const uid of userIds) {
    if (!uid) continue;
    const src = sources[Math.floor(rng() * sources.length)];
    m.set(String(uid), {
      id: src.id,
      label: src.label,
      players: jitterRankingBoard(src.players, rng),
    });
  }
  return m;
}

/**
 * Score candidates the way FP-style sims describe: board rank + need + scarcity + light noise.
 * Lower score wins. Need/scarcity are capped so they cannot yank elite ADP several rounds.
 */
export function scoreFantasyProsCandidate(player, boardRank, needs, scarcityByPos, rng = Math.random) {
  const pos = normalizeDraftPos(player.pos);
  const rank = Number.isFinite(boardRank) ? boardRank : 9999;
  let score = rank;
  let needAdj = 0;

  if (positionFillsStarterNeed(pos, needs)) {
    if (pos === 'QB' || pos === 'DST') needAdj -= 6;
    else if ((needs[pos] || 0) > 0) needAdj -= 5;
    else needAdj -= 2.5; // flex hole
  } else {
    const already = needs?.counts?.[pos] || 0;
    if (pos === 'QB' && already >= 1) needAdj += 16;
    else if (pos === 'DST' && already >= 1) needAdj += 12;
    else if (already >= 4) needAdj += 6;
    else if (already >= 3) needAdj += 3;
  }

  const scarce = scarcityByPos?.get(pos);
  if (scarce != null && scarce <= 3 && positionFillsStarterNeed(pos, needs)) {
    needAdj -= (4 - scarce) * 1.0;
  }

  // Early board = stick to ADP. Need can nudge mid/late, not rewrite studs.
  const needScale = rank <= 24 ? 0.12 : rank <= 48 ? 0.45 : 1;
  needAdj = Math.max(-4, Math.min(14, needAdj * needScale));
  score += needAdj;

  score += (rng() - 0.5) * (rank <= 24 ? 0.25 : 0.8);
  return score;
}

function scarcityAmongTop(available, topN = 24) {
  const m = new Map();
  const slice = available.slice(0, topN);
  for (const p of slice) {
    const pos = normalizeDraftPos(p.pos);
    m.set(pos, (m.get(pos) || 0) + 1);
  }
  return m;
}

/**
 * Weighted pick among the best-scored window (occasional reaches, like FP mocks).
 * Narrow window + steep decay keeps picks close to the top of the sheet.
 * @param {object[]} scored — [{ player, score }], ascending score
 */
export function weightedPickFromScored(scored, rng = Math.random, windowSize = 3) {
  if (!scored.length) return null;
  const window = scored.slice(0, Math.min(windowSize, scored.length));
  const weights = window.map((_, i) => Math.pow(0.45, i));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < window.length; i++) {
    r -= weights[i];
    if (r <= 0) return window[i].player;
  }
  return window[window.length - 1].player;
}

/**
 * FantasyPros-style autopick: team cheat sheet + roster needs + scarcity + soft random.
 *
 * @param {object} args
 * @param {object[]} args.boardPlayers — this team's ranked cheat sheet (`ecr` ascending)
 * @param {Set<string>} args.takenIds
 * @param {object[]} args.teamRoster — keepers + picks so far `{ pos }`
 * @param {() => number} [args.rng]
 */
export function pickFantasyProsStyle({
  boardPlayers,
  takenIds,
  teamRoster,
  rng = Math.random,
  starterSlots = leagueFormat.starterSlots,
  windowSize = 3,
}) {
  const counts = { QB: 0, RB: 0, WR: 0, TE: 0, DST: 0 };
  for (const p of teamRoster || []) {
    const pos = normalizeDraftPos(p.pos || p.position);
    if (counts[pos] != null) counts[pos] += 1;
  }

  const available = (boardPlayers || []).filter((p) => {
    if (!p?.sleeper_id || takenIds.has(String(p.sleeper_id))) return false;
    const pos = normalizeDraftPos(p.pos);
    // Half-PPR 1QB leagues: never draft a 3rd QB (keepers count).
    if (pos === 'QB' && counts.QB >= 2) return false;
    return true;
  });
  if (!available.length) return null;

  // Sort by board ADP first so "top available" is unambiguous.
  const byBoard = [...available].sort((a, b) => (a.ecr ?? 99999) - (b.ecr ?? 99999));
  const bpa = byBoard[0];
  const bpaRank = Number(bpa?.ecr);
  // Rounds 1–3 territory: take best ADP on the sheet. Need should not leapfrog JSN for Cook/Collins.
  if (Number.isFinite(bpaRank) && bpaRank <= 24) {
    return bpa;
  }

  const needs = rosterStarterNeeds(teamRoster, starterSlots);
  const scarcity = scarcityAmongTop(byBoard);
  const scored = byBoard.map((player, idx) => {
    const boardRank = Number.isFinite(Number(player.ecr)) ? Number(player.ecr) : idx + 1;
    return {
      player,
      score: scoreFantasyProsCandidate(player, boardRank, needs, scarcity, rng),
    };
  });
  scored.sort((a, b) => a.score - b.score);
  const win = Number.isFinite(bpaRank) && bpaRank <= 48 ? Math.min(2, windowSize) : windowSize;
  return weightedPickFromScored(scored, rng, win);
}

/**
 * @deprecated Prefer {@link pickFantasyProsStyle}. Kept for simple ADP-only fallbacks.
 * @param {'ecr' | 'owned'} strategy
 */
export function pickBestAvailable(rankingsPlayers, takenIds, strategy) {
  const candidates = (rankingsPlayers || []).filter((p) => p.sleeper_id && !takenIds.has(String(p.sleeper_id)));
  if (!candidates.length) return null;

  const ranked = [...candidates];
  if (strategy === 'owned') {
    ranked.sort((a, b) => {
      const ao = a.owned_avg;
      const bo = b.owned_avg;
      if (ao != null && bo != null && ao !== bo) return bo - ao;
      if (ao != null && bo == null) return -1;
      if (ao == null && bo != null) return 1;
      return (a.ecr ?? 99999) - (b.ecr ?? 99999);
    });
  } else {
    ranked.sort((a, b) => (a.ecr ?? 99999) - (b.ecr ?? 99999));
  }
  return ranked[0];
}

/** Map team user id → set of board rounds where keepers consume the slot (no snake pick in that row). */
export function keeperCostRoundBlocksFromPlacements(keeperCostByUserRound) {
  const m = new Map();
  if (!(keeperCostByUserRound instanceof Map)) return m;
  for (const [uid, roundMap] of keeperCostByUserRound.entries()) {
    if (!(roundMap instanceof Map) || roundMap.size === 0) continue;
    m.set(uid, new Set(roundMap.keys()));
  }
  return m;
}

/**
 * Who picks when — same traversal order as {@link simulateSnakeDraft}.
 * Skips `(round, user)` cells occupied by keeper cost so snake picks never overwrite keeper slots on the board.
 *
 * @param {Map<string, Set<number>>} [keeperCostRoundsByUserId] — rounds per team where a keeper consumes that row (no pick).
 * @returns {Array<{ round: number, userId: string, slotIndex: number }>}
 */
export function buildPickQueue(
  slotOrderUserIds,
  users,
  nominationByUserId,
  targetRosterSize = leagueFormat.draftRounds,
  keeperCostRoundsByUserId,
) {
  const queue = [];
  if (!slotOrderUserIds?.length || !users?.length) return queue;

  const remaining = remainingPicksPerUser(users, nominationByUserId, targetRosterSize);
  let totalLeft = [...remaining.values()].reduce((a, b) => a + b, 0);
  let round = 1;
  const maxRounds = Math.max(targetRosterSize * 3, 64);

  while (totalLeft > 0 && round <= maxRounds) {
    const order = snakeRoundUserIds(slotOrderUserIds, round);
    let pickedThisRound = false;
    for (const userId of order) {
      const left = remaining.get(userId) ?? 0;
      if (left <= 0) continue;
      const blocked = keeperCostRoundsByUserId?.get(userId);
      if (blocked?.has(round)) continue;
      const slotIndex = slotOrderUserIds.indexOf(userId);
      queue.push({ round, userId, slotIndex });
      remaining.set(userId, left - 1);
      totalLeft--;
      pickedThisRound = true;
    }
    if (!pickedThisRound) {
      if (totalLeft <= 0) break;
      round++;
      continue;
    }
    round++;
  }

  return queue;
}

export function draftPickRecord(meta, overallPick, player, pickKind) {
  const sid = String(player.sleeper_id);
  return {
    overallPick,
    round: meta.round,
    userId: meta.userId,
    slotIndex: meta.slotIndex,
    sleeperId: sid,
    name: player.name || sid,
    pos: player.pos || '',
    team: player.team || '',
    ecr: player.ecr ?? null,
    pickKind,
  };
}

/** Keeper ids plus drafted ids (draft picks must use `.sleeperId`). */
export function combinedTakenIds(draftPicks, nominationByUserId) {
  const taken = takenIdsFromKeeperNominations(nominationByUserId);
  for (const p of draftPicks || []) {
    if (p?.sleeperId) taken.add(String(p.sleeperId));
  }
  return taken;
}

/** Build `{ pos }` roster rows for need scoring (keepers via lookup + draft picks). */
export function teamRosterForNeeds(userId, draftPicks, nominationByUserId, lookup) {
  const out = [];
  const nom = nominationByUserId?.get(userId);
  for (const id of keeperPlayerIdsFromNomination(nom)) {
    const meta = lookup?.get(id);
    out.push({
      sleeper_id: id,
      pos: normalizeDraftPos(meta?.position || meta?.pos || ''),
      name: meta?.name || id,
    });
  }
  for (const p of draftPicks || []) {
    if (p.userId !== userId) continue;
    out.push({
      sleeper_id: p.sleeperId,
      pos: normalizeDraftPos(p.pos),
      name: p.name,
    });
  }
  return out;
}

/** Sleeper startup/snake pick map → round cost per keeper (undrafted → penalty round). */
export function buildKeeperCostRoundPlacements(
  users,
  nominationByUserId,
  draftByPlayerId,
  undraftedKeeperRound = leagueFormat.undraftedKeeperRound,
) {
  const fallback = Number(undraftedKeeperRound);
  const ud = Number.isFinite(fallback) ? fallback : leagueFormat.undraftedKeeperRound;
  const maxR = leagueFormat.draftRounds;
  const placements = new Map();

  for (const u of users || []) {
    const uid = u?.user_id;
    if (!uid) continue;
    const nom = nominationByUserId.get(uid);
    if (!nom || nom.nomination_kind !== 'roster') continue;
    const ids = keeperPlayerIdsFromNomination(nom);
    if (!ids.length) continue;

    const byRound = new Map();
    for (const pid of ids) {
      const slot = draftByPlayerId?.get(String(pid));
      const rRaw = slot?.round;
      const base = Number.isFinite(Number(rRaw)) ? Number(rRaw) : ud;
      const rr = Math.min(Math.max(1, Math.floor(base)), maxR);
      if (!byRound.has(rr)) byRound.set(rr, []);
      const arr = byRound.get(rr);
      const ps = String(pid);
      if (!arr.includes(ps)) arr.push(ps);
    }
    placements.set(uid, byRound);
  }

  return placements;
}

export function simulateSnakeDraft({
  slotOrderUserIds,
  users,
  nominationByUserId,
  rankingsPlayers,
  strategy,
  targetRosterSize = leagueFormat.draftRounds,
  keeperCostRoundsByUserId,
  teamBoards,
  lookup,
  rng = Math.random,
}) {
  const picks = [];
  if (!slotOrderUserIds?.length || !users?.length) return picks;

  const queue = buildPickQueue(
    slotOrderUserIds,
    users,
    nominationByUserId,
    targetRosterSize,
    keeperCostRoundsByUserId,
  );
  const taken = takenIdsFromKeeperNominations(nominationByUserId);
  const boards =
    teamBoards instanceof Map && teamBoards.size > 0
      ? teamBoards
      : assignTeamCheatSheets(
          slotOrderUserIds,
          [{ id: 'pool', label: 'Pool', players: rankingsPlayers || [] }],
          rng,
        );

  for (const meta of queue) {
    const sheet = boards.get(meta.userId);
    const boardPlayers = sheet?.players || rankingsPlayers || [];
    const teamRoster = teamRosterForNeeds(meta.userId, picks, nominationByUserId, lookup);
    const player =
      pickFantasyProsStyle({
        boardPlayers,
        takenIds: taken,
        teamRoster,
        rng,
      }) || pickBestAvailable(boardPlayers, taken, strategy || 'ecr');
    if (!player) break;
    const sid = String(player.sleeper_id);
    taken.add(sid);
    picks.push(draftPickRecord(meta, picks.length + 1, player, 'auto'));
  }

  return picks;
}
