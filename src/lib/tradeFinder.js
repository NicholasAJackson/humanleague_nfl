import { analyzeTrade } from './tradeValue.js';
import {
  normalizeDraftPos,
  positionFillsStarterNeed,
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
    .filter((p) => p && playerId(p) && Number.isFinite(Number(p.ecr)))
    .sort((a, b) => Number(a.ecr) - Number(b.ecr));
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

function pitchFor(impact, partnerLabel, send, receive) {
  const sendNames = send.map((p) => p.name).join(' + ');
  const recvNames = receive.map((p) => p.name).join(' + ');
  const needBits = [];
  if (impact.a.holesBefore.length) {
    const filled = impact.a.holesBefore.filter((h) => !impact.a.holesAfter.includes(h));
    if (filled.length) needBits.push(`helps your ${filled.join('/')}`);
  }
  for (const p of receive) {
    if (positionFillsStarterNeed(p.pos, impact.a.beforeNeeds)) {
      needBits.push(`adds ${normalizeDraftPos(p.pos)} starter upside`);
      break;
    }
  }
  if (impact.b.surplusBefore?.length) {
    const theirSurplus = receive.find((p) =>
      impact.b.surplusBefore.includes(normalizeDraftPos(p.pos)),
    );
    if (theirSurplus) needBits.push(`${partnerLabel} is deep at ${normalizeDraftPos(theirSurplus.pos)}`);
  }
  const why = needBits.length ? needBits.slice(0, 2).join('; ') : 'balanced ECR swap';
  return `You send ${sendNames} → get ${recvNames}. ${why}.`;
}

function evaluateCandidate(rosterA, rosterB, sideAGets, sideBGets, meta, opts) {
  const chart = analyzeTrade(sideAGets, sideBGets, { packageAdjust: opts.packageAdjust });
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
  const score = impact.mutualUpgrade + fairBonus + bothPositive + Math.min(impact.a.upgrade, impact.b.upgrade);

  return {
    partnerId: meta.partnerId,
    partnerLabel: meta.partnerLabel,
    sideAGets,
    sideBGets,
    chart,
    impact,
    score,
    pitch: pitchFor(impact, meta.partnerLabel, sideBGets, sideAGets),
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

  const rosterA = rostersByOwner.get(focal);
  const labelById = new Map((managers || []).map((m) => [String(m.id), m.label]));
  const results = [];
  const seen = new Set();

  for (const [partnerId, rosterB] of rostersByOwner.entries()) {
    if (partnerId === focal || !rosterB?.length) continue;
    const partnerLabel = labelById.get(partnerId) || partnerId;
    const sendPool = sortAssets(rosterA).slice(0, conf.topAssets);
    const recvPool = sortAssets(rosterB).slice(0, conf.topAssets);

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
      const key = [
        partnerId,
        ...pkg.sideBGets.map(playerId).sort(),
        '↔',
        ...pkg.sideAGets.map(playerId).sort(),
      ].join('|');
      if (seen.has(key)) continue;
      seen.add(key);

      // Soft positional fit: prefer receiving into a need / sending from surplus.
      const needsA = rosterStarterNeeds(rosterA);
      const surplusA = new Set(surplusPositionLabels(needsA));
      const recvHelps = pkg.sideAGets.some((p) => positionFillsStarterNeed(p.pos, needsA));
      const sendFromSurplus = pkg.sideBGets.some((p) =>
        surplusA.has(normalizeDraftPos(p.pos)),
      );
      if (!recvHelps && !sendFromSurplus && pkg.sideAGets.length + pkg.sideBGets.length > 2) {
        continue;
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
