/**
 * Redraft trade values from Half-PPR ECR ranks.
 *
 * Rank → points uses a gentle exponential decay so studs outpace depth pieces
 * without needing a full VORP model. Package adjust nudges the thinner side up
 * so 3-for-1 piles of bench depth don't "win" on raw totals alone.
 */

export const TRADE_VALUE_DEFAULTS = {
  topValue: 100,
  /** Per-rank multiplicative decay (rank 1 = topValue). */
  decay: 0.985,
  /** Cap ranked pool; ranks beyond this are ~0. */
  maxRank: 250,
  /** Bonus per extra asset on the thicker side, applied to the thinner side. */
  packageBonusPerExtra: 4,
  /** Gap % thresholds vs the higher side total. */
  fairPct: 8,
  slightPct: 20,
};

/**
 * @param {number} ecr Overall ECR (1 = best)
 * @param {typeof TRADE_VALUE_DEFAULTS} [opts]
 * @returns {number}
 */
export function ecrToTradeValue(ecr, opts = {}) {
  const { topValue, decay, maxRank } = { ...TRADE_VALUE_DEFAULTS, ...opts };
  const rank = Number(ecr);
  if (!Number.isFinite(rank) || rank < 1) return 0;
  if (rank > maxRank) return 0;
  const raw = topValue * Math.pow(decay, rank - 1);
  return Math.round(raw * 10) / 10;
}

/**
 * @param {{ ecr?: number|null, value?: number|null }[]} players
 * @param {typeof TRADE_VALUE_DEFAULTS} [opts]
 */
export function sideRawTotal(players, opts = {}) {
  if (!Array.isArray(players) || players.length === 0) return 0;
  let sum = 0;
  for (const p of players) {
    if (p?.value != null && Number.isFinite(Number(p.value))) {
      sum += Number(p.value);
      continue;
    }
    sum += ecrToTradeValue(p?.ecr, opts);
  }
  return Math.round(sum * 10) / 10;
}

/**
 * Boost the side with fewer assets when package adjust is on.
 * @returns {{ a: number, b: number, bonusA: number, bonusB: number }}
 */
export function applyPackageAdjust(rawA, rawB, countA, countB, opts = {}) {
  const { packageBonusPerExtra } = { ...TRADE_VALUE_DEFAULTS, ...opts };
  let bonusA = 0;
  let bonusB = 0;
  if (countA > 0 && countB > 0 && countA !== countB) {
    const extra = Math.abs(countA - countB);
    const bonus = Math.round(packageBonusPerExtra * extra * 10) / 10;
    if (countA < countB) bonusA = bonus;
    else bonusB = bonus;
  }
  return {
    a: Math.round((rawA + bonusA) * 10) / 10,
    b: Math.round((rawB + bonusB) * 10) / 10,
    bonusA,
    bonusB,
  };
}

/**
 * @param {number} totalA
 * @param {number} totalB
 * @param {typeof TRADE_VALUE_DEFAULTS} [opts]
 * @returns {{
 *   gap: number,
 *   gapPct: number|null,
 *   winner: 'a'|'b'|'even',
 *   band: 'empty'|'fair'|'slight'|'lopsided',
 *   label: string,
 *   summary: string,
 * }}
 */
export function evaluateTradeFairness(totalA, totalB, opts = {}) {
  const { fairPct, slightPct } = { ...TRADE_VALUE_DEFAULTS, ...opts };
  const a = Number(totalA) || 0;
  const b = Number(totalB) || 0;

  if (a <= 0 && b <= 0) {
    return {
      gap: 0,
      gapPct: null,
      winner: 'even',
      band: 'empty',
      label: 'Add players',
      summary: 'Pick players on both sides to see a fairness read.',
    };
  }

  const gap = Math.round(Math.abs(a - b) * 10) / 10;
  const higher = Math.max(a, b);
  const gapPct = higher > 0 ? Math.round((gap / higher) * 1000) / 10 : 0;
  const winner = a === b ? 'even' : a > b ? 'a' : 'b';

  let band = 'lopsided';
  if (gapPct <= fairPct) band = 'fair';
  else if (gapPct <= slightPct) band = 'slight';

  const sideName = winner === 'a' ? 'Side A' : winner === 'b' ? 'Side B' : null;
  let label;
  let summary;
  if (band === 'fair') {
    label = 'Fair';
    summary =
      winner === 'even'
        ? 'Both sides line up on Half-PPR ECR value.'
        : `Close enough — ${sideName} edges it by ${gapPct}%.`;
  } else if (band === 'slight') {
    label = 'Slight edge';
    summary = `${sideName} gets more value (~${gapPct}% gap).`;
  } else {
    label = 'Lopsided';
    summary = `${sideName} wins big on ECR value (~${gapPct}% gap).`;
  }

  return { gap, gapPct, winner, band, label, summary };
}

/**
 * Full evaluation for a proposed deal.
 * @param {object[]} sideA
 * @param {object[]} sideB
 * @param {{ packageAdjust?: boolean } & Partial<typeof TRADE_VALUE_DEFAULTS>} [opts]
 */
export function analyzeTrade(sideA, sideB, opts = {}) {
  const packageAdjust = opts.packageAdjust !== false;
  const rawA = sideRawTotal(sideA, opts);
  const rawB = sideRawTotal(sideB, opts);
  const countA = Array.isArray(sideA) ? sideA.length : 0;
  const countB = Array.isArray(sideB) ? sideB.length : 0;

  const adjusted = packageAdjust
    ? applyPackageAdjust(rawA, rawB, countA, countB, opts)
    : { a: rawA, b: rawB, bonusA: 0, bonusB: 0 };

  const fairness = evaluateTradeFairness(adjusted.a, adjusted.b, opts);

  return {
    rawA,
    rawB,
    totalA: adjusted.a,
    totalB: adjusted.b,
    bonusA: adjusted.bonusA,
    bonusB: adjusted.bonusB,
    packageAdjust,
    fairness,
  };
}
