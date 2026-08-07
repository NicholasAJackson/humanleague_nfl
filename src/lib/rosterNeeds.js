import { leagueFormat } from '../config.js';
import { ecrToTradeValue } from './tradeValue.js';

export function normalizeDraftPos(pos) {
  const p = String(pos || '')
    .trim()
    .toUpperCase();
  if (p === 'DEF') return 'DST';
  return p;
}

/** Starter slots for need scoring — 1 QB + 2 flex, no kickers (Human League shape). */
export function getStarterSlots(slots = leagueFormat.starterSlots) {
  return {
    QB: Number(slots?.QB) || 1,
    RB: Number(slots?.RB) || 2,
    WR: Number(slots?.WR) || 2,
    TE: Number(slots?.TE) || 1,
    FLEX: Number(slots?.FLEX) || 1,
    DST: Number(slots?.DST) || 1,
  };
}

/**
 * How many starter holes remain for each position (FLEX absorbs RB/WR/TE overflow).
 * @returns {{ QB: number, RB: number, WR: number, TE: number, FLEX: number, DST: number, counts: Record<string, number> }}
 */
export function rosterStarterNeeds(rosterPlayers, starterSlots = leagueFormat.starterSlots) {
  const slots = getStarterSlots(starterSlots);
  const counts = { QB: 0, RB: 0, WR: 0, TE: 0, DST: 0 };
  for (const p of rosterPlayers || []) {
    const pos = normalizeDraftPos(p.pos || p.position);
    if (counts[pos] != null) counts[pos] += 1;
  }

  const qbNeed = Math.max(0, slots.QB - counts.QB);
  const dstNeed = Math.max(0, slots.DST - counts.DST);
  const rbOverflow = Math.max(0, counts.RB - slots.RB);
  const wrOverflow = Math.max(0, counts.WR - slots.WR);
  const teOverflow = Math.max(0, counts.TE - slots.TE);
  const flexFilled = Math.min(slots.FLEX, rbOverflow + wrOverflow + teOverflow);
  const flexNeed = Math.max(0, slots.FLEX - flexFilled);

  return {
    QB: qbNeed,
    RB: Math.max(0, slots.RB - counts.RB),
    WR: Math.max(0, slots.WR - counts.WR),
    TE: Math.max(0, slots.TE - counts.TE),
    FLEX: flexNeed,
    DST: dstNeed,
    counts,
  };
}

/** True if drafting/receiving this position still fills a starter (dedicated or FLEX). */
export function positionFillsStarterNeed(pos, needs) {
  const p = normalizeDraftPos(pos);
  if (!needs) return false;
  if (p === 'QB') return (needs.QB || 0) > 0;
  if (p === 'DST') return (needs.DST || 0) > 0;
  if (p === 'RB') return (needs.RB || 0) > 0 || (needs.FLEX || 0) > 0;
  if (p === 'WR') return (needs.WR || 0) > 0 || (needs.FLEX || 0) > 0;
  if (p === 'TE') return (needs.TE || 0) > 0 || (needs.FLEX || 0) > 0;
  return false;
}

function playerValue(p) {
  if (p?.value != null && Number.isFinite(Number(p.value))) return Number(p.value);
  return ecrToTradeValue(p?.ecr);
}

function sortByValueDesc(players) {
  return [...(players || [])].sort((a, b) => playerValue(b) - playerValue(a));
}

/**
 * Greedy ECR/value optimal starters for Human League slots.
 * @returns {{ starters: object[], total: number, bySlot: Record<string, object[]> }}
 */
export function optimalStarterLineup(rosterPlayers, starterSlots = leagueFormat.starterSlots) {
  const slots = getStarterSlots(starterSlots);
  const remaining = sortByValueDesc(rosterPlayers);
  const bySlot = { QB: [], RB: [], WR: [], TE: [], FLEX: [], DST: [] };
  const used = new Set();

  function takeFor(pos, n) {
    for (const p of remaining) {
      if (bySlot[pos].length >= n) break;
      const key = p.sleeper_id ? `s:${p.sleeper_id}` : `n:${p.name}:${p.pos}`;
      if (used.has(key)) continue;
      if (normalizeDraftPos(p.pos || p.position) !== pos) continue;
      bySlot[pos].push(p);
      used.add(key);
    }
  }

  takeFor('QB', slots.QB);
  takeFor('RB', slots.RB);
  takeFor('WR', slots.WR);
  takeFor('TE', slots.TE);
  takeFor('DST', slots.DST);

  for (const p of remaining) {
    if (bySlot.FLEX.length >= slots.FLEX) break;
    const key = p.sleeper_id ? `s:${p.sleeper_id}` : `n:${p.name}:${p.pos}`;
    if (used.has(key)) continue;
    const pos = normalizeDraftPos(p.pos || p.position);
    if (pos !== 'RB' && pos !== 'WR' && pos !== 'TE') continue;
    bySlot.FLEX.push(p);
    used.add(key);
  }

  const starters = [
    ...bySlot.QB,
    ...bySlot.RB,
    ...bySlot.WR,
    ...bySlot.TE,
    ...bySlot.FLEX,
    ...bySlot.DST,
  ];
  const total = Math.round(starters.reduce((s, p) => s + playerValue(p), 0) * 10) / 10;
  return { starters, total, bySlot };
}

/** Short labels for open starter holes, e.g. `['RB', 'FLEX']`. */
export function needHoleLabels(needs) {
  if (!needs) return [];
  const out = [];
  for (const pos of ['QB', 'RB', 'WR', 'TE', 'FLEX', 'DST']) {
    const n = needs[pos] || 0;
    if (n <= 0) continue;
    out.push(n > 1 ? `${pos}×${n}` : pos);
  }
  return out;
}

/**
 * Positions where the roster already exceeds dedicated starter slots (surplus depth).
 * FLEX-eligible overflow counts toward surplus.
 */
export function surplusPositionLabels(needs, starterSlots = leagueFormat.starterSlots) {
  if (!needs?.counts) return [];
  const slots = getStarterSlots(starterSlots);
  const out = [];
  for (const pos of ['QB', 'RB', 'WR', 'TE', 'DST']) {
    const count = needs.counts[pos] || 0;
    const dedicated = slots[pos] || 0;
    const flexShare = pos === 'RB' || pos === 'WR' || pos === 'TE' ? slots.FLEX : 0;
    if (count > dedicated + flexShare) out.push(pos);
  }
  return out;
}

/**
 * Apply a trade to one manager's roster.
 * @param {object[]} rosterPlayers
 * @param {object[]} incoming — players this manager receives
 * @param {object[]} outgoing — players this manager sends away
 */
export function applyTradeToRoster(rosterPlayers, incoming, outgoing) {
  const outIds = new Set(
    (outgoing || [])
      .map((p) => (p?.sleeper_id != null ? String(p.sleeper_id) : null))
      .filter(Boolean),
  );
  const kept = (rosterPlayers || []).filter((p) => {
    const id = p?.sleeper_id != null ? String(p.sleeper_id) : null;
    if (id && outIds.has(id)) return false;
    return true;
  });
  const have = new Set(
    kept.map((p) => (p?.sleeper_id != null ? String(p.sleeper_id) : null)).filter(Boolean),
  );
  const added = [];
  for (const p of incoming || []) {
    const id = p?.sleeper_id != null ? String(p.sleeper_id) : null;
    if (id && have.has(id)) continue;
    added.push(p);
    if (id) have.add(id);
  }
  return [...kept, ...added];
}

/**
 * Starter-value delta + need change for one manager in a trade.
 * Side A receives `sideAGets` and sends `sideBGets`.
 */
export function scoreManagerTradeImpact(rosterPlayers, sideAGets, sideBGets, opts = {}) {
  const beforeLineup = optimalStarterLineup(rosterPlayers, opts.starterSlots);
  const beforeNeeds = rosterStarterNeeds(rosterPlayers, opts.starterSlots);
  const afterRoster = applyTradeToRoster(rosterPlayers, sideAGets, sideBGets);
  const afterLineup = optimalStarterLineup(afterRoster, opts.starterSlots);
  const afterNeeds = rosterStarterNeeds(afterRoster, opts.starterSlots);
  const upgrade = Math.round((afterLineup.total - beforeLineup.total) * 10) / 10;
  return {
    beforeTotal: beforeLineup.total,
    afterTotal: afterLineup.total,
    upgrade,
    beforeNeeds,
    afterNeeds,
    holesBefore: needHoleLabels(beforeNeeds),
    holesAfter: needHoleLabels(afterNeeds),
    surplusBefore: surplusPositionLabels(beforeNeeds, opts.starterSlots),
  };
}

/**
 * Both-sides roster impact. `sideAGets` / `sideBGets` match analyzer panels.
 * Manager A receives sideAGets (gives sideBGets); B is the mirror.
 */
export function scoreTradeRosterImpact(rosterA, rosterB, sideAGets, sideBGets, opts = {}) {
  if (!rosterA || !rosterB) return null;
  const a = scoreManagerTradeImpact(rosterA, sideAGets, sideBGets, opts);
  const b = scoreManagerTradeImpact(rosterB, sideBGets, sideAGets, opts);
  return {
    a,
    b,
    mutualUpgrade: Math.round((a.upgrade + b.upgrade) * 10) / 10,
  };
}
