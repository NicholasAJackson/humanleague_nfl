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
  topAssets: 8,
  maxResults: 12,
  /** Allow slight chart edge; reject lopsided. */
  maxFairBand: 'slight',
  /** Reject if either side's starter upgrade is worse than this. */
  minUpgrade: -2,
  /** At least one side should gain this much starter value. */
  minBestUpgrade: 0.5,
  packageAdjust: true,
  /**
   * When set (QB/RB/WR/TE/DST), only suggest deals where you receive
   * that position from a team that can spare it — never a same-position swap.
   */
  wantPos: null,
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

function comboPairs(list, size) {
  if (size === 1) return list.map((x) => [x]);
  if (size === 2) {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) out.push([list[i], list[j]]);
    }
    return out;
  }
  return [];
}

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
  // Prefer deals that aren't pure dump-offs: mutual total should not crater.
  if (impact.mutualUpgrade < -1) return null;

  const fairBonus = chart.fairness.band === 'fair' ? 3 : chart.fairness.band === 'slight' ? 1 : 0;
  const bothPositive =
    (impact.a.upgrade >= 0 ? 2 : 0) + (impact.b.upgrade >= 0 ? 2 : 0);
  let score =
    impact.mutualUpgrade + fairBonus + bothPositive + Math.min(impact.a.upgrade, impact.b.upgrade);
  if (opts.wantPos) {
    const want = normalizeDraftPos(opts.wantPos);
    if (sideBGets.some((p) => positionIsWeak(impact.b.beforeNeeds, p.pos))) score += 2;
    if (extraAtPosition(impact.b.beforeNeeds, want) >= 1) score += 1;
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
  const rosterA = rostersByOwner.get(focal);
  const needsA = rosterStarterNeeds(rosterA);
  const surplusA = new Set(surplusPositionLabels(needsA));
  const labelById = new Map((managers || []).map((m) => [String(m.id), m.label]));
  const results = [];
  const seen = new Set();

  for (const [partnerId, rosterB] of rostersByOwner.entries()) {
    if (partnerId === focal || !rosterB?.length) continue;
    const partnerLabel = labelById.get(partnerId) || partnerId;
    const needsB = rosterStarterNeeds(rosterB);

    // Hunting a position: only talk to teams that can spare one (extra beyond starters).
    if (wantPos && extraAtPosition(needsB, wantPos) < 1) continue;

    const sendPool = sortAssets(rosterA)
      .filter((p) => !wantPos || normalizeDraftPos(p.pos) !== wantPos)
      .sort((a, b) => {
        const as = surplusA.has(normalizeDraftPos(a.pos)) ? 1 : 0;
        const bs = surplusA.has(normalizeDraftPos(b.pos)) ? 1 : 0;
        if (as !== bs) return bs - as;
        return 0;
      })
      .slice(0, conf.topAssets);
    const recvPool = (wantPos ? assetsAtPos(rosterB, wantPos) : sortAssets(rosterB)).slice(
      0,
      conf.topAssets,
    );
    if (!sendPool.length || !recvPool.length) continue;

    const packages = [
      ...comboPairs(sendPool, 1).flatMap((send) =>
        comboPairs(recvPool, 1).map((recv) => ({ sideBGets: send, sideAGets: recv })),
      ),
      ...comboPairs(sendPool, 1).flatMap((send) =>
        comboPairs(recvPool, 2).map((recv) => ({ sideBGets: send, sideAGets: recv })),
      ),
      ...comboPairs(sendPool, 2).flatMap((send) =>
        comboPairs(recvPool, 1).map((recv) => ({ sideBGets: send, sideAGets: recv })),
      ),
    ];

    for (const pkg of packages) {
      if (
        wantPos &&
        !pkg.sideAGets.some((p) => normalizeDraftPos(p.pos) === wantPos)
      ) {
        continue;
      }

      const key = [
        partnerId,
        ...pkg.sideBGets.map(playerId).sort(),
        '↔',
        ...pkg.sideAGets.map(playerId).sort(),
      ].join('|');
      if (seen.has(key)) continue;
      seen.add(key);

      if (wantPos) {
        if (pkg.sideBGets.some((p) => normalizeDraftPos(p.pos) === wantPos)) continue;
        if (!pkg.sideBGets.some((p) => positionIsWeak(needsB, p.pos))) continue;
      } else {
        // Soft positional fit: prefer receiving into a need / sending from surplus.
        const recvHelps = pkg.sideAGets.some((p) => positionFillsStarterNeed(p.pos, needsA));
        const sendFromSurplus = pkg.sideBGets.some((p) =>
          surplusA.has(normalizeDraftPos(p.pos)),
        );
        if (!recvHelps && !sendFromSurplus && pkg.sideAGets.length + pkg.sideBGets.length > 2) {
          continue;
        }
      }

      const hit = evaluateCandidate(rosterA, rosterB, pkg.sideAGets, pkg.sideBGets, {
        partnerId,
        partnerLabel,
      }, conf);
      if (hit) results.push(hit);
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, conf.maxResults);
}
