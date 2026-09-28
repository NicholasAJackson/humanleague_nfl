import { analyzeTrade, playerTradeValue } from './tradeValue.js';
import {
  extraAtPosition,
  normalizeDraftPos,
  positionFillsStarterNeed,
  positionIsWeak,
  rosterStarterNeeds,
  scoreTradeRosterImpact,
  surplusPositionLabels,
} from './rosterNeeds.js';

const DEFAULTS = {
  /** Max assets considered per side when building packages (besides locked offers). */
  topAssets: 8,
  maxResults: 16,
  /** Allow slight chart edge; reject lopsided. */
  maxFairBand: 'slight',
  /** Reject if either side's starter upgrade is worse than this. */
  minUpgrade: -3,
  /** At least one side should gain this much starter value. */
  minBestUpgrade: 0.35,
  packageAdjust: true,
  /**
   * When set (QB/RB/WR/TE/DST), only suggest deals where you receive that position.
   * Same-position swaps are skipped unless you locked an offer at that same position
   * (upgrade shop).
   */
  wantPos: null,
  /**
   * Sleeper ids that must be included in what you send (Side B gets).
   * Use when “I'm offering X” — finder adds chips around them for 2-for-1 / 3-for-1 / 2-for-2.
   */
  offerPlayerIds: null,
};

function bandRank(band) {
  if (band === 'fair') return 0;
  if (band === 'slight') return 1;
  return 2;
}

function playerId(p) {
  return p?.sleeper_id != null ? String(p.sleeper_id) : null;
}

function sortAssets(players) {
  return [...(players || [])]
    .filter((p) => p && playerId(p) && playerTradeValue(p) > 0)
    .sort((a, b) => playerTradeValue(b) - playerTradeValue(a));
}

function assetsAtPos(players, pos) {
  const want = normalizeDraftPos(pos);
  if (!want) return sortAssets(players);
  return sortAssets(players).filter((p) => normalizeDraftPos(p.pos) === want);
}

/** Combinations of `size` items from list (order-independent). */
function comboPairs(list, size) {
  if (size <= 0) return [[]];
  if (size === 1) return list.map((x) => [x]);
  if (size === 2) {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) out.push([list[i], list[j]]);
    }
    return out;
  }
  if (size === 3) {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        for (let k = j + 1; k < list.length; k++) out.push([list[i], list[j], list[k]]);
      }
    }
    return out;
  }
  return [];
}

/**
 * Package shapes: [sendCount, recvCount].
 * send = what you give (partner receives); recv = what you get.
 */
const PACKAGE_SHAPES = [
  [1, 1],
  [1, 2],
  [2, 1],
  [2, 2],
  [3, 1],
];

function pitchFor(impact, partnerLabel, send, receive, wantPos) {
  const sendNames = send.map((p) => p.name).join(' + ');
  const recvNames = receive.map((p) => p.name).join(' + ');
  const needBits = [];
  if (wantPos) {
    needBits.push(`adds the ${wantPos} you asked for`);
  }
  if (impact.a.holesBefore.length) {
    const filled = impact.a.holesBefore.filter((h) => !impact.a.holesAfter.includes(h));
    if (filled.length) needBits.push(`helps your ${filled.join('/')}`);
  }
  for (const p of receive) {
    if (positionFillsStarterNeed(p.pos, impact.a.beforeNeeds)) {
      if (!wantPos || normalizeDraftPos(p.pos) !== wantPos) {
        needBits.push(`adds ${normalizeDraftPos(p.pos)} starter upside`);
      }
      break;
    }
  }
  const sentHelp = send.filter((p) => positionIsWeak(impact.b.beforeNeeds, p.pos));
  if (sentHelp.length) {
    const pos = [...new Set(sentHelp.map((p) => normalizeDraftPos(p.pos)))].join('/');
    needBits.push(`${partnerLabel} is thin at ${pos}`);
  } else if (impact.b.surplusBefore?.length) {
    const theirSurplus = receive.find((p) =>
      impact.b.surplusBefore.includes(normalizeDraftPos(p.pos)),
    );
    if (theirSurplus) needBits.push(`${partnerLabel} is deep at ${normalizeDraftPos(theirSurplus.pos)}`);
  }
  const why = needBits.length ? needBits.slice(0, 2).join('; ') : 'balanced value swap';
  return `You send ${sendNames} → get ${recvNames}. ${why}.`;
}

function evaluateCandidate(rosterA, rosterB, sideAGets, sideBGets, meta, opts) {
  const chart = analyzeTrade(sideAGets, sideBGets, opts);
  if (bandRank(chart.fairness.band) > bandRank(opts.maxFairBand)) return null;

  const impact = scoreTradeRosterImpact(rosterA, rosterB, sideAGets, sideBGets, opts);
  if (!impact) return null;
  if (impact.a.upgrade < opts.minUpgrade || impact.b.upgrade < opts.minUpgrade) return null;
  if (Math.max(impact.a.upgrade, impact.b.upgrade) < opts.minBestUpgrade) return null;
  if (impact.mutualUpgrade < -1.5) return null;

  const fairBonus = chart.fairness.band === 'fair' ? 3 : chart.fairness.band === 'slight' ? 1 : 0;
  const bothPositive =
    (impact.a.upgrade >= 0 ? 2 : 0) + (impact.b.upgrade >= 0 ? 2 : 0);
  let score =
    impact.mutualUpgrade + fairBonus + bothPositive + Math.min(impact.a.upgrade, impact.b.upgrade);

  // Prefer simpler packages slightly (easier to propose).
  const pieces = sideAGets.length + sideBGets.length;
  score -= Math.max(0, pieces - 2) * 0.15;

  if (opts.wantPos) {
    const want = normalizeDraftPos(opts.wantPos);
    if (sideBGets.some((p) => positionIsWeak(impact.b.beforeNeeds, p.pos))) score += 2.5;
    if (extraAtPosition(impact.b.beforeNeeds, want) >= 1) score += 1.5;
    // Prefer receiving a higher-value wantPos piece.
    const bestRecv = Math.max(
      0,
      ...sideAGets
        .filter((p) => normalizeDraftPos(p.pos) === want)
        .map((p) => playerTradeValue(p)),
    );
    score += Math.min(3, bestRecv / 30);
  }

  return {
    partnerId: meta.partnerId,
    partnerLabel: meta.partnerLabel,
    sideAGets,
    sideBGets,
    chart,
    impact,
    score,
    pitch: pitchFor(impact, meta.partnerLabel, sideBGets, sideAGets, opts.wantPos),
  };
}

function normalizeOfferIds(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return [...new Set(list.map((x) => String(x)).filter(Boolean))];
}

/**
 * Suggest trades for `focalOwnerId` against every other rostered manager.
 *
 * Convention matches the analyzer: Side A = focal manager (you get `sideAGets`),
 * Side B = partner (they get `sideBGets`).
 *
 * @param {object} args
 * @param {string} args.focalOwnerId
 * @param {Map<string, object[]>} args.rostersByOwner — owner id → ranked player objects
 * @param {Array<{ id: string, label: string }>} args.managers
 * @param {Partial<typeof DEFAULTS>} [args.opts]
 */
export function findTradeSuggestions({ focalOwnerId, rostersByOwner, managers, opts = {} }) {
  const conf = { ...DEFAULTS, ...opts };
  const focal = String(focalOwnerId || '');
  if (!focal || !rostersByOwner?.get(focal)?.length) return [];

  const wantPos = conf.wantPos ? normalizeDraftPos(conf.wantPos) : null;
  const offerIds = normalizeOfferIds(conf.offerPlayerIds);
  const offerSet = new Set(offerIds);

  const rosterA = rostersByOwner.get(focal);
  const needsA = rosterStarterNeeds(rosterA);
  const surplusA = new Set(surplusPositionLabels(needsA));
  const labelById = new Map((managers || []).map((m) => [String(m.id), m.label]));

  const offeredPlayers = offerIds
    .map((id) => rosterA.find((p) => playerId(p) === id))
    .filter(Boolean);
  // Offered ids must all be on the focal roster.
  if (offerIds.length && offeredPlayers.length !== offerIds.length) return [];

  const offerIncludesWantPos =
    wantPos && offeredPlayers.some((p) => normalizeDraftPos(p.pos) === wantPos);

  const results = [];
  const seen = new Set();

  for (const [partnerId, rosterB] of rostersByOwner.entries()) {
    if (partnerId === focal || !rosterB?.length) continue;
    const partnerLabel = labelById.get(partnerId) || partnerId;
    const needsB = rosterStarterNeeds(rosterB);

    // Need something at wantPos on their roster (any valued piece — depth is a soft bonus).
    if (wantPos) {
      const theirAtPos = assetsAtPos(rosterB, wantPos);
      if (!theirAtPos.length) continue;
    }

    const sendExtras = sortAssets(rosterA)
      .filter((p) => !offerSet.has(playerId(p)))
      .filter((p) => {
        // When hunting a position and not upgrading same-pos, don't casually add wantPos sends.
        if (wantPos && !offerIncludesWantPos && normalizeDraftPos(p.pos) === wantPos) return false;
        return true;
      })
      .sort((a, b) => {
        const as = surplusA.has(normalizeDraftPos(a.pos)) ? 1 : 0;
        const bs = surplusA.has(normalizeDraftPos(b.pos)) ? 1 : 0;
        if (as !== bs) return bs - as;
        // Prefer sending something the partner is thin at.
        const aw = positionIsWeak(needsB, a.pos) ? 1 : 0;
        const bw = positionIsWeak(needsB, b.pos) ? 1 : 0;
        if (aw !== bw) return bw - aw;
        return 0;
      })
      .slice(0, conf.topAssets);

    const recvPool = (wantPos ? assetsAtPos(rosterB, wantPos) : sortAssets(rosterB)).slice(
      0,
      conf.topAssets,
    );
    if (!recvPool.length) continue;
    if (!offeredPlayers.length && !sendExtras.length) continue;

    for (const [sendCount, recvCount] of PACKAGE_SHAPES) {
      if (offeredPlayers.length > sendCount) continue;

      const extraNeeded = sendCount - offeredPlayers.length;
      const extraCombos =
        extraNeeded === 0 ? [[]] : comboPairs(sendExtras, extraNeeded);
      if (extraNeeded > 0 && !extraCombos.length) continue;

      const recvCombos = comboPairs(recvPool, recvCount);
      if (!recvCombos.length) continue;

      for (const extras of extraCombos) {
        const sideBGets = [...offeredPlayers, ...extras];
        for (const sideAGets of recvCombos) {
          if (wantPos && !sideAGets.some((p) => normalizeDraftPos(p.pos) === wantPos)) {
            continue;
          }
          // Block same-position swaps when hunting, unless the offer itself is that position.
          if (wantPos && !offerIncludesWantPos) {
            if (sideBGets.some((p) => normalizeDraftPos(p.pos) === wantPos)) continue;
          }

          const key = [
            partnerId,
            ...sideBGets.map(playerId).sort(),
            '↔',
            ...sideAGets.map(playerId).sort(),
          ].join('|');
          if (seen.has(key)) continue;
          seen.add(key);

          const hit = evaluateCandidate(rosterA, rosterB, sideAGets, sideBGets, {
            partnerId,
            partnerLabel,
          }, conf);
          if (hit) results.push(hit);
        }
      }
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, conf.maxResults);
}
