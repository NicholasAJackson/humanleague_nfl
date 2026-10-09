import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getChampionRosterId } from './stats.js';

describe('getChampionRosterId', () => {
  it('ignores leftover last-year metadata on an in-progress season', () => {
    const league = {
      status: 'in_season',
      metadata: { latest_league_winner_roster_id: '10' },
    };
    const bracket = [{ r: 3, m: 1, t1: 10, t2: 7, w: null, l: null, p: 1 }];
    assert.equal(getChampionRosterId(league, bracket), null);
  });

  it('does not crown a semifinal winner while the final is unfinished', () => {
    const league = {
      status: 'in_season',
      metadata: { latest_league_winner_roster_id: '10' },
    };
    const bracket = [
      { r: 1, m: 1, t1: 10, t2: 3, w: 10, l: 3 },
      { r: 2, m: 1, t1: 10, t2: 4, w: 10, l: 4 },
      { r: 3, m: 1, t1: 10, t2: 7, w: null, l: null, p: 1 },
    ];
    assert.equal(getChampionRosterId(league, bracket), null);
  });

  it('counts a finished championship even if status is still in_season', () => {
    const league = {
      status: 'in_season',
      metadata: { latest_league_winner_roster_id: '10' },
    };
    const bracket = [{ r: 3, m: 1, t1: 10, t2: 7, w: 10, l: 7, p: 1 }];
    assert.equal(getChampionRosterId(league, bracket), 10);
  });

  it('uses the championship game on a complete season', () => {
    const league = {
      status: 'complete',
      metadata: { latest_league_winner_roster_id: '10' },
    };
    const bracket = [{ r: 3, m: 1, t1: 10, t2: 7, w: 10, l: 7, p: 1 }];
    assert.equal(getChampionRosterId(league, bracket), 10);
  });

  it('falls back to metadata when a complete season has no bracket winner', () => {
    const league = {
      status: 'complete',
      metadata: { latest_league_winner_roster_id: '2' },
    };
    assert.equal(getChampionRosterId(league, []), 2);
  });
});
