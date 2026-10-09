import { fmtTradeDelta, playerTradeValue } from './tradeValue.js';

export const MARKET_MIN_VALUE = 400;
export const MARKET_LIMIT = 5;

export function fmtTrend30d(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return fmtTradeDelta(n);
}

export function ownerByPlayerId(rostersByOwner) {
  const ownedBy = new Map();
  if (!(rostersByOwner instanceof Map)) return ownedBy;
  for (const [oid, roster] of rostersByOwner.entries()) {
    for (const p of roster || []) {
      const id = p?.sleeper_id != null ? String(p.sleeper_id) : null;
      if (id) ownedBy.set(id, String(oid));
    }
  }
  return ownedBy;
}

function toMover(p, ownedBy, ownerLabel) {
  const id = p?.sleeper_id != null ? String(p.sleeper_id) : '';
  if (!id) return null;
  const trend = Number(p.trend_30d);
  if (!Number.isFinite(trend) || trend === 0) return null;
  const value = playerTradeValue(p);
  const ownerId = ownedBy.get(id) || null;
  const label =
    typeof ownerLabel === 'function'
      ? ownerLabel(ownerId)
      : ownerId
        ? String(ownerId)
        : 'Free agent';
  return {
    sleeper_id: id,
    name: p.name || id,
    pos: p.pos || null,
    team: p.team || null,
    value,
    trend,
    ownerId,
    ownerLabel: ownerId ? label : 'Free agent',
    player: p,
  };
}

function sortSell(a, b) {
  return b.trend - a.trend || b.value - a.value;
}

function sortBuy(a, b) {
  return a.trend - b.trend || b.value - a.value;
}

/**
 * League-wide FantasyCalc 30-day movers who are currently rostered.
 * Sell high = value up; buy low = value down.
 */
export function leagueMarketMovers({
  players,
  rostersByOwner,
  ownerLabel,
  limit = MARKET_LIMIT,
  minValue = MARKET_MIN_VALUE,
} = {}) {
  const ownedBy = ownerByPlayerId(rostersByOwner);
  const rows = (players || [])
    .map((p) => toMover(p, ownedBy, ownerLabel))
    .filter((r) => r && r.ownerId && r.value >= minValue);

  return {
    sellHigh: rows.filter((r) => r.trend > 0).sort(sortSell).slice(0, limit),
    buyLow: rows.filter((r) => r.trend < 0).sort(sortBuy).slice(0, limit),
  };
}

/**
 * Personalized: sell the risers on your roster; buy the fallen players on other teams.
 */
export function rosterMarketMovers({
  players,
  rostersByOwner,
  ownerLabel,
  focalOwnerId,
  limit = MARKET_LIMIT,
  minValue = MARKET_MIN_VALUE,
} = {}) {
  const focal = focalOwnerId != null ? String(focalOwnerId) : '';
  const ownedBy = ownerByPlayerId(rostersByOwner);
  const rows = (players || [])
    .map((p) => toMover(p, ownedBy, ownerLabel))
    .filter((r) => r && r.ownerId && r.value >= minValue);

  return {
    sellHigh: rows
      .filter((r) => r.trend > 0 && r.ownerId === focal)
      .sort(sortSell)
      .slice(0, limit),
    buyLow: rows
      .filter((r) => r.trend < 0 && r.ownerId !== focal)
      .sort(sortBuy)
      .slice(0, limit),
  };
}
