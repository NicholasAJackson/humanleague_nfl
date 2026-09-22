import { playerTradeValue } from './tradeValue.js';
import {
  applyTradeToRoster,
  needHoleLabels,
  normalizeDraftPos,
  optimalStarterLineup,
  positionFillsStarterNeed,
  rosterStarterNeeds,
} from './rosterNeeds.js';

const SKILL = new Set(['QB', 'RB', 'WR', 'TE', 'DST']);

/**
 * Display order: skill positions plus FLEX (RB/WR flex targets).
 * Always try to fill {@link DEFAULTS.maxPerPos} rows for each.
 */
export const WAIVER_POS_ORDER = ['QB', 'RB', 'WR', 'FLEX', 'TE', 'DST'];

const DEFAULTS = {
  /** Always list this many targets per position when the wire has enough players. */
  maxPerPos: 3,
  maxCandidates: 200,
};

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

function slotForPlayer(bySlot, playerId) {
  const sid = String(playerId);
  for (const slot of ['QB', 'RB', 'WR', 'TE', 'FLEX', 'DST']) {
    if ((bySlot?.[slot] || []).some((p) => String(p.sleeper_id) === sid)) return slot;
  }
  return null;
}

/**
 * Map a Sleeper id onto a valued player for lineup math.
 * Prefers in-season blend rows; falls back to NFL lookup with value 0.
 */
export function valuedPlayerFromSources(id, blendById, lookup) {
  const sid = String(id);
  const b = blendById instanceof Map ? blendById.get(sid) : null;
  if (b) {
    return {
      sleeper_id: sid,
      name: b.name,
      pos: normalizeDraftPos(b.pos),
      team: b.team || null,
      value: playerTradeValue(b),
      injury_status: b.injury_status || null,
      bye: b.bye ?? null,
      pts_recent: b.pts_recent ?? null,
    };
  }
  const meta = lookup?.get?.(sid);
  if (!meta) {
    return { sleeper_id: sid, name: sid, pos: '', team: null, value: 0 };
  }
  return {
    sleeper_id: sid,
    name: meta.name || sid,
    pos: normalizeDraftPos(meta.position),
    team: meta.team || null,
    value: 0,
  };
}

function scoreAdd(rosterPlayers, fa, before, needs) {
  const afterRoster = applyTradeToRoster(rosterPlayers, [fa], []);
  const after = optimalStarterLineup(afterRoster);
  const upgrade = round1(after.total - before.total);
  const slot = slotForPlayer(after.bySlot, fa.sleeper_id);
  return {
    player: fa,
    upgrade,
    slot: slot || normalizeDraftPos(fa.pos) || '—',
    fillsNeed: positionFillsStarterNeed(fa.pos, needs),
    beforeTotal: before.total,
    afterTotal: after.total,
    value: playerTradeValue(fa),
  };
}

/**
 * Top waiver targets per position for a roster.
 * Always returns up to {@link DEFAULTS.maxPerPos} free agents per skill position
 * (by in-season value), plus a FLEX bucket of top RB/WR adds ranked by lineup upgrade.
 *
 * @param {object} args
 * @param {object[]} args.rosterPlayers — valued players currently on the team
 * @param {object[]} args.freeAgents — unowned valued players
 * @returns {{ beforeTotal: number, holes: string[], upgrades: object[], byPos: Record<string, object[]> }}
 */
export function findWaiverTargets({ rosterPlayers, freeAgents, opts = {} }) {
  const conf = { ...DEFAULTS, ...opts };
  const before = optimalStarterLineup(rosterPlayers);
  const needs = rosterStarterNeeds(rosterPlayers);

  const candidates = [...(freeAgents || [])]
    .filter((p) => p && p.sleeper_id && playerTradeValue(p) > 0)
    .filter((p) => SKILL.has(normalizeDraftPos(p.pos)))
    .sort((a, b) => playerTradeValue(b) - playerTradeValue(a));

  const byPos = Object.fromEntries(WAIVER_POS_ORDER.map((pos) => [pos, []]));

  for (const pos of ['QB', 'RB', 'WR', 'TE', 'DST']) {
    const pool = candidates.filter((p) => normalizeDraftPos(p.pos) === pos).slice(0, conf.maxPerPos);
    byPos[pos] = pool.map((fa) => scoreAdd(rosterPlayers, fa, before, needs));
  }

  // FLEX targets: RB and WR only, ranked by lineup upgrade then value — always top 3.
  const flexPool = candidates.filter((p) => {
    const pos = normalizeDraftPos(p.pos);
    return pos === 'RB' || pos === 'WR';
  });
  const flexScored = flexPool
    .map((fa) => scoreAdd(rosterPlayers, fa, before, needs))
    .sort((a, b) => {
      if (b.upgrade !== a.upgrade) return b.upgrade - a.upgrade;
      return b.value - a.value;
    })
    .slice(0, conf.maxPerPos);
  byPos.FLEX = flexScored;

  const upgrades = WAIVER_POS_ORDER.flatMap((pos) => byPos[pos]);

  return {
    beforeTotal: before.total,
    holes: needHoleLabels(needs),
    upgrades,
    byPos,
  };
}

/** @deprecated Prefer {@link findWaiverTargets} — kept for older imports. */
export function findWaiverUpgrades(args) {
  return findWaiverTargets(args);
}
