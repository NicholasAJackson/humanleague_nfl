import { leagueFormat } from '../config.js';

export const FANTASYCALC_HOME = 'https://fantasycalc.com';
export const FANTASYCALC_API = 'https://api.fantasycalc.com';
/** FantasyCalc refreshes current values about every 3 hours — do not poll faster. */
export const FANTASYCALC_CACHE_TTL_MS = 3 * 60 * 60 * 1000;
export const FANTASYCALC_STALE_TTL_MS = 24 * 60 * 60 * 1000;

const SKILL = new Set(['QB', 'RB', 'WR', 'TE']);

export function fantasyCalcQuery(opts = {}) {
  const numTeams = Number(opts.numTeams) || leagueFormat.teamCount || 10;
  const ppr = opts.ppr != null ? Number(opts.ppr) : 0.5;
  const numQbs = opts.numQbs != null ? String(opts.numQbs) : '1';
  const tep = opts.tep || 'none';
  const isDynasty = opts.isDynasty === true || opts.isDynasty === 'true';
  return {
    isDynasty,
    numQbs,
    numTeams,
    ppr,
    tep,
  };
}

/** Only endpoint we call: GET /values/current (FantasyCalc terms). */
export function fantasyCalcValuesUrl(opts = {}) {
  const q = fantasyCalcQuery(opts);
  const params = new URLSearchParams({
    isDynasty: String(q.isDynasty),
    numQbs: String(q.numQbs),
    numTeams: String(q.numTeams),
    ppr: String(q.ppr),
    tep: String(q.tep),
  });
  return `${FANTASYCALC_API}/values/current?${params}`;
}

function normalizePos(raw) {
  const p = String(raw || '')
    .trim()
    .toUpperCase();
  if (p === 'DEF') return 'DST';
  return p;
}

function toNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Map a FantasyCalc /values/current row onto the player shape the trade UI expects.
 */
export function normalizeFantasyCalcPlayer(row) {
  const player = row && row.player && typeof row.player === 'object' ? row.player : {};
  const pos = normalizePos(player.position);
  if (!SKILL.has(pos)) return null;
  const sleeperId = player.sleeperId != null ? String(player.sleeperId).trim() : '';
  if (!sleeperId) return null;
  const value = toNum(row.value);
  if (value == null || value < 0) return null;

  const overall = toNum(row.overallRank);
  const adp = toNum(row.maybeAdp);
  return {
    name: String(player.name || sleeperId).trim() || sleeperId,
    pos,
    team: player.maybeTeam ? String(player.maybeTeam).trim() : null,
    sleeper_id: sleeperId,
    fc_id: player.id != null ? String(player.id) : null,
    fp_id: null,
    value: Math.round(value * 10) / 10,
    ecr: overall != null && overall >= 1 ? overall : null,
    position_rank: toNum(row.positionRank),
    trend_30d: toNum(row.trend30Day),
    adp: adp != null && adp >= 1 ? adp : null,
    starter: Boolean(row.starter),
  };
}

export function sortFantasyCalcPlayers(players) {
  return [...(players || [])].sort((a, b) => {
    const d = (Number(b.value) || 0) - (Number(a.value) || 0);
    if (d !== 0) return d;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}
