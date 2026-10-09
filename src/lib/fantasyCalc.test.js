import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FANTASYCALC_CACHE_TTL_MS,
  fantasyCalcQuery,
  fantasyCalcValuesUrl,
  normalizeFantasyCalcPlayer,
} from './fantasyCalc.js';
import { analyzeTrade } from './tradeValue.js';

describe('fantasyCalcQuery', () => {
  it('matches Human League redraft settings', () => {
    const q = fantasyCalcQuery();
    assert.equal(q.isDynasty, false);
    assert.equal(q.numQbs, '1');
    assert.equal(q.numTeams, 10);
    assert.equal(q.ppr, 0.5);
    assert.equal(q.tep, 'none');
  });

  it('builds the current-values URL', () => {
    const url = fantasyCalcValuesUrl();
    assert.ok(url.startsWith('https://api.fantasycalc.com/values/current?'));
    assert.equal(url.includes('/values/'), true);
    assert.equal(/\/values\/(?!current)/.test(url), false);
    assert.ok(url.includes('isDynasty=false'));
    assert.ok(url.includes('numQbs=1'));
    assert.ok(url.includes('numTeams=10'));
    assert.ok(url.includes('ppr=0.5'));
  });

  it('caches at least 3 hours to match FantasyCalc refresh cadence', () => {
    assert.equal(FANTASYCALC_CACHE_TTL_MS, 3 * 60 * 60 * 1000);
  });
});

describe('normalizeFantasyCalcPlayer', () => {
  it('maps sleeper id and trade value', () => {
    const p = normalizeFantasyCalcPlayer({
      value: 9499,
      overallRank: 3,
      positionRank: 3,
      trend30Day: 3066,
      player: {
        id: 1749,
        name: 'Kenneth Walker',
        position: 'RB',
        maybeTeam: 'SEA',
        sleeperId: '8151',
      },
    });
    assert.equal(p.sleeper_id, '8151');
    assert.equal(p.name, 'Kenneth Walker');
    assert.equal(p.pos, 'RB');
    assert.equal(p.value, 9499);
    assert.equal(p.ecr, 3);
    assert.equal(p.trend_30d, 3066);
  });

  it('drops picks and players without a Sleeper id', () => {
    assert.equal(
      normalizeFantasyCalcPlayer({
        value: 100,
        player: { name: '2027 1st', position: 'PICK' },
      }),
      null,
    );
    assert.equal(
      normalizeFantasyCalcPlayer({
        value: 100,
        player: { name: 'Mystery', position: 'WR' },
      }),
      null,
    );
  });
});

describe('FantasyCalc sample trade', () => {
  it('calls Walker + Olave a slight edge over Lamb + Brown', () => {
    const r = analyzeTrade(
      [
        { name: 'CeeDee Lamb', value: 8458 },
        { name: 'Chase Brown', value: 5649 },
      ],
      [
        { name: 'Chris Olave', value: 6016 },
        { name: 'Kenneth Walker', value: 9499 },
      ],
    );
    assert.equal(r.rawA, 14107);
    assert.equal(r.rawB, 15515);
    assert.equal(r.fairness.band, 'slight');
    assert.equal(r.fairness.winner, 'b');
  });
});
