import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GUEST_BROWSE_LEAGUES, isAllowedGuestLeagueId } from '../config.js';

describe('GUEST_BROWSE_LEAGUES', () => {
  it('lists named leagues with Sleeper ids', () => {
    assert.ok(GUEST_BROWSE_LEAGUES.length > 0);
    for (const league of GUEST_BROWSE_LEAGUES) {
      assert.ok(league.name);
      assert.match(String(league.id), /^\d{6,}$/);
      assert.equal(isAllowedGuestLeagueId(league.id), true);
    }
  });

  it('includes The Blakeless League', () => {
    assert.ok(
      GUEST_BROWSE_LEAGUES.some(
        (l) => l.id === '1389574148908384256' && l.name === 'The Blakeless League',
      ),
    );
  });

  it('rejects unknown leagues', () => {
    assert.equal(isAllowedGuestLeagueId('999999999999999999'), false);
    assert.equal(isAllowedGuestLeagueId(''), false);
    assert.equal(isAllowedGuestLeagueId('not-an-id'), false);
  });
});
