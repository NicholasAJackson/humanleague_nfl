import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findWaiverTargets, valuedPlayerFromSources } from './waiverUpgrades.js';

function p(id, name, pos, value) {
  return { sleeper_id: String(id), name, pos, value };
}

describe('findWaiverTargets', () => {
  it('always lists top 3 free agents per skill position by value', () => {
    const roster = [
      p(1, 'QB', 'QB', 50),
      p(2, 'RB1', 'RB', 80),
      p(3, 'RB2', 'RB', 70),
      p(4, 'WR1', 'WR', 70),
      p(5, 'WR2', 'WR', 65),
      p(6, 'TE', 'TE', 40),
      p(7, 'DST', 'DST', 20),
      p(8, 'FLEX WR', 'WR', 30),
      p(9, 'FLEX2 WR', 'WR', 28),
    ];
    const freeAgents = [];
    for (let i = 0; i < 5; i++) {
      freeAgents.push(p(100 + i, `RB${i}`, 'RB', 40 - i));
      freeAgents.push(p(200 + i, `WR${i}`, 'WR', 35 - i));
      freeAgents.push(p(300 + i, `QB${i}`, 'QB', 30 - i));
      freeAgents.push(p(400 + i, `TE${i}`, 'TE', 25 - i));
      freeAgents.push(p(500 + i, `DST${i}`, 'DST', 15 - i));
    }
    const { byPos } = findWaiverTargets({ rosterPlayers: roster, freeAgents });
    assert.equal(byPos.QB.length, 3);
    assert.equal(byPos.RB.length, 3);
    assert.equal(byPos.WR.length, 3);
    assert.equal(byPos.TE.length, 3);
    assert.equal(byPos.DST.length, 3);
    assert.equal(byPos.FLEX.length, 3);
    assert.equal(byPos.RB[0].player.sleeper_id, '100');
    assert.equal(byPos.RB[2].player.sleeper_id, '102');
  });

  it('FLEX bucket is RB/WR only, ranked by upgrade', () => {
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
    const freeAgents = [
      p(99, 'Wire RB', 'RB', 55),
      p(98, 'Scrub WR', 'WR', 5),
      p(97, 'Wire TE', 'TE', 80),
    ];
    const { byPos } = findWaiverTargets({ rosterPlayers: roster, freeAgents });
    assert.ok(byPos.FLEX.every((u) => u.player.pos === 'RB' || u.player.pos === 'WR'));
    assert.ok(!byPos.FLEX.some((u) => u.player.sleeper_id === '97'));
    assert.equal(byPos.FLEX[0].player.sleeper_id, '99');
  });

  it('still includes low-upgrade wire when filling top 3', () => {
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
    const { byPos } = findWaiverTargets({
      rosterPlayers: roster,
      freeAgents: [p(99, 'JAG', 'RB', 10), p(98, 'JAG2', 'RB', 9), p(97, 'JAG3', 'RB', 8)],
    });
    assert.equal(byPos.RB.length, 3);
  });
});

describe('valuedPlayerFromSources', () => {
  it('prefers blend value over lookup', () => {
    const blend = new Map([['1', { name: 'Blend', pos: 'RB', value: 44, team: 'KC' }]]);
    const lookup = new Map([['1', { name: 'Lookup', position: 'RB', team: 'KC' }]]);
    const row = valuedPlayerFromSources('1', blend, lookup);
    assert.equal(row.name, 'Blend');
    assert.equal(row.value, 44);
  });
});
