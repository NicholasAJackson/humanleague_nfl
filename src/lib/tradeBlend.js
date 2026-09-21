/**
 * In-season trade blend: ROS projection (heavy) + recent scoring (modest) +
 * draft ADP that fades as completed weeks pile up.
 */

import { ecrToTradeValue, TRADE_VALUE_DEFAULTS } from './tradeValue.js';

export const TRADE_BLEND_DEFAULTS = {
  recentWeeksMax: 3,
  /** Mix at 0 completed weeks (proj vs ADP only). */
  preseason: { proj: 0.45, recent: 0, adp: 0.55 },
  /** Mix once `recentWeeksMax` weeks are in the books. */
  inSeason: { proj: 0.55, recent: 0.3, adp: 0.15 },
  adpFloor: 0.06,
  /** Extra fade applied to ADP after the in-season mix is reached. */
  adpFadeAfter: 0.9,
  /** Week counts as scored when this fraction of games are complete. */
  minCompleteFrac: 0.75,
};

function round4(n) {
  return Math.round(Number(n) * 10000) / 10000;
}

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

export function isNflGameComplete(status) {
  const s = String(status || '')
    .trim()
    .toLowerCase();
  return s === 'complete' || s === 'closed' || s === 'final' || s === 'status_final';
}

/**
 * Regular-season weeks that have enough finished games to use for scoring.
 * Stops at the first incomplete week so a stray later result cannot sneak in.
 * @param {Array<{ week?: number, status?: string }>} games
 * @param {{ minCompleteFrac?: number, maxWeek?: number }} [opts]
 * @returns {number[]}
 */
export function scoredNflWeeks(games, opts = {}) {
  const minFrac = opts.minCompleteFrac ?? TRADE_BLEND_DEFAULTS.minCompleteFrac;
  const maxWeek = opts.maxWeek ?? 18;
  const byWeek = new Map();
  for (const g of games || []) {
    const w = Number(g?.week);
    if (!Number.isFinite(w) || w < 1 || w > maxWeek) continue;
    if (!byWeek.has(w)) byWeek.set(w, { total: 0, done: 0 });
    const row = byWeek.get(w);
    row.total += 1;
    if (isNflGameComplete(g.status)) row.done += 1;
  }
  const out = [];
  for (let w = 1; w <= maxWeek; w++) {
    const row = byWeek.get(w);
    if (!row || row.total <= 0) break;
    if (row.done / row.total < minFrac) break;
    out.push(w);
  }
  return out;
}

/**
 * @param {number} completedWeeks
 * @param {Partial<typeof TRADE_BLEND_DEFAULTS>} [opts]
 * @returns {{ proj: number, recent: number, adp: number, completedWeeks: number }}
 */
export function blendWeights(completedWeeks, opts = {}) {
  const d = { ...TRADE_BLEND_DEFAULTS, ...opts };
  const n = Math.max(0, Math.floor(Number(completedWeeks) || 0));
  const ramp = Math.max(1, Number(d.recentWeeksMax) || 3);
  const t = Math.min(1, n / ramp);
  const pre = d.preseason;
  const inn = d.inSeason;

  let proj = pre.proj + (inn.proj - pre.proj) * t;
  let recent = pre.recent + (inn.recent - pre.recent) * t;
  let adp = pre.adp + (inn.adp - pre.adp) * t;

  if (n > ramp) {
    const extra = n - ramp;
    adp = Math.max(d.adpFloor, inn.adp * Math.pow(d.adpFadeAfter, extra));
    recent = inn.recent;
    proj = 1 - adp - recent;
  }

  const sum = proj + recent + adp;
  if (sum <= 0) {
    return { proj: 1, recent: 0, adp: 0, completedWeeks: n };
  }
  return {
    proj: round4(proj / sum),
    recent: round4(recent / sum),
    adp: round4(adp / sum),
    completedWeeks: n,
  };
}

/**
 * Drop empty signals and renormalize the rest to 1.
 * @param {{ proj: number, recent: number, adp: number }} weights
 * @param {{ proj?: boolean, recent?: boolean, adp?: boolean }} available
 */
export function renormalizeWeights(weights, available) {
  const proj = available?.proj ? Number(weights.proj) || 0 : 0;
  const recent = available?.recent ? Number(weights.recent) || 0 : 0;
  const adp = available?.adp ? Number(weights.adp) || 0 : 0;
  const sum = proj + recent + adp;
  if (sum <= 0) return { proj: 0, recent: 0, adp: 0 };
  return {
    proj: round4(proj / sum),
    recent: round4(recent / sum),
    adp: round4(adp / sum),
  };
}

/** Remaining Half-PPR points: full-season projection minus points already scored. */
export function rosPoints(seasonProj, ytd) {
  const proj = Number(seasonProj);
  if (!Number.isFinite(proj) || proj <= 0) return null;
  const scored = Number(ytd);
  const y = Number.isFinite(scored) && scored > 0 ? scored : 0;
  return round2(Math.max(0, proj - y));
}

export function teamWeekStatus(games, team, week) {
  const t = String(team || '')
    .trim()
    .toUpperCase();
  const w = Number(week);
  if (!t || !Number.isFinite(w)) return 'unknown';
  for (const g of games || []) {
    if (Number(g?.week) !== w) continue;
    const home = String(g.home || '')
      .trim()
      .toUpperCase();
    const away = String(g.away || '')
      .trim()
      .toUpperCase();
    if (home !== t && away !== t) continue;
    return isNflGameComplete(g.status) ? 'complete' : 'pending';
  }
  return 'bye';
}

function weekPts(weeklyStatsByWeek, playerId, week) {
  const map = weeklyStatsByWeek?.get?.(Number(week));
  if (!map) return null;
  const row = map.get(String(playerId));
  if (!row || typeof row !== 'object') return null;
  const n = Number(row.pts_half_ppr);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Average Half-PPR points per counted game in the recent window.
 * Byes and games that have not finished are skipped (not treated as zeros).
 * @returns {{ avg: number, sum: number, games: number } | null}
 */
export function recentScoring(player, weeklyStatsByWeek, recentWeeks, games) {
  const id = player?.sleeper_id != null ? String(player.sleeper_id) : '';
  const team = player?.team || (player?.pos === 'DST' ? id : '');
  if (!id || !Array.isArray(recentWeeks) || recentWeeks.length === 0) return null;

  let sum = 0;
  let n = 0;
  for (const week of recentWeeks) {
    const status = teamWeekStatus(games, team, week);
    if (status === 'bye' || status === 'pending') continue;
    const pts = weekPts(weeklyStatsByWeek, id, week);
    if (pts == null && status === 'unknown') continue;
    sum += pts == null ? 0 : pts;
    n += 1;
  }
  if (n <= 0) return null;
  return { avg: round2(sum / n), sum: round2(sum), games: n };
}

/**
 * Higher score → better (rank 1). Stable unique ranks.
 * @param {Array<{ id: string, score: number }>} entries
 * @returns {Map<string, number>}
 */
export function rankDescending(entries) {
  const ranked = [...(entries || [])]
    .filter((e) => e && e.id != null && Number.isFinite(Number(e.score)))
    .sort((a, b) => {
      const d = Number(b.score) - Number(a.score);
      if (d !== 0) return d;
      return String(a.id).localeCompare(String(b.id));
    });
  const out = new Map();
  ranked.forEach((e, i) => out.set(String(e.id), i + 1));
  return out;
}

function hasAdp(adp) {
  const n = Number(adp);
  return Number.isFinite(n) && n >= 1;
}

/**
 * Blend one player’s available ranks into a 0–100-ish trade value.
 */
export function blendPlayerValue(player, ranks, weights, opts = {}) {
  const adp = hasAdp(player?.adp) ? Number(player.adp) : null;
  const projRank = ranks?.proj?.get?.(String(player.sleeper_id)) ?? null;
  const recentRank = ranks?.recent?.get?.(String(player.sleeper_id)) ?? null;
  const used = renormalizeWeights(weights, {
    proj: projRank != null,
    recent: recentRank != null,
    adp: adp != null,
  });

  const breakdown = { proj: 0, recent: 0, adp: 0 };
  let value = 0;
  if (projRank != null && used.proj > 0) {
    breakdown.proj = ecrToTradeValue(projRank, opts);
    value += used.proj * breakdown.proj;
  }
  if (recentRank != null && used.recent > 0) {
    breakdown.recent = ecrToTradeValue(recentRank, opts);
    value += used.recent * breakdown.recent;
  }
  if (adp != null && used.adp > 0) {
    breakdown.adp = ecrToTradeValue(adp, opts);
    value += used.adp * breakdown.adp;
  }

  return {
    value: round1(value),
    weightsUsed: used,
    breakdown: {
      proj: round1(breakdown.proj),
      recent: round1(breakdown.recent),
      adp: round1(breakdown.adp),
    },
    rank_proj: projRank,
    rank_recent: recentRank,
  };
}

/**
 * Attach ROS / recent / blended value + composite rank (`ecr`) to each player.
 * @param {object[]} players
 * @param {object} ctx
 */
export function blendTradePlayers(players, ctx = {}) {
  const valueOpts = ctx.valueOpts || TRADE_VALUE_DEFAULTS;
  const games = ctx.games || [];
  const ytdById = ctx.ytdById instanceof Map ? ctx.ytdById : new Map();
  const weeklyStatsByWeek =
    ctx.weeklyStatsByWeek instanceof Map ? ctx.weeklyStatsByWeek : new Map();
  const recentWeeks = Array.isArray(ctx.recentWeeks) ? ctx.recentWeeks : [];
  const weights = ctx.weights || blendWeights(recentWeeks.length);

  const enriched = [];
  for (const raw of players || []) {
    const id = raw?.sleeper_id != null ? String(raw.sleeper_id) : '';
    if (!id) continue;
    const ytd = ytdById.get(id);
    const ptsRos = rosPoints(raw.pts_season_proj, ytd);
    const recent = recentScoring(
      { sleeper_id: id, team: raw.team, pos: raw.pos },
      weeklyStatsByWeek,
      recentWeeks,
      games,
    );
    const adp = hasAdp(raw.adp) ? Number(raw.adp) : null;
    if (ptsRos == null && recent == null && adp == null) continue;
    enriched.push({
      ...raw,
      sleeper_id: id,
      adp,
      pts_ros: ptsRos,
      pts_ytd: ytd != null && Number.isFinite(Number(ytd)) ? round2(Number(ytd)) : null,
      pts_recent: recent ? recent.avg : null,
      pts_recent_sum: recent ? recent.sum : null,
      recent_games: recent ? recent.games : 0,
    });
  }

  const projRank = rankDescending(
    enriched.filter((p) => p.pts_ros != null).map((p) => ({ id: p.sleeper_id, score: p.pts_ros })),
  );
  const recentRank = rankDescending(
    enriched
      .filter((p) => p.pts_recent != null)
      .map((p) => ({ id: p.sleeper_id, score: p.pts_recent })),
  );
  const ranks = { proj: projRank, recent: recentRank };

  const blended = enriched.map((p) => {
    const hit = blendPlayerValue(p, ranks, weights, valueOpts);
    return {
      ...p,
      value: hit.value,
      value_proj: hit.breakdown.proj,
      value_recent: hit.breakdown.recent,
      value_adp: hit.breakdown.adp,
      rank_proj: hit.rank_proj,
      rank_recent: hit.rank_recent,
      weights_used: hit.weightsUsed,
    };
  });

  blended.sort((a, b) => {
    const d = (Number(b.value) || 0) - (Number(a.value) || 0);
    if (d !== 0) return d;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });

  return blended.map((p, i) => ({
    ...p,
    ecr: i + 1,
    pts_half_ppr: p.pts_ros,
  }));
}

export function formatWeightSummary(weights, recentWeekCount) {
  if (!weights) return '';
  const pct = (n) => `${Math.round((Number(n) || 0) * 100)}%`;
  const bits = [];
  if (weights.proj > 0) bits.push(`ROS proj ${pct(weights.proj)}`);
  if (weights.recent > 0) {
    const n = Number(recentWeekCount);
    const wk = Number.isFinite(n) && n > 0 ? `${n}w` : 'recent';
    bits.push(`${wk} ${pct(weights.recent)}`);
  }
  if (weights.adp > 0) bits.push(`ADP ${pct(weights.adp)}`);
  return bits.join(' · ');
}
