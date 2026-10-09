import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gradeLeagueTrades, parseSleeperTrade, formatPickLabel } from './leagueTrades.js';

const TX = {
  transaction_id: 't1',
  type: 'trade',
  status: 'complete',
  roster_ids: [7, 10],
  adds: { 7543: 7, 11584: 10, 12474: 7, 13305: 10 },
  drops: { 7543: 10, 11584: 7, 12474: 10, 13305: 7 },
  draft_picks: [],
  waiver_budget: [],
  created: 1788874158562,
  leg: 1,
};

describe('parseSleeperTrade', () => {
  it('splits received players by roster', () => {
    const rosterToOwner = new Map([
      [7, 'u7'],
      [10, 'u10'],
    ]);
    const playerById = new Map([
      ['7543', { sleeper_id: '7543', name: 'A', value: 1000 }],
      ['12474', { sleeper_id: '12474', name: 'B', value: 400 }],
      ['11584', { sleeper_id: '11584', name: 'C', value: 900 }],
      ['13305', { sleeper_id: '13305', name: 'D', value: 200 }],
    ]);
    const parsed = parseSleeperTrade(TX, {
      rosterToOwner,
      ownerLabel: (id) => (id === 'u7' ? 'Ken' : 'Sam'),
      playerById,
    });
    assert.equal(parsed.sides.length, 2);
    assert.equal(parsed.when.startsWith('Week 1'), true);
    const ken = parsed.sides.find((s) => s.ownerId === 'u7');
    const sam = parsed.sides.find((s) => s.ownerId === 'u10');
    assert.deepEqual(
      ken.received.map((p) => p.name).sort(),
      ['A', 'B'],
    );
    assert.deepEqual(
      sam.received.map((p) => p.name).sort(),
      ['C', 'D'],
    );
  });
});

describe('gradeLeagueTrades', () => {
  it('grades two-team trades with current values', () => {
    const rosterToOwner = new Map([
      [7, 'u7'],
      [10, 'u10'],
    ]);
    const playerById = new Map([
      ['7543', { sleeper_id: '7543', name: 'A', value: 2000 }],
      ['12474', { sleeper_id: '12474', name: 'B', value: 2000 }],
      ['11584', { sleeper_id: '11584', name: 'C', value: 100 }],
      ['13305', { sleeper_id: '13305', name: 'D', value: 100 }],
    ]);
    const [row] = gradeLeagueTrades([TX], { rosterToOwner, playerById, ownerLabel: () => 'X' });
    assert.ok(row.chart);
    assert.equal(row.chart.fairness.winner, 'a');
    assert.equal(row.loadable, true);
  });
});

describe('formatPickLabel', () => {
  it('formats a future pick', () => {
    assert.equal(formatPickLabel({ season: '2027', round: 2 }), '2027 2nd');
  });
});
