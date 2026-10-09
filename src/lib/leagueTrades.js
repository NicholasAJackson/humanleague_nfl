import { analyzeTrade, playerTradeValue, TRADE_VALUE_DEFAULTS } from './tradeValue.js';

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function formatPickLabel(pick) {
  if (!pick || typeof pick !== 'object') return null;
  const season = pick.season != null ? String(pick.season) : '';
  const round = num(pick.round);
  if (!season && round == null) return null;
  const rd = round != null ? `${round}${ordinal(round)}` : 'pick';
  return season ? `${season} ${rd}` : rd;
}

function ordinal(n) {
  const v = Number(n);
  const m = v % 100;
  if (m >= 11 && m <= 13) return 'th';
  if (v % 10 === 1) return 'st';
  if (v % 10 === 2) return 'nd';
  if (v % 10 === 3) return 'rd';
  return 'th';
}

export function formatTradeWhen(tx) {
  const week = num(tx?.leg);
  const created = num(tx?.created);
  const d = created != null ? new Date(created) : null;
  const date =
    d && !Number.isNaN(d.getTime())
      ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : null;
  if (week != null && week > 0 && date) return `Week ${week} · ${date}`;
  if (week != null && week > 0) return `Week ${week}`;
  return date || 'Trade';
}

function resolvePlayer(playerId, playerById, lookup) {
  const sid = String(playerId);
  const row = playerById instanceof Map ? playerById.get(sid) : null;
  if (row) {
    return {
      sleeper_id: sid,
      name: row.name || sid,
      pos: row.pos || null,
      team: row.team || null,
      value: playerTradeValue(row),
      trend_30d: Number.isFinite(Number(row.trend_30d)) ? Number(row.trend_30d) : null,
      ecr: row.ecr ?? null,
      inMarket: true,
    };
  }
  const meta = lookup?.get?.(sid);
  return {
    sleeper_id: sid,
    name: meta?.name || `Player ${sid}`,
    pos: meta?.position || null,
    team: meta?.team || null,
    value: 0,
    trend_30d: null,
    ecr: null,
    inMarket: false,
  };
}

function ownerIdForRoster(rosterId, rosterToOwner) {
  if (!(rosterToOwner instanceof Map)) return null;
  const n = num(rosterId);
  return (
    rosterToOwner.get(n) ||
    rosterToOwner.get(String(rosterId)) ||
    rosterToOwner.get(String(n)) ||
    null
  );
}

/**
 * Split a Sleeper trade transaction into per-roster sides (players received,
 * draft picks received, FAAB received).
 */
export function parseSleeperTrade(tx, { rosterToOwner, ownerLabel, playerById, lookup } = {}) {
  const rosterIds = [...new Set((tx?.roster_ids || []).map((id) => num(id)).filter((n) => n != null))];
  const adds = tx?.adds && typeof tx.adds === 'object' ? tx.adds : {};
  const picks = Array.isArray(tx?.draft_picks) ? tx.draft_picks : [];
  const faab = Array.isArray(tx?.waiver_budget) ? tx.waiver_budget : [];

  const sides = rosterIds.map((rid) => {
    const ownerId = ownerIdForRoster(rid, rosterToOwner);
    const received = [];
    for (const [pid, toRoster] of Object.entries(adds)) {
      if (num(toRoster) !== rid) continue;
      received.push(resolvePlayer(pid, playerById, lookup));
    }
    received.sort((a, b) => playerTradeValue(b) - playerTradeValue(a));

    const receivedPicks = picks
      .filter((pk) => num(pk.owner_id) === rid)
      .map(formatPickLabel)
      .filter(Boolean);

    const receivedFaab = faab
      .filter((w) => num(w.receiver) === rid)
      .reduce((sum, w) => sum + (num(w.amount) || 0), 0);

    const label =
      (typeof ownerLabel === 'function' ? ownerLabel(ownerId, rid) : null) ||
      `Roster ${rid}`;

    return {
      rosterId: rid,
      ownerId: ownerId ? String(ownerId) : null,
      label,
      received,
      picks: receivedPicks,
      faab: receivedFaab,
    };
  });

  return {
    id: String(tx?.transaction_id || `${tx?.leg || ''}-${tx?.created}`),
    week: num(tx?.leg),
    created: num(tx?.created),
    when: formatTradeWhen(tx),
    sides,
  };
}

function extrasLabel(side) {
  const bits = [];
  if (side.picks?.length) bits.push(side.picks.join(', '));
  if (side.faab > 0) bits.push(`$${side.faab} FAAB`);
  return bits.length ? bits.join(' · ') : null;
}

/**
 * Grade a parsed 2-team trade with current FantasyCalc values (not value-at-the-time).
 */
export function gradeParsedTrade(parsed, opts = {}) {
  const conf = { packageAdjust: true, ...TRADE_VALUE_DEFAULTS, ...opts };
  const sides = parsed?.sides || [];
  if (sides.length < 2) {
    return { ...parsed, chart: null, extras: sides.map(extrasLabel), loadable: false };
  }
  const [a, b] = sides;
  const chart = analyzeTrade(a.received, b.received, conf);
  const missing = [...a.received, ...b.received].filter((p) => !p.inMarket).length;
  return {
    ...parsed,
    chart,
    extras: [extrasLabel(a), extrasLabel(b)],
    missing,
    loadable: Boolean(a.ownerId && b.ownerId && (a.received.length || b.received.length)),
  };
}

export function gradeLeagueTrades(rawTrades, ctx) {
  return (rawTrades || [])
    .map((tx) => gradeParsedTrade(parseSleeperTrade(tx, ctx)))
    .filter((t) => t.sides.length >= 2);
}
