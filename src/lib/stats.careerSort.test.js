import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareCareerRows } from './stats.js';

function row(partial) {
  return {
    userId: 'x',
    displayName: 'Zed',
    championships: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    careerPf: 0,
    careerPa: 0,
    avgPtsPerGame: 0,
    bestWeek: null,
    worstWeek: null,
    benchTotal: 0,
    seasonsPlayed: 1,
    ...partial,
  };
}

describe('compareCareerRows', () => {
  it('sorts record by wins then fewer losses (desc = standings default)', () => {
    const a = row({ displayName: 'A', wins: 12, losses: 2, careerPf: 100 });
    const b = row({ displayName: 'B', wins: 11, losses: 1, careerPf: 200 });
    assert.ok(compareCareerRows(a, b, 'record', 'desc') < 0);
    assert.ok(compareCareerRows(a, b, 'record', 'asc') > 0);
  });

  it('sorts titles descending with names as tiebreaker', () => {
    const sam = row({ displayName: 'Sam', userId: '1', championships: 1 });
    const joe = row({ displayName: 'Joe', userId: '2', championships: 0 });
    const other = row({ displayName: 'Ann', userId: '3', championships: 1 });
    assert.ok(compareCareerRows(sam, joe, 'titles', 'desc') < 0);
    assert.ok(compareCareerRows(other, sam, 'titles', 'desc') < 0);
  });

  it('sorts manager names A-Z on asc', () => {
    const sam = row({ displayName: 'Sam', userId: '1' });
    const ann = row({ displayName: 'Ann', userId: '2' });
    assert.ok(compareCareerRows(ann, sam, 'manager', 'asc') < 0);
    assert.ok(compareCareerRows(ann, sam, 'manager', 'desc') > 0);
  });

  it('keeps missing best weeks last in both directions', () => {
    const scored = row({ displayName: 'A', bestWeek: { points: 10 } });
    const missing = row({ displayName: 'B', bestWeek: null });
    assert.ok(compareCareerRows(scored, missing, 'best', 'desc') < 0);
    assert.ok(compareCareerRows(scored, missing, 'best', 'asc') < 0);
  });
});
