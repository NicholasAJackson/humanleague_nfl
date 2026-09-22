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

/** Display / fill order for per-position waiver targets. */
export const WAIVER_POS_ORDER = ['QB', 'RB', 'WR', 'TE', 'DST'];

const DEFAULTS = {
  minUpgrade: 0.4,
  /** Max lineup-improving adds retained per skill position. */
  maxPerPos: 3,
  maxCandidates: 120,
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

/**
 * Free agents whose add would raise the optimal starter lineup.
 * Returns up to {@link DEFAULTS.maxPerPos} targets per skill position (QB/RB/WR/TE/DST).
 *
 * @param {object} args
 * @param {object[]} args.rosterPlayers — valued players currently on the team
 * @param {object[]} args.freeAgents — unowned valued players
 * @returns {{ beforeTotal: number, holes: string[], upgrades: object[], byPos: Record<string, object[]> }}
 */
export function findWaiverUpgrades({ rosterPlayers, freeAgents, opts = {} }) {
  const conf = { ...DEFAULTS, ...opts };
  const before = optimalStarterLineup(rosterPlayers);
  const needs = rosterStarterNeeds(rosterPlayers);

  const candidates = [...(freeAgents || [])]
    .filter((p) => p && p.sleeper_id && playerTradeValue(p) > 0)
    .filter((p) => SKILL.has(normalizeDraftPos(p.pos)))
    .sort((a, b) => playerTradeValue(b) - playerTradeValue(a))
    .slice(0, conf.maxCandidates);

  const hits = [];
  for (const fa of candidates) {
    const afterRoster = applyTradeToRoster(rosterPlayers, [fa], []);
    const after = optimalStarterLineup(afterRoster);
    const upgrade = round1(after.total - before.total);
    if (upgrade < conf.minUpgrade) continue;
    const slot = slotForPlayer(after.bySlot, fa.sleeper_id);
    if (!slot) continue;
    hits.push({
      player: fa,
      upgrade,
      slot,
      fillsNeed: positionFillsStarterNeed(fa.pos, needs),
      beforeTotal: before.total,
      afterTotal: after.total,
    });
  }

  hits.sort((a, b) => {
    if (a.fillsNeed !== b.fillsNeed) return a.fillsNeed ? -1 : 1;
    return b.upgrade - a.upgrade;
  });

  const byPos = Object.fromEntries(WAIVER_POS_ORDER.map((pos) => [pos, []]));
  for (const h of hits) {
    const pos = normalizeDraftPos(h.player.pos);
    if (!byPos[pos]) continue;
    if (byPos[pos].length >= conf.maxPerPos) continue;
    byPos[pos].push(h);
  }

  const upgrades = WAIVER_POS_ORDER.flatMap((pos) => byPos[pos]);

  return {
    beforeTotal: before.total,
    holes: needHoleLabels(needs),
    upgrades,
    byPos,
  };
}
