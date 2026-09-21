import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  blendPlayerValue,
  blendTradePlayers,
  blendWeights,
  rankDescending,
  recentScoring,
  renormalizeWeights,
  rosPoints,
  scoredNflWeeks,
} from './tradeBlend.js';

describe('blendWeights', () => {
  it('is ADP-heavy before any games', () => {
    const w = blendWeights(0);
    assert.equal(w.completedWeeks, 0);
    assert.equal(w.recent, 0);
    assert.ok(w.adp > w.proj);
    assert.ok(Math.abs(w.proj + w.recent + w.adp - 1) < 1e-6);
  });

  it('ramps to the in-season mix at 3 completed weeks', () => {
    const w = blendWeights(3);
    assert.equal(w.proj, 0.55);
    assert.equal(w.recent, 0.3);
    assert.equal(w.adp, 0.15);
  });

  it('keeps ROS heaviest at two scored weeks', () => {
    const w = blendWeights(2);
    assert.ok(w.proj > w.adp);
    assert.ok(w.proj > w.recent);
    assert.ok(w.adp > w.recent);
  });

  it('fades ADP after week 3 and gives the leftover to ROS', () => {
    const w3 = blendWeights(3);
    const w8 = blendWeights(8);
    assert.ok(w8.adp < w3.adp);
    assert.ok(w8.adp >= 0.06);
    assert.equal(w8.recent, 0.3);
    assert.ok(w8.proj > w3.proj);
  });
});

describe('renormalizeWeights', () => {
  it('drops missing recent and renormalizes', () => {
    const w = renormalizeWeights({ proj: 0.5, recent: 0.3, adp: 0.2 }, {
      proj: true,
      recent: false,
      adp: true,
    });
    assert.equal(w.recent, 0);
    assert.ok(Math.abs(w.proj + w.adp - 1) < 1e-6);
    assert.ok(w.proj > w.adp);
  });
});

describe('rosPoints', () => {
  it('subtracts YTD from the full-season projection', () => {
    assert.equal(rosPoints(361.5, 76.48), 285.02);
  });

  it('floors at zero when a player is already ahead of the projection', () => {
    assert.equal(rosPoints(20, 40), 0);
  });

  it('returns null without a projection', () => {
    assert.equal(rosPoints(null, 12), null);
  });
});

describe('scoredNflWeeks', () => {
  it('stops at the first incomplete week', () => {
    const games = [
      ...Array.from({ length: 16 }, (_, i) => ({ week: 1, status: 'complete', home: `H${i}`, away: `A${i}` })),
      ...Array.from({ length: 15 }, (_, i) => ({ week: 2, status: 'complete', home: `H${i}`, away: `A${i}` })),
      { week: 2, status: 'pre_game', home: 'ARI', away: 'SEA' },
      ...Array.from({ length: 16 }, (_, i) => ({ week: 3, status: 'pre_game', home: `H${i}`, away: `A${i}` })),
    ];
    assert.deepEqual(scoredNflWeeks(games), [1, 2]);
  });
});

describe('recentScoring', () => {
  it('skips byes and unfinished games', () => {
    const weekly = new Map([
      [1, new Map([['1', { pts_half_ppr: 20 }]])],
      [2, new Map([['1', { pts_half_ppr: 0 }]])],
    ]);
    const games = [
      { week: 1, status: 'complete', home: 'KC', away: 'BAL' },
      { week: 2, status: 'pre_game', home: 'KC', away: 'NYG' },
    ];
    const hit = recentScoring({ sleeper_id: '1', team: 'KC' }, weekly, [1, 2], games);
    assert.equal(hit.games, 1);
    assert.equal(hit.avg, 20);
  });
});

describe('rankDescending', () => {
  it('gives rank 1 to the highest score', () => {
    const ranks = rankDescending([
      { id: 'a', score: 10 },
      { id: 'b', score: 30 },
      { id: 'c', score: 20 },
    ]);
    assert.equal(ranks.get('b'), 1);
    assert.equal(ranks.get('c'), 2);
    assert.equal(ranks.get('a'), 3);
  });
});

describe('blendPlayerValue / blendTradePlayers', () => {
  it('prefers the player who is better on the heavy ROS signal', () => {
    const weights = blendWeights(3);
    const ranks = {
      proj: new Map([
        ['star', 1],
        ['depth', 40],
      ]),
      recent: new Map([
        ['star', 5],
        ['depth', 5],
      ]),
    };
    const star = blendPlayerValue({ sleeper_id: 'star', adp: 20 }, ranks, weights);
    const depth = blendPlayerValue({ sleeper_id: 'depth', adp: 20 }, ranks, weights);
    assert.ok(star.value > depth.value);
  });

  it('assigns composite rank 1 to the highest blended value', () => {
    const players = [
      { sleeper_id: '10', name: 'Alpha', pos: 'RB', team: 'KC', adp: 8, pts_season_proj: 280 },
      { sleeper_id: '20', name: 'Beta', pos: 'RB', team: 'BUF', adp: 40, pts_season_proj: 140 },
    ];
    const ytdById = new Map([
      ['10', 40],
      ['20', 10],
    ]);
    const weeklyStatsByWeek = new Map([
      [
        1,
        new Map([
          ['10', { pts_half_ppr: 22 }],
          ['20', { pts_half_ppr: 8 }],
        ]),
      ],
    ]);
    const games = [{ week: 1, status: 'complete', home: 'KC', away: 'BUF' }];
    const out = blendTradePlayers(players, {
      ytdById,
      weeklyStatsByWeek,
      recentWeeks: [1],
      games,
      weights: blendWeights(1),
    });
    assert.equal(out[0].sleeper_id, '10');
    assert.equal(out[0].ecr, 1);
    assert.ok(out[0].value > out[1].value);
    assert.ok(out[0].pts_ros > out[1].pts_ros);
  });
});
