import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { canAccessGuestBrowse, config } from './config.js';
import { useAuth } from './AuthContext.jsx';
import { fetchLeague } from './lib/sleeper.js';

const STORAGE_KEY = 'hl:guest-league';

const LeagueContext = createContext(null);

/** Accept a raw id or a Sleeper league URL; return digits-only id or null. */
export function normalizeLeagueIdInput(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const fromUrl = s.match(/\/leagues?\/(\d{6,})/i);
  if (fromUrl) return fromUrl[1];
  const digits = s.match(/^(\d{6,})$/);
  return digits ? digits[1] : null;
}

function readStoredGuest() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const leagueId = normalizeLeagueIdInput(parsed?.leagueId);
    if (!leagueId) return null;
    return {
      leagueId,
      leagueName: typeof parsed.leagueName === 'string' ? parsed.leagueName : null,
    };
  } catch {
    return null;
  }
}

function writeStoredGuest(guest) {
  if (!guest?.leagueId) {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      leagueId: guest.leagueId,
      leagueName: guest.leagueName || null,
    }),
  );
}

export function LeagueProvider({ children }) {
  const { ready, authenticated, devBypass, user } = useAuth();
  const [guest, setGuest] = useState(() =>
    typeof window !== 'undefined' ? readStoredGuest() : null,
  );

  const hasRealSession = Boolean(ready && authenticated && !devBypass);
  const guestBrowseAllowed = canAccessGuestBrowse(user, devBypass, { hasRealSession });

  const enterGuestLeague = useCallback(
    async (rawId) => {
      if (!canAccessGuestBrowse(user, devBypass, { hasRealSession })) {
        throw new Error('Browse another league is available to commissioners only.');
      }
      const leagueId = normalizeLeagueIdInput(rawId);
      if (!leagueId) {
        throw new Error('Enter a valid Sleeper league ID (digits only, or paste the league URL).');
      }
      const league = await fetchLeague(leagueId);
      if (!league || league.league_id == null) {
        throw new Error('That league was not found on Sleeper.');
      }
      const next = {
        leagueId: String(league.league_id),
        leagueName: typeof league.name === 'string' && league.name.trim() ? league.name.trim() : null,
      };
      writeStoredGuest(next);
      setGuest(next);
      return next;
    },
    [user, devBypass, hasRealSession],
  );

  const exitGuestLeague = useCallback(() => {
    writeStoredGuest(null);
    setGuest(null);
  }, []);

  // Drop stale guest storage for anyone who cannot use browse mode.
  useEffect(() => {
    if (!ready) return;
    if (guest && !guestBrowseAllowed) {
      writeStoredGuest(null);
      setGuest(null);
    }
  }, [ready, guest, guestBrowseAllowed]);

  const isGuest = Boolean(guest?.leagueId) && guestBrowseAllowed;
  const leagueId = isGuest ? guest.leagueId : config.leagueId;
  const guestLeagueName = isGuest ? guest.leagueName : null;

  const value = useMemo(
    () => ({
      leagueId,
      isGuest,
      /** True when browsing the configured Human League (not a pasted guest id). */
      isHumanLeague: !isGuest,
      guestLeagueName,
      guestBrowseAllowed,
      enterGuestLeague,
      exitGuestLeague,
    }),
    [leagueId, isGuest, guestLeagueName, guestBrowseAllowed, enterGuestLeague, exitGuestLeague],
  );

  return <LeagueContext.Provider value={value}>{children}</LeagueContext.Provider>;
}

export function useLeague() {
  const ctx = useContext(LeagueContext);
  if (!ctx) throw new Error('useLeague must be used within LeagueProvider');
  return ctx;
}
