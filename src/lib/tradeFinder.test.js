import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extraAtPosition, positionIsWeak, rosterStarterNeeds } from './rosterNeeds.js';
import { findTradeSuggestions } from './tradeFinder.js';

function p(id, name, pos, value) {
  return { sleeper_id: String(id), name, pos, value };
}

function youThinAtRb() {
  return [
    p(1, 'Your QB', 'QB', 50),
    p(2, 'Your RB1', 'RB', 80),
    p(3, 'Your RB2', 'RB', 40),
    p(4, 'Your WR1', 'WR', 70),
    p(5, 'Your WR2', 'WR', 65),
    p(6, 'Your WR3', 'WR', 60),
    p(7, 'Your WR4', 'WR', 55),
    p(8, 'Your TE', 'TE', 40),
    p(9, 'Your DST', 'DST', 20),
  ];
}

function partnerDeepRbThinWr() {
  return [
    p(11, 'Their QB', 'QB', 50),
    p(12, 'Their RB1', 'RB', 75),
    p(13, 'Their RB2', 'RB', 70),
    p(14, 'Their RB3', 'RB', 62),
    p(15, 'Their RB4', 'RB', 50),
    p(16, 'Their WR1', 'WR', 70),
    p(17, 'Their WR2', 'WR', 40),
    p(18, 'Their TE', 'TE', 40),
    p(19, 'Their DST', 'DST', 20),
  ];
}

function partnerThinRb() {
  return [
    p(21, 'Thin QB', 'QB', 50),
    p(22, 'Thin RB1', 'RB', 75),
    p(23, 'Thin RB2', 'RB', 70),
    p(24, 'Thin WR1', 'WR', 70),
    p(25, 'Thin WR2', 'WR', 40),
    p(26, 'Thin WR3', 'WR', 35),
    p(27, 'Thin TE', 'TE', 40),
    p(28, 'Thin DST', 'DST', 20),
  ];
}

describe('positionIsWeak / extraAtPosition', () => {
  it('treats two RBs as no extra to trade', () => {
    const needs = rosterStarterNeeds(youThinAtRb());
    assert.equal(extraAtPosition(needs, 'RB'), 0);
    assert.equal(positionIsWeak(needs, 'RB'), true);
    assert.equal(positionIsWeak(needs, 'WR'), false);
  });
});

describe('findTradeSuggestions wantPos', () => {
  const managers = [
    { id: 'you', label: 'You' },
    { id: 'deep', label: 'Deep RB' },
    { id: 'thin', label: 'Thin RB' },
  ];

  it('does not suggest RB-for-RB when looking for an RB', () => {
    const hits = findTradeSuggestions({
      focalOwnerId: 'you',
      rostersByOwner: new Map([
        ['you', youThinAtRb()],
        ['deep', partnerDeepRbThinWr()],
      ]),
      managers,
      opts: { wantPos: 'RB', maxResults: 20 },
    });
    assert.ok(hits.length > 0, 'expected at least one non-RB send');
    for (const hit of hits) {
      assert.ok(
        hit.sideAGets.some((p) => p.pos === 'RB'),
        'should receive an RB',
      );
      assert.ok(
        hit.sideBGets.every((p) => p.pos !== 'RB'),
        `should not send an RB, got ${hit.sideBGets.map((p) => p.name).join(', ')}`,
      );
    }
  });

  it('skips partners who cannot spare an RB', () => {
    const hits = findTradeSuggestions({
      focalOwnerId: 'you',
      rostersByOwner: new Map([
        ['you', youThinAtRb()],
        ['thin', partnerThinRb()],
      ]),
      managers,
      opts: { wantPos: 'RB' },
    });
    assert.equal(hits.length, 0);
  });

  it('prefers sending a position the partner is thin at', () => {
    const hits = findTradeSuggestions({
      focalOwnerId: 'you',
      rostersByOwner: new Map([
        ['you', youThinAtRb()],
        ['deep', partnerDeepRbThinWr()],
      ]),
      managers,
      opts: { wantPos: 'RB', maxResults: 20 },
    });
    assert.ok(hits.some((h) => h.sideBGets.some((p) => p.pos === 'WR')));
    assert.ok(hits.every((h) => /thin at/i.test(h.pitch)));
  });
});
