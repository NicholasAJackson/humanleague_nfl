import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findWaiverUpgrades, valuedPlayerFromSources } from './waiverUpgrades.js';

function p(id, name, pos, value) {
  return { sleeper_id: String(id), name, pos, value };
}

describe('findWaiverUpgrades', () => {
  it('lists an unowned RB who would start over a weak FLEX', () => {
    const roster = [
      p(1, 'QB', 'QB', 50),
      p(2, 'RB1', 'RB', 80),
      p(3, 'RB2', 'RB', 40),
      p(4, 'WR1', 'WR', 70),
      p(5, 'WR2', 'WR', 65),
      p(6, 'TE', 'TE', 40),
      p(7, 'DST', 'DST', 20),
      p(8, 'FLEX WR', 'WR', 30),
      p(9, 'FLEX2 WR', 'WR', 28),
    ];
    const freeAgents = [p(99, 'Wire RB', 'RB', 55), p(98, 'Scrub', 'WR', 5)];
    const { upgrades } = findWaiverUpgrades({ rosterPlayers: roster, freeAgents });
    const hit = upgrades.find((u) => u.player.sleeper_id === '99');
    assert.ok(hit && hit.upgrade > 0);
    assert.ok(!upgrades.some((u) => u.player.sleeper_id === '98'));
  });

  it('skips free agents who do not crack the starting lineup', () => {
    const roster = [
      p(1, 'QB', 'QB', 80),
      p(2, 'RB1', 'RB', 80),
      p(3, 'RB2', 'RB', 75),
      p(4, 'WR1', 'WR', 80),
      p(5, 'WR2', 'WR', 75),
      p(6, 'TE', 'TE', 70),
      p(7, 'DST', 'DST', 40),
      p(8, 'FLEX', 'WR', 70),
      p(9, 'FLEX2', 'RB', 70),
    ];
    const { upgrades } = findWaiverUpgrades({
      rosterPlayers: roster,
      freeAgents: [p(99, 'JAG', 'RB', 10)],
    });
    assert.equal(upgrades.length, 0);
  });

  it('ranks a hole-filler ahead of a larger FLEX bump', () => {
    const roster = [
      p(1, 'QB', 'QB', 50),
      p(2, 'RB1', 'RB', 80),
      p(3, 'RB2', 'RB', 70),
      p(4, 'WR1', 'WR', 70),
      p(5, 'WR2', 'WR', 65),
      p(6, 'FLEX WR', 'WR', 30),
      p(7, 'FLEX2 WR', 'WR', 28),
      p(8, 'DST', 'DST', 20),
    ];
    const { upgrades } = findWaiverUpgrades({
      rosterPlayers: roster,
      freeAgents: [p(99, 'Wire TE', 'TE', 15), p(98, 'Wire WR', 'WR', 50)],
    });
    assert.equal(upgrades[0].player.sleeper_id, '99');
    assert.equal(upgrades[0].fillsNeed, true);
    assert.ok(upgrades.some((u) => u.player.sleeper_id === '98' && u.upgrade > upgrades[0].upgrade));
  });
});

describe('valuedPlayerFromSources', () => {
  it('prefers blend value over lookup', () => {
    const blend = new Map([['1', { name: 'Blend', pos: 'RB', value: 44, team: 'KC' }]]);
    const lookup = new Map([['1', { name: 'Lookup', position: 'RB', team: 'KC' }]]);
    const p = valuedPlayerFromSources('1', blend, lookup);
    assert.equal(p.name, 'Blend');
    assert.equal(p.value, 44);
  });
});
