import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { leagueMarketMovers, rosterMarketMovers } from './tradeMarket.js';

function p(id, name, value, trend) {
  return { sleeper_id: String(id), name, pos: 'RB', value, trend_30d: trend };
}

describe('leagueMarketMovers', () => {
  it('ranks rostered risers and fallers by FantasyCalc 30d trend', () => {
    const players = [
      p(1, 'Riser', 2000, 800),
      p(2, 'Faller', 1800, -900),
      p(3, 'FA riser', 1500, 1200),
      p(4, 'Cheap', 50, 2000),
    ];
    const rostersByOwner = new Map([
      ['you', [players[0]]],
      ['them', [players[1]]],
    ]);
    const { sellHigh, buyLow } = leagueMarketMovers({
      players,
      rostersByOwner,
      ownerLabel: (id) => (id === 'you' ? 'You' : 'Them'),
    });
    assert.equal(sellHigh[0].name, 'Riser');
    assert.equal(sellHigh[0].ownerLabel, 'You');
    assert.equal(buyLow[0].name, 'Faller');
    assert.ok(!sellHigh.some((r) => r.name === 'FA riser'));
    assert.ok(!sellHigh.some((r) => r.name === 'Cheap'));
  });
});

describe('rosterMarketMovers', () => {
  it('sells your risers and buys other teams fallers', () => {
    const yours = p(1, 'Your star', 2000, 500);
    const theirs = p(2, 'Their dump', 1500, -700);
    const alsoYours = p(3, 'Your dump', 1600, -400);
    const players = [yours, theirs, alsoYours];
    const rostersByOwner = new Map([
      ['you', [yours, alsoYours]],
      ['them', [theirs]],
    ]);
    const { sellHigh, buyLow } = rosterMarketMovers({
      players,
      rostersByOwner,
      focalOwnerId: 'you',
      ownerLabel: (id) => id,
    });
    assert.deepEqual(
      sellHigh.map((r) => r.name),
      ['Your star'],
    );
    assert.deepEqual(
      buyLow.map((r) => r.name),
      ['Their dump'],
    );
  });
});
