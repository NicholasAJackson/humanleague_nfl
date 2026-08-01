import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../AuthContext.jsx';
import { areKeeperNominationsHiddenInUi, config, leagueFormat } from '../config.js';
import { buildDevMockKeeperNominations } from '../lib/devMockKeeperNominations.js';
import { findLatestSeasonWithSnakePicks, buildDraftSlotByPlayerId } from '../lib/drafts.js';
import {
  shuffleDraftSlots,
  simulateSnakeDraft,
  buildPickQueue,
  draftPickRecord,
  combinedTakenIds,
  pickBestAvailable,
  buildKeeperCostRoundPlacements,
  keeperCostRoundBlocksFromPlacements,
} from '../lib/mockDraftEngine.js';
import { resolveLeagueHistoryChain, fetchUsers, fetchRosters, getNflPlayersLookup } from '../lib/sleeper.js';
import './MockDraft.css';

const useDevKeeperMocks = import.meta.env.DEV;

const POSITION_FILTERS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'DST'];

const DEFAULT_PICK_SECONDS = 90;

function formatRevealLabel(isoRaw) {
  const ts = Date.parse(isoRaw);
  if (!Number.isFinite(ts)) return isoRaw;
  return new Date(ts).toLocaleString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function fmtNominationRow(n, lookup) {
  if (n.nomination_kind === 'freeform') {
    return [n.k1_text, n.k2_text, n.k3_text].filter(Boolean).join(' · ');
  }
  const ids = [n.k1_player_id, n.k2_player_id, n.k3_player_id].filter(Boolean);
  if (!lookup) return ids.join(' · ');
  return ids
    .map((id) => {
      const x = lookup.get(id);
      return x ? `${x.name} (${x.position || '?'})` : id;
    })
    .join(' · ');
}

/** Map a locked-in keeper_finals row → nomination shape the mock engine already understands (k1 + second only). */
function finalToMockNomination(final) {
  if (!final?.sleeper_user_id) return null;
  const hasIds = Boolean(final.k1_player_id || final.second_player_id);
  if (hasIds) {
    return {
      sleeper_user_id: String(final.sleeper_user_id),
      nomination_kind: 'roster',
      k1_player_id: final.k1_player_id || null,
      k2_player_id: final.second_player_id || null,
      k3_player_id: null,
      k1_text: null,
      k2_text: null,
      k3_text: null,
      source_season: final.source_season != null ? String(final.source_season) : null,
      carry_into_season: final.carry_into_season != null ? String(final.carry_into_season) : null,
    };
  }
  if (!final.k1_text && !final.second_text) return null;
  return {
    sleeper_user_id: String(final.sleeper_user_id),
    nomination_kind: 'freeform',
    k1_player_id: null,
    k2_player_id: null,
    k3_player_id: null,
    k1_text: final.k1_text || null,
    k2_text: final.second_text || null,
    k3_text: null,
    source_season: final.source_season != null ? String(final.source_season) : null,
    carry_into_season: final.carry_into_season != null ? String(final.carry_into_season) : null,
  };
}

function formatScrapeDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function pickCellForRoundTeam(draftPicks, round, teamUserId) {
  return draftPicks.find((p) => p.round === round && p.userId === teamUserId) || null;
}

function fmtKeeperCostPlayer(pid, lookup) {
  const x = lookup?.get(pid);
  return x ? `${x.name} (${x.position || '?'})` : pid;
}

function fmtClock(seconds) {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

/** Positive if nomination a should win over b (higher source_season, then newer updated_at). */
function compareNominationRecency(a, b) {
  const sa = Number(a.source_season);
  const sb = Number(b.source_season);
  const na = Number.isFinite(sa) ? sa : Number.NEGATIVE_INFINITY;
  const nb = Number.isFinite(sb) ? sb : Number.NEGATIVE_INFINITY;
  if (na !== nb) return na - nb;
  const ta = Date.parse(a.updated_at || a.submitted_at || 0) || 0;
  const tb = Date.parse(b.updated_at || b.submitted_at || 0) || 0;
  return ta - tb;
}

/** One nomination per sleeper_user_id — keeps the most recent by season then timestamp. */
function pickLatestNominationPerUser(rows) {
  const byUser = new Map();
  for (const n of rows) {
    const uid = n.sleeper_user_id;
    if (!uid) continue;
    const prev = byUser.get(uid);
    if (!prev || compareNominationRecency(n, prev) > 0) byUser.set(uid, n);
  }
  return [...byUser.values()];
}

/** Shared draft grid (snake rounds × teams), with optional caption copy. */
function MockDraftBoardPanel({
  slotOrderUserIds,
  boardMaxRound,
  draftPicks,
  keeperCostByUserRound,
  lookup,
  timedDraftActive,
  currentPickMeta,
  pickCursor,
  pickQueueLength,
  labelByUserId,
  keeperCostDraft,
  compact,
  omitHeading = false,
}) {
  const showCaptions = !compact;
  const showHeading = !omitHeading;
  return (
    <div className={'mock-draft-board-wrap' + (compact ? ' mock-draft-board-wrap--compact' : '')}>
      {showHeading && !compact && <h3 className="mock-draft-board-title">Draft board</h3>}
      {showHeading && compact && <h3 className="mock-draft-board-title mock-draft-board-title--compact">Board</h3>}
      {showCaptions && keeperCostDraft.status === 'loading' && (
        <p className="muted mock-draft-board-caption">Loading startup draft rounds for keeper costs…</p>
      )}
      {showCaptions && keeperCostDraft.status === 'ready' && keeperCostDraft.sourceSeason && (
        <p className="muted mock-draft-board-caption">
          Keeper slots use each player&apos;s startup draft round from the <strong>{keeperCostDraft.sourceSeason}</strong>{' '}
          season (missing from draft → round {leagueFormat.undraftedKeeperRound}).
        </p>
      )}
      {showCaptions && keeperCostDraft.status === 'none' && (
        <p className="muted mock-draft-board-caption">
          No completed startup draft found in linked leagues yet — keeper round cells stay empty until Sleeper history
          loads.
        </p>
      )}
      {showCaptions && keeperCostDraft.status === 'error' && (
        <p className="muted mock-draft-board-caption">Could not load startup draft rounds for keeper costs.</p>
      )}
      <div className="mock-draft-board-scroll">
        <table className="mock-draft-board">
          <thead>
            <tr>
              <th scope="col" className="mock-draft-board__corner">
                Rd
              </th>
              {slotOrderUserIds.map((uid, slotIdx) => {
                const highlightCol =
                  timedDraftActive &&
                  currentPickMeta &&
                  pickCursor < pickQueueLength &&
                  currentPickMeta.slotIndex === slotIdx;
                return (
                  <th
                    key={uid}
                    scope="col"
                    className={
                      'mock-draft-board__team-head' + (highlightCol ? ' mock-draft-board__team-head--active' : '')
                    }
                  >
                    <span className="mock-draft-board__team-name">{labelByUserId.get(uid)}</span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: boardMaxRound }, (_, i) => i + 1).map((roundNum) => (
              <tr key={roundNum}>
                <th scope="row" className="mock-draft-board__rd tabular">
                  {roundNum}
                </th>
                {slotOrderUserIds.map((uid) => {
                  const cell = pickCellForRoundTeam(draftPicks, roundNum, uid);
                  const keeperIds = keeperCostByUserRound.get(uid)?.get(roundNum);
                  const hasKeeperCost = keeperIds && keeperIds.length > 0;
                  const highlightCell =
                    timedDraftActive &&
                    currentPickMeta &&
                    pickCursor < pickQueueLength &&
                    currentPickMeta.round === roundNum &&
                    currentPickMeta.userId === uid &&
                    !cell &&
                    !hasKeeperCost;
                  const cellKeeper =
                    !cell &&
                    hasKeeperCost && (
                      <div className="mock-draft-board__keeper-cost-inner">
                        {keeperIds.map((pid) => (
                          <div key={pid} className="mock-draft-board__keeper-cost-block">
                            <span className="mock-draft-board__pick-name">{fmtKeeperCostPlayer(pid, lookup)}</span>
                            <span className="mock-draft-board__pick-meta muted">Keeper · rd cost</span>
                          </div>
                        ))}
                      </div>
                    );
                  return (
                    <td
                      key={`${roundNum}-${uid}`}
                      className={
                        'mock-draft-board__cell' +
                        (highlightCell ? ' mock-draft-board__cell--pulse' : '') +
                        (hasKeeperCost && !cell ? ' mock-draft-board__cell--keeper-cost' : '')
                      }
                    >
                      {cell ? (
                        <>
                          <span className="mock-draft-board__pick-name">{cell.name}</span>
                          <span className="mock-draft-board__pick-meta muted">
                            {cell.pos}
                            {cell.pickKind === 'user' ? ' · you' : ''}
                          </span>
                        </>
                      ) : (
                        cellKeeper || <span className="mock-draft-board__empty">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function MockDraft() {
  const { user: authUser } = useAuth();

  const nominationsHidden = areKeeperNominationsHiddenInUi();
  const isCommissioner = Boolean(authUser && authUser.role === 'commissioner');

  const lockedSleeperUserId =
    authUser && authUser.role !== 'commissioner' && typeof authUser.sleeperUserId === 'string'
      ? authUser.sleeperUserId
      : null;

  const [chainLoading, setChainLoading] = useState(true);
  const [chain, setChain] = useState([]);
  const [seasonLeagueId, setSeasonLeagueId] = useState('');
  const [seasonLabel, setSeasonLabel] = useState('');

  const [users, setUsers] = useState([]);
  const [usersLoading, setUsersLoading] = useState(false);

  const [rosters, setRosters] = useState([]);
  const [rostersLoading, setRostersLoading] = useState(false);

  const [nominationRowsRaw, setNominationRowsRaw] = useState([]);
  const [nomLoading, setNomLoading] = useState(false);
  const [finalRowsRaw, setFinalRowsRaw] = useState([]);
  const [finalsLoading, setFinalsLoading] = useState(false);

  const [lookup, setLookup] = useState(null);

  const [rankings, setRankings] = useState({ status: 'idle' });
  const [autopickStrategy, setAutopickStrategy] = useState('ecr');
  const [pickSeconds, setPickSeconds] = useState(() => {
    const raw = typeof window !== 'undefined' ? window.localStorage?.getItem('mock-draft-pick-seconds') : null;
    const n = raw != null ? Number(raw) : DEFAULT_PICK_SECONDS;
    return Number.isFinite(n) && n >= 15 && n <= 600 ? n : DEFAULT_PICK_SECONDS;
  });

  const [slotOrderUserIds, setSlotOrderUserIds] = useState(null);
  const [draftPicks, setDraftPicks] = useState([]);
  const draftPicksRef = useRef([]);
  draftPicksRef.current = draftPicks;

  const [timedDraftActive, setTimedDraftActive] = useState(false);
  const [pickQueue, setPickQueue] = useState([]);
  const [pickCursor, setPickCursor] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(DEFAULT_PICK_SECONDS);
  const [draftPoolExhausted, setDraftPoolExhausted] = useState(false);

  const [keeperCostDraft, setKeeperCostDraft] = useState({ status: 'idle' });

  const [myTeamUserId, setMyTeamUserId] = useState('');
  const [playerSearch, setPlayerSearch] = useState('');
  const [playerPos, setPlayerPos] = useState('ALL');
  const [playerSort, setPlayerSort] = useState({ key: 'ecr', dir: 'asc' });

  const [liveMobileDockTab, setLiveMobileDockTab] = useState('players');
  const [liveDesktopSidebarTab, setLiveDesktopSidebarTab] = useState('chat');

  const rankingsPlayers = rankings.status === 'ready' ? rankings.data.players || [] : [];

  useEffect(() => {
    if (timedDraftActive) {
      setLiveMobileDockTab('players');
      setLiveDesktopSidebarTab('chat');
    }
  }, [timedDraftActive]);

  useEffect(() => {
    if (!timedDraftActive) return undefined;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [timedDraftActive]);

  useEffect(() => {
    try {
      window.localStorage?.setItem('mock-draft-strategy', autopickStrategy);
    } catch {
      /* ignore */
    }
  }, [autopickStrategy]);

  useEffect(() => {
    try {
      window.localStorage?.setItem('mock-draft-pick-seconds', String(pickSeconds));
    } catch {
      /* ignore */
    }
  }, [pickSeconds]);

  useEffect(() => {
    if (useDevKeeperMocks) {
      setFinalRowsRaw([]);
      setFinalsLoading(false);
      return;
    }
    let cancelled = false;
    setFinalsLoading(true);
    (async () => {
      try {
        const res = await fetch('/api/keeper-finals', { credentials: 'include' });
        const data = await res.json().catch(() => ({}));
        if (!cancelled && res.ok) {
          setFinalRowsRaw(Array.isArray(data.finals) ? data.finals : []);
        } else if (!cancelled) {
          setFinalRowsRaw([]);
        }
      } catch {
        if (!cancelled) setFinalRowsRaw([]);
      } finally {
        if (!cancelled) setFinalsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [useDevKeeperMocks]);

  useEffect(() => {
    if (!config.leagueId) {
      setChain([]);
      setChainLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const c = await resolveLeagueHistoryChain(config.leagueId);
        if (!cancelled && Array.isArray(c)) {
          setChain(c);
          if (c[0]) {
            setSeasonLeagueId(c[0].leagueId);
            setSeasonLabel(String(c[0].season));
          }
        }
      } finally {
        if (!cancelled) setChainLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!config.leagueId) {
      setKeeperCostDraft({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setKeeperCostDraft({ status: 'loading' });
    (async () => {
      try {
        const c = await resolveLeagueHistoryChain(config.leagueId);
        const hit = await findLatestSeasonWithSnakePicks(c);
        if (cancelled) return;
        if (!hit?.board?.picks?.length) {
          setKeeperCostDraft({ status: 'none' });
          return;
        }
        const draftByPlayerId = buildDraftSlotByPlayerId(hit.board.picks);
        setKeeperCostDraft({
          status: 'ready',
          draftByPlayerId,
          sourceSeason: String(hit.season ?? ''),
        });
      } catch {
        if (!cancelled) setKeeperCostDraft({ status: 'error' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config.leagueId]);

  useEffect(() => {
    let cancelled = false;
    getNflPlayersLookup()
      .then((m) => {
        if (!cancelled) setLookup(m);
      })
      .catch(() => {
        if (!cancelled) setLookup(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!seasonLeagueId) {
      setUsers([]);
      return;
    }
    let cancelled = false;
    setUsersLoading(true);
    fetchUsers(seasonLeagueId)
      .then((u) => {
        if (!cancelled) setUsers(Array.isArray(u) ? u : []);
      })
      .catch(() => {
        if (!cancelled) setUsers([]);
      })
      .finally(() => {
        if (!cancelled) setUsersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [seasonLeagueId]);

  useEffect(() => {
    if (!useDevKeeperMocks || !seasonLeagueId) {
      setRosters([]);
      return;
    }
    let cancelled = false;
    setRostersLoading(true);
    fetchRosters(seasonLeagueId)
      .then((r) => {
        if (!cancelled) setRosters(Array.isArray(r) ? r : []);
      })
      .catch(() => {
        if (!cancelled) setRosters([]);
      })
      .finally(() => {
        if (!cancelled) setRostersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [seasonLeagueId]);

  useEffect(() => {
    if (useDevKeeperMocks) {
      return;
    }
    if (!seasonLabel) {
      setNominationRowsRaw([]);
      return;
    }
    let cancelled = false;
    setNomLoading(true);
    (async () => {
      try {
        const res = await fetch('/api/keeper-nominations', { credentials: 'include' });
        const data = await res.json().catch(() => ({}));
        if (!cancelled && res.ok) {
          const rows = Array.isArray(data.nominations) ? data.nominations : [];
          setNominationRowsRaw(rows);
        } else if (!cancelled) setNominationRowsRaw([]);
      } catch {
        if (!cancelled) setNominationRowsRaw([]);
      } finally {
        if (!cancelled) setNomLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [seasonLabel, useDevKeeperMocks]);

  useEffect(() => {
    if (!useDevKeeperMocks || !seasonLabel) {
      if (useDevKeeperMocks) setNominationRowsRaw([]);
      return;
    }
    setNominationRowsRaw(
      buildDevMockKeeperNominations(
        users,
        rosters,
        seasonLabel,
        keeperCostDraft.status === 'ready' && keeperCostDraft.draftByPlayerId instanceof Map
          ? keeperCostDraft.draftByPlayerId
          : null,
      ),
    );
  }, [useDevKeeperMocks, seasonLabel, users, rosters, keeperCostDraft]);

  useEffect(() => {
    if (!config.leagueId) {
      setRankings({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setRankings({ status: 'loading' });
    fetch('/api/rankings?page_type=sleeper-adp-half', { credentials: 'include' })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        return data;
      })
      .then((data) => {
        if (!cancelled) setRankings({ status: 'ready', data });
      })
      .catch((err) => {
        if (!cancelled) setRankings({ status: 'error', message: err.message || String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [config.leagueId]);

  const towardSeason =
    chain[0] && chain[0].season != null ? Number(chain[0].season) + 1 : null;

  const nominationsEffective = useMemo(() => {
    if (useDevKeeperMocks) return nominationRowsRaw;

    const carry =
      towardSeason != null && Number.isFinite(towardSeason) ? String(towardSeason) : null;
    const finalsForSeason = finalRowsRaw.filter((f) => {
      if (!carry) return true;
      return String(f.carry_into_season) === carry;
    });

    if (finalsForSeason.length > 0) {
      // Locked-in keepers are league-visible — show every manager on the mock board.
      return finalsForSeason.map(finalToMockNomination).filter(Boolean);
    }

    // Fallback before finals exist: nominations (may include K2+K3 candidates).
    if (!seasonLabel || nominationRowsRaw.length === 0) return [];

    if (!nominationsHidden) {
      const seasonRows = nominationRowsRaw.filter((n) => String(n.source_season) === seasonLabel);
      return pickLatestNominationPerUser(seasonRows);
    }

    let pool = nominationRowsRaw;
    if (!isCommissioner && lockedSleeperUserId) {
      pool = nominationRowsRaw.filter((n) => n.sleeper_user_id === lockedSleeperUserId);
    } else if (!isCommissioner && !lockedSleeperUserId) {
      return [];
    }

    return pickLatestNominationPerUser(pool);
  }, [
    nominationRowsRaw,
    finalRowsRaw,
    nominationsHidden,
    seasonLabel,
    towardSeason,
    useDevKeeperMocks,
    isCommissioner,
    lockedSleeperUserId,
  ]);

  const usingLockedInFinals = useMemo(() => {
    if (useDevKeeperMocks) return false;
    const carry =
      towardSeason != null && Number.isFinite(towardSeason) ? String(towardSeason) : null;
    return finalRowsRaw.some((f) => (carry ? String(f.carry_into_season) === carry : true));
  }, [finalRowsRaw, towardSeason, useDevKeeperMocks]);

  const nominationByUserId = useMemo(() => {
    const m = new Map();
    for (const n of nominationsEffective) {
      const uid = n.sleeper_user_id;
      if (uid) m.set(uid, n);
    }
    return m;
  }, [nominationsEffective]);

  const sortedUsers = useMemo(() => {
    return [...users].sort((a, b) => {
      const na = (a.metadata?.team_name || a.display_name || a.user_id || '').toLowerCase();
      const nb = (b.metadata?.team_name || b.display_name || b.user_id || '').toLowerCase();
      return na.localeCompare(nb);
    });
  }, [users]);

  const labelByUserId = useMemo(() => {
    const m = new Map();
    for (const u of sortedUsers) {
      m.set(u.user_id, u.metadata?.team_name || u.display_name || u.user_id);
    }
    return m;
  }, [sortedUsers]);

  const keeperCostByUserRound = useMemo(() => {
    if (keeperCostDraft.status !== 'ready' || !keeperCostDraft.draftByPlayerId) return new Map();
    return buildKeeperCostRoundPlacements(
      sortedUsers,
      nominationByUserId,
      keeperCostDraft.draftByPlayerId,
      leagueFormat.undraftedKeeperRound,
    );
  }, [keeperCostDraft, sortedUsers, nominationByUserId]);

  const keeperBlockedRoundsByUserId = useMemo(
    () => keeperCostRoundBlocksFromPlacements(keeperCostByUserRound),
    [keeperCostByUserRound],
  );

  useEffect(() => {
    if (lockedSleeperUserId) {
      setMyTeamUserId(lockedSleeperUserId);
      return;
    }
    const ids = new Set(sortedUsers.map((u) => u.user_id));
    setMyTeamUserId((prev) => (prev && ids.has(prev) ? prev : ''));
  }, [lockedSleeperUserId, sortedUsers]);

  const loadingAny =
    chainLoading ||
    usersLoading ||
    (useDevKeeperMocks ? rostersLoading : nomLoading || finalsLoading);

  const randomizeOrder = useCallback(() => {
    if (timedDraftActive) return;
    const ids = sortedUsers.map((u) => u.user_id).filter(Boolean);
    setSlotOrderUserIds(shuffleDraftSlots(ids));
    setDraftPicks([]);
    setPickQueue([]);
    setPickCursor(0);
    setTimedDraftActive(false);
    setDraftPoolExhausted(false);
  }, [sortedUsers, timedDraftActive]);

  const runAutoDraft = useCallback(() => {
    if (!slotOrderUserIds?.length || rankings.status !== 'ready' || timedDraftActive) return;
    const picks = simulateSnakeDraft({
      slotOrderUserIds,
      users: sortedUsers,
      nominationByUserId,
      rankingsPlayers,
      strategy: autopickStrategy,
      targetRosterSize: leagueFormat.draftRounds,
      keeperCostRoundsByUserId: keeperBlockedRoundsByUserId,
    });
    setDraftPicks(picks);
    setPickQueue([]);
    setPickCursor(0);
    setTimedDraftActive(false);
    setDraftPoolExhausted(false);
  }, [
    slotOrderUserIds,
    sortedUsers,
    nominationByUserId,
    rankingsPlayers,
    rankings.status,
    autopickStrategy,
    timedDraftActive,
    keeperBlockedRoundsByUserId,
  ]);

  const resetDraftOnly = useCallback(() => {
    if (timedDraftActive) return;
    setDraftPicks([]);
    setDraftPoolExhausted(false);
  }, [timedDraftActive]);

  const leaveDraftRoom = useCallback(() => {
    setTimedDraftActive(false);
    setPickQueue([]);
    setPickCursor(0);
    setDraftPoolExhausted(false);
  }, []);

  const startTimedDraft = useCallback(() => {
    if (!slotOrderUserIds?.length || rankings.status !== 'ready') return;
    const queue = buildPickQueue(
      slotOrderUserIds,
      sortedUsers,
      nominationByUserId,
      leagueFormat.draftRounds,
      keeperBlockedRoundsByUserId,
    );
    if (!queue.length) return;
    setDraftPicks([]);
    draftPicksRef.current = [];
    setPickQueue(queue);
    setPickCursor(0);
    setTimedDraftActive(true);
    setDraftPoolExhausted(false);
    setPlayerSearch('');
  }, [slotOrderUserIds, sortedUsers, nominationByUserId, rankings.status, keeperBlockedRoundsByUserId]);

  const commitAutoPickForCursor = useCallback(
    (cursor, picksSnapshot) => {
      const meta = pickQueue[cursor];
      if (!meta) return null;
      const taken = combinedTakenIds(picksSnapshot, nominationByUserId);
      const player = pickBestAvailable(rankingsPlayers, taken, autopickStrategy);
      if (!player) return null;
      const record = draftPickRecord(meta, picksSnapshot.length + 1, player, 'auto');
      return record;
    },
    [pickQueue, nominationByUserId, rankingsPlayers, autopickStrategy],
  );

  const commitManualPickForCursor = useCallback(
    (cursor, picksSnapshot, player) => {
      const meta = pickQueue[cursor];
      if (!meta || !player?.sleeper_id) return null;
      const taken = combinedTakenIds(picksSnapshot, nominationByUserId);
      const sid = String(player.sleeper_id);
      if (taken.has(sid)) return null;
      return draftPickRecord(meta, picksSnapshot.length + 1, player, 'user');
    },
    [pickQueue, nominationByUserId],
  );

  const autopickCommitRef = useRef(() => {});

  const commitAutoPickForCursorRef = useRef(commitAutoPickForCursor);
  commitAutoPickForCursorRef.current = commitAutoPickForCursor;

  const timedDraftActiveRef = useRef(timedDraftActive);
  timedDraftActiveRef.current = timedDraftActive;
  const pickQueueRef = useRef(pickQueue);
  pickQueueRef.current = pickQueue;
  const pickCursorRef = useRef(pickCursor);
  pickCursorRef.current = pickCursor;

  autopickCommitRef.current = () => {
    if (!timedDraftActiveRef.current) return;
    const pc = pickCursorRef.current;
    const pq = pickQueueRef.current;
    if (pc >= pq.length) return;
    const prev = draftPicksRef.current;
    const record = commitAutoPickForCursorRef.current(pc, prev);
    if (!record) {
      setTimedDraftActive(false);
      setDraftPoolExhausted(true);
      return;
    }
    const next = [...prev, record];
    draftPicksRef.current = next;
    setDraftPicks(next);
    setPickCursor(pc + 1);
  };

  useEffect(() => {
    if (!timedDraftActive || pickCursor >= pickQueue.length || rankings.status !== 'ready') {
      return undefined;
    }

    const meta = pickQueue[pickCursor];
    if (!meta) return undefined;

    const isHumanPick = Boolean(myTeamUserId && meta.userId === myTeamUserId);

    if (!isHumanPick) {
      const snapCursor = pickCursor;
      const id = window.requestAnimationFrame(() => {
        if (!timedDraftActiveRef.current) return;
        if (pickCursorRef.current !== snapCursor) return;
        if (draftPicksRef.current.length !== snapCursor) return;
        autopickCommitRef.current();
      });
      return () => window.cancelAnimationFrame(id);
    }

    setSecondsLeft(pickSeconds);
    let remaining = pickSeconds;
    const intervalId = window.setInterval(() => {
      remaining -= 1;
      setSecondsLeft(remaining);
      if (remaining <= 0) {
        window.clearInterval(intervalId);
        autopickCommitRef.current();
      }
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [pickCursor, timedDraftActive, pickQueue, pickSeconds, rankings.status, myTeamUserId]);

  useEffect(() => {
    if (timedDraftActive && pickCursor >= pickQueue.length && pickQueue.length > 0) {
      setTimedDraftActive(false);
    }
  }, [timedDraftActive, pickCursor, pickQueue.length]);

  const currentPickMeta = pickQueue[pickCursor] || null;
  const isMyPick =
    Boolean(currentPickMeta && myTeamUserId && currentPickMeta.userId === myTeamUserId);

  const takenIdsDisplay = useMemo(
    () => combinedTakenIds(draftPicks, nominationByUserId),
    [draftPicks, nominationByUserId],
  );

  const playerPoolFiltered = useMemo(() => {
    const q = playerSearch.trim().toLowerCase();
    return rankingsPlayers.filter((p) => {
      if (!p.sleeper_id || takenIdsDisplay.has(String(p.sleeper_id))) return false;
      if (playerPos !== 'ALL' && String(p.pos || '').toUpperCase() !== playerPos) return false;
      if (!q) return true;
      const name = String(p.name || '').toLowerCase();
      const tm = String(p.team || '').toLowerCase();
      return name.includes(q) || tm.includes(q);
    });
  }, [rankingsPlayers, takenIdsDisplay, playerSearch, playerPos]);

  const togglePlayerSort = useCallback((col) => {
    setPlayerSort((prev) =>
      prev.key === col ? { key: col, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key: col, dir: 'asc' },
    );
  }, []);

  const LIVE_TABLE_ROW_CAP = 800;

  const sortedPoolAll = useMemo(() => {
    const rows = [...playerPoolFiltered];
    const sign = playerSort.dir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      if (playerSort.key === 'ecr') {
        const ae = a.ecr ?? 99999;
        const be = b.ecr ?? 99999;
        if (ae !== be) return sign * (ae - be);
      } else if (playerSort.key === 'name') {
        const c = String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
        if (c !== 0) return sign * c;
      } else if (playerSort.key === 'team') {
        const c = String(a.team || '').localeCompare(String(b.team || ''), undefined, { sensitivity: 'base' });
        if (c !== 0) return sign * c;
      }
      return (a.ecr ?? 99999) - (b.ecr ?? 99999);
    });
    return rows;
  }, [playerPoolFiltered, playerSort]);

  const sortedPoolTableRows = useMemo(() => sortedPoolAll.slice(0, LIVE_TABLE_ROW_CAP), [sortedPoolAll]);

  const sortHeaderLabel = (col, text) => {
    const active = playerSort.key === col;
    const arrow = active ? (playerSort.dir === 'asc' ? ' ↑' : ' ↓') : '';
    return text + arrow;
  };

  const onManualDraftPlayer = useCallback(
    (player) => {
      if (!timedDraftActive || !isMyPick || !player?.sleeper_id) return;
      const pc = pickCursorRef.current;
      const prev = draftPicksRef.current;
      const record = commitManualPickForCursor(pc, prev, player);
      if (!record) return;
      const next = [...prev, record];
      draftPicksRef.current = next;
      setDraftPicks(next);
      setPickCursor(pc + 1);
    },
    [timedDraftActive, isMyPick, commitManualPickForCursor],
  );

  const picksByRound = useMemo(() => {
    const m = new Map();
    for (const p of draftPicks) {
      const r = p.round;
      if (!m.has(r)) m.set(r, []);
      m.get(r).push(p);
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [draftPicks]);

  const boardMaxRound = leagueFormat.draftRounds;

  const myDraftedPicksLive = useMemo(() => {
    if (!myTeamUserId) return [];
    return [...draftPicks]
      .filter((p) => p.userId === myTeamUserId)
      .sort((a, b) => (a.overallPick ?? 0) - (b.overallPick ?? 0));
  }, [draftPicks, myTeamUserId]);

  const myKeeperSlotsLive = useMemo(() => {
    if (!myTeamUserId) return [];
    const byRound = keeperCostByUserRound.get(myTeamUserId);
    if (!byRound) return [];
    const rows = [];
    for (const [round, ids] of byRound.entries()) {
      for (const pid of ids || []) {
        rows.push({ round: Number(round), playerId: String(pid) });
      }
    }
    return rows.sort((a, b) => a.round - b.round || a.playerId.localeCompare(b.playerId));
  }, [keeperCostByUserRound, myTeamUserId]);

  function renderLiveAuxiliaryPanel(tabId) {
    if (tabId === 'queue') {
      return (
        <div className="mock-draft-live-aux-panel">
          <p className="mock-draft-live-aux-lead">
            <strong>Queue</strong>
          </p>
          <p className="muted mock-draft-live-aux-copy">
            Pick queue isn&apos;t built yet — tap or click a player in the board below to draft immediately when it&apos;s your turn.
          </p>
        </div>
      );
    }
    if (tabId === 'roster') {
      return (
        <div className="mock-draft-live-aux-panel mock-draft-live-aux-panel--roster">
          <p className="mock-draft-live-aux-lead">
            <strong>Your roster</strong>{' '}
            <span className="muted mock-draft-live-aux-sub">
              ({labelByUserId.get(myTeamUserId) || 'your team'})
            </span>
          </p>
          {myKeeperSlotsLive.length === 0 && myDraftedPicksLive.length === 0 ? (
            <p className="muted mock-draft-live-aux-copy">No keepers or picks yet in this mock run.</p>
          ) : (
            <ul className="mock-draft-live-roster-list">
              {myKeeperSlotsLive.map((k) => (
                <li key={`keeper-${k.round}-${k.playerId}`}>
                  <span className="tabular mock-draft-live-roster-slot">R{k.round}</span>
                  <span className="mock-draft-live-roster-name">{fmtKeeperCostPlayer(k.playerId, lookup)}</span>
                  <span className="mock-draft-live-roster-tag">keeper</span>
                </li>
              ))}
              {myDraftedPicksLive.map((p) => (
                <li key={`${p.overallPick}-${p.sleeperId}`}>
                  <span className="tabular mock-draft-live-roster-slot">{p.overallPick}</span>
                  <span className="mock-draft-live-roster-name">{p.name}</span>
                  <span className="muted">{p.pos}</span>
                  {p.pickKind === 'user' ? <span className="mock-draft-live-roster-tag">you</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    }
    if (tabId === 'chat') {
      return (
        <div className="mock-draft-live-aux-panel mock-draft-live-aux-panel--chat">
          <p className="mock-draft-live-chat-welcome-title">Welcome to mock draft</p>
          <p className="muted mock-draft-live-aux-copy">
            CPU teams pick instantly; your picks use the timer. Keeper costs appear on the board when startup draft history is
            loaded. Leave anytime — your finished picks stay listed on the page behind this overlay.
          </p>
        </div>
      );
    }
    return null;
  }

  function renderLivePlayerWorkspace() {
    if (!currentPickMeta || pickCursor >= pickQueue.length) {
      return (
        <p className="muted mock-draft-live-wait" aria-live="polite">
          {pickCursor >= pickQueue.length && pickQueue.length > 0 ? 'Draft complete.' : 'Waiting…'}
        </p>
      );
    }
    if (!isMyPick) {
      return (
        <p className="muted mock-draft-live-wait" aria-live="polite">
          <strong>{labelByUserId.get(currentPickMeta.userId)}</strong> is picking instantly…
        </p>
      );
    }
    if (rankings.status !== 'ready') {
      return <p className="muted">Loading ADP…</p>;
    }
    return (
      <>
        <p className="mock-draft-live-pick-hint">
          Click a row to draft that player. When time runs out, autopick uses Sleeper ADP.
        </p>
        <div className="mock-draft-picker__filters mock-draft-live-filters">
          <label className="mock-draft-picker__search">
            <span className="visually-hidden">Search players</span>
            <input
              type="search"
              value={playerSearch}
              onChange={(e) => setPlayerSearch(e.target.value)}
              placeholder="Find player…"
              autoComplete="off"
            />
          </label>
          <div className="mock-draft-picker__pills" role="tablist">
            {POSITION_FILTERS.map((p) => (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={playerPos === p}
                className={'mock-draft-picker__pill' + (playerPos === p ? ' mock-draft-picker__pill--active' : '')}
                onClick={() => setPlayerPos(p)}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
        <div className="mock-draft-live-table-scroll">
          <table className="mock-draft-live-table">
            <thead>
              <tr>
                <th scope="col" className="mock-draft-live-table__ecr">
                  <button type="button" className="mock-draft-sort-th" onClick={() => togglePlayerSort('ecr')}>
                    {sortHeaderLabel('ecr', 'ADP')}
                  </button>
                </th>
                <th scope="col">
                  <button type="button" className="mock-draft-sort-th" onClick={() => togglePlayerSort('name')}>
                    {sortHeaderLabel('name', 'Player')}
                  </button>
                </th>
                <th scope="col" className="mock-draft-live-table__pos">
                  Pos
                </th>
                <th scope="col">
                  <button type="button" className="mock-draft-sort-th" onClick={() => togglePlayerSort('team')}>
                    {sortHeaderLabel('team', 'NFL')}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedPoolTableRows.map((p) => (
                <tr
                  key={String(p.sleeper_id)}
                  className="mock-draft-live-table__row"
                  onClick={() => onManualDraftPlayer(p)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onManualDraftPlayer(p);
                    }
                  }}
                  tabIndex={0}
                  role="button"
                >
                  <td className="tabular mock-draft-live-table__ecr">
                    {p.ecr != null && Number.isFinite(Number(p.ecr)) ? Number(p.ecr).toFixed(1) : '—'}
                  </td>
                  <td>{p.name}</td>
                  <td className="muted mock-draft-live-table__pos">{p.pos ?? '—'}</td>
                  <td className="muted">{p.team ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted mock-draft-live-table-footer">
          {sortedPoolAll.length === 0
            ? 'No players match filters — loosen search or choose ALL positions.'
            : sortedPoolAll.length > LIVE_TABLE_ROW_CAP
              ? `Showing first ${sortedPoolTableRows.length} of ${sortedPoolAll.length} matching (refine filters to narrow).`
              : `${sortedPoolTableRows.length} available.`}{' '}
          Sort columns by tapping headers.
        </p>
      </>
    );
  }

  const leagueLiveSubtitle = `${slotOrderUserIds?.length ?? 0}-team snake · ${pickSeconds}s · ${boardMaxRound} rds`;

  return (
    <div className="page mock-draft-page">
      <header className="mock-draft-header">
        <h1>Mock draft</h1>
        <p className="mock-draft-lead muted">
          Opponents pick instantly; your picks use the timer. Pool order is{' '}
          <strong>Sleeper Half-PPR ADP</strong>. Locked-in keepers (K1 + ceremony second) fill the{' '}
          <strong>round slot each player costs</strong> from the last startup snake draft on file (waivers /
          undrafted → round {leagueFormat.undraftedKeeperRound}) — every manager&apos;s keepers are shown on
          the board.
        </p>
      </header>

      {!config.leagueId && (
        <section className="card mock-draft-card">
          <p className="muted">
            Configure <code>VITE_SLEEPER_LEAGUE_ID</code> to load league data.
          </p>
        </section>
      )}

      {config.leagueId && chainLoading && <p className="muted">Loading league…</p>}

      {config.leagueId && !chainLoading && !chain[0] && (
        <section className="card mock-draft-card">
          <p className="muted">Could not resolve league history from the configured league id.</p>
        </section>
      )}

      {config.leagueId && !chainLoading && chain[0] && (
        <>
          {nominationsHidden && !useDevKeeperMocks && (
            <section className="card mock-draft-card">
              <div className="keepers-reveal-gate" role="status">
                <p className="keepers-reveal-gate__title">Mock draft before nominations go public</p>
                <p className="keepers-reveal-gate__body">
                  Keeper nominations stay hidden until{' '}
                  <strong>{config.keepersRevealAt ? formatRevealLabel(config.keepersRevealAt) : 'the reveal date'}</strong>.
                  {isCommissioner ? (
                    <>
                      {' '}
                      This simulator uses each manager&apos;s <strong>latest nomination on file</strong> (any season) for
                      keeper slots.
                    </>
                  ) : lockedSleeperUserId ? (
                    <>
                      {' '}
                      Only <strong>your</strong> latest nomination fills keeper spots on your team; other teams simulate as if
                      they have no keepers until reveal.
                    </>
                  ) : (
                    <>
                      {' '}
                      Sign in with a member account that has a Sleeper id linked so your keeper nominations load here.
                    </>
                  )}
                </p>
              </div>
            </section>
          )}
          {useDevKeeperMocks && (
            <div className="mock-draft-dev-banner" role="status">
              <strong>Dev mode:</strong> mocked keepers use real startup cost rounds when loaded — at most one keeper per cost
              round per team (including undrafted → round {leagueFormat.undraftedKeeperRound}). Until startup picks load,
              only one mocked keeper per roster is assigned.
            </div>
          )}
          <section className="mock-draft-meta card mock-draft-card">
            <div>
              <span className="mock-draft-meta__label">Roster season</span>
              <span className="mock-draft-meta__value">
                {chain[0].season}
                {chain[0].name ? ` · ${chain[0].name}` : ''}
              </span>
            </div>
            {towardSeason != null && Number.isFinite(towardSeason) && (
              <div>
                <span className="mock-draft-meta__label">Drafting toward</span>
                <span className="mock-draft-meta__value">{towardSeason} season</span>
              </div>
            )}
            <div>
              <span className="mock-draft-meta__label">Target roster</span>
              <span className="mock-draft-meta__value">
                {leagueFormat.draftRounds} spots per team (keepers count toward this total)
              </span>
            </div>
          </section>

          {loadingAny && <p className="muted">Loading managers and keepers…</p>}

          {!loadingAny && sortedUsers.length === 0 && (
            <p className="muted">No managers found for this league season.</p>
          )}

          {!loadingAny && sortedUsers.length > 0 && (
            <>
              <details className="card mock-draft-card mock-draft-keepers-details">
                <summary className="mock-draft-keepers-details__summary">
                  {usingLockedInFinals ? 'Locked-in keepers by team' : 'Keepers by team'}
                </summary>
                <ul className="mock-draft-team-grid mock-draft-team-grid--nested">
                  {sortedUsers.map((u) => {
                    const label = u.metadata?.team_name || u.display_name || u.user_id;
                    const nom = nominationByUserId.get(u.user_id);
                    const keeperLine = nom ? fmtNominationRow(nom, lookup) : null;
                    const hideOthersKeepers =
                      nominationsHidden &&
                      !useDevKeeperMocks &&
                      !isCommissioner &&
                      lockedSleeperUserId &&
                      u.user_id !== lockedSleeperUserId;
                    return (
                      <li key={u.user_id} className="card mock-draft-team-card">
                        <h2 className="mock-draft-team-card__title">{label}</h2>
                        {!nom && (
                          <p className="muted mock-draft-team-card__keepers">
                            {hideOthersKeepers
                              ? 'Hidden until nominations are revealed — mock draft assumes no keepers for this team.'
                              : usingLockedInFinals
                                ? 'No locked-in keepers on file for this mock draft.'
                                : 'No nomination on file for this mock draft.'}
                          </p>
                        )}
                        {nom && !keeperLine && (
                          <p className="muted mock-draft-team-card__keepers">
                            Saved — no keeper slots filled.
                          </p>
                        )}
                        {keeperLine && (
                          <p className="mock-draft-team-card__keepers">
                            <span className="mock-draft-team-card__keepers-label">
                              {usingLockedInFinals ? 'Locked in' : 'Keepers'}
                            </span>
                            {keeperLine}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </details>

              <section className="card mock-draft-card mock-draft-simulator">
                <h2 className="mock-draft-simulator__title">Draft room</h2>
                <p className="muted mock-draft-simulator__lead">
                  Player pool from Sleeper Half-PPR ADP. Only players with a Sleeper id appear in the pool.
                </p>

                {rankings.status === 'loading' && <p className="muted">Loading Sleeper ADP…</p>}
                {rankings.status === 'error' && (
                  <p className="mock-draft-simulator__err" role="alert">
                    Could not load ADP. {rankings.message}
                  </p>
                )}
                {rankings.status === 'ready' && (
                  <p className="muted mock-draft-simulator__meta">
                    {rankings.data.count?.toLocaleString?.() ?? rankingsPlayers.length} players (Sleeper ADP)
                    {rankings.data.scrape_date && (
                      <>
                        {' '}
                        · as of <strong>{formatScrapeDate(rankings.data.scrape_date)}</strong>
                      </>
                    )}
                  </p>
                )}

                <div className="mock-draft-my-team-row">
                  <label className="mock-draft-control mock-draft-control--inline">
                    <span className="mock-draft-control__label">You draft as</span>
                    <select
                      value={myTeamUserId}
                      disabled={Boolean(lockedSleeperUserId) || timedDraftActive}
                      onChange={(e) => setMyTeamUserId(e.target.value)}
                    >
                      <option value="">Select your team…</option>
                      {sortedUsers.map((u) => (
                        <option key={u.user_id} value={u.user_id}>
                          {u.metadata?.team_name || u.display_name || u.user_id}
                        </option>
                      ))}
                    </select>
                  </label>
                  {lockedSleeperUserId && (
                    <p className="muted mock-draft-my-team-hint">Locked to your member account.</p>
                  )}
                </div>

                <div className="mock-draft-controls">
                  <label className="mock-draft-control">
                    <span className="mock-draft-control__label">Pick timer (seconds)</span>
                    <select
                      value={pickSeconds}
                      disabled={timedDraftActive}
                      onChange={(e) => setPickSeconds(Number(e.target.value))}
                    >
                      {[30, 45, 60, 90, 120, 180].map((s) => (
                        <option key={s} value={s}>
                          {s}s
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="mock-draft-control">
                    <span className="mock-draft-control__label">Autopick strategy (timer &amp; CPU)</span>
                    <select
                      value={autopickStrategy}
                      onChange={(e) => setAutopickStrategy(e.target.value === 'owned' ? 'owned' : 'ecr')}
                      disabled={rankings.status !== 'ready'}
                    >
                      <option value="ecr">ADP — best Sleeper ADP available</option>
                    </select>
                  </label>

                  <div className="mock-draft-actions">
                    <button type="button" className="btn btn-secondary" onClick={randomizeOrder} disabled={timedDraftActive}>
                      Randomize draft order
                    </button>
                    <button type="button" className="btn btn-secondary" onClick={resetDraftOnly} disabled={timedDraftActive}>
                      Clear board (instant sim only)
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={leaveDraftRoom}
                      disabled={!timedDraftActive}
                    >
                      Leave draft room
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary mock-draft-btn-live"
                      onClick={startTimedDraft}
                      disabled={
                        !slotOrderUserIds?.length ||
                        rankings.status !== 'ready' ||
                        timedDraftActive ||
                        !myTeamUserId
                      }
                    >
                      Enter draft room (timer)
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={runAutoDraft}
                      disabled={
                        !slotOrderUserIds?.length || rankings.status !== 'ready' || timedDraftActive || draftPoolExhausted
                      }
                    >
                      Run full auto-draft (no timer)
                    </button>
                  </div>
                  {!myTeamUserId && rankings.status === 'ready' && (
                    <p className="muted mock-draft-hint">Choose &quot;You draft as&quot; before entering the timed draft room.</p>
                  )}
                </div>

                {draftPoolExhausted && (
                  <p className="mock-draft-simulator__err" role="status">
                    Draft stopped — no ranked players left with Sleeper ids (or pool exhausted early).
                  </p>
                )}

                {!slotOrderUserIds?.length && (
                  <p className="muted mock-draft-hint">Randomize draft order to assign snake slots.</p>
                )}

                {slotOrderUserIds?.length > 0 && !timedDraftActive && (
                  <div className="mock-draft-order card mock-draft-order-card">
                    <h3 className="mock-draft-order__heading">Draft slot order (round 1 · snake)</h3>
                    <ol className="mock-draft-order__list">
                      {slotOrderUserIds.map((uid, i) => (
                        <li key={`${uid}-${i}`}>
                          <span className="mock-draft-order__slot">{i + 1}.</span>
                          <span>{labelByUserId.get(uid) || uid}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}

                {slotOrderUserIds?.length > 0 && !timedDraftActive && (
                  <MockDraftBoardPanel
                    compact={false}
                    slotOrderUserIds={slotOrderUserIds}
                    boardMaxRound={boardMaxRound}
                    draftPicks={draftPicks}
                    keeperCostByUserRound={keeperCostByUserRound}
                    lookup={lookup}
                    timedDraftActive={false}
                    currentPickMeta={currentPickMeta}
                    pickCursor={pickCursor}
                    pickQueueLength={pickQueue.length}
                    labelByUserId={labelByUserId}
                    keeperCostDraft={keeperCostDraft}
                  />
                )}

                {draftPicks.length > 0 && !timedDraftActive && (
                  <div className="mock-draft-results">
                    <h3 className="mock-draft-results__heading">{draftPicks.length} picks</h3>
                    <div className="mock-draft-results-scroll">
                      <table className="mock-draft-picks-table">
                        <thead>
                          <tr>
                            <th scope="col">#</th>
                            <th scope="col">R</th>
                            <th scope="col">Team</th>
                            <th scope="col">Player</th>
                            <th scope="col">Pos</th>
                            <th scope="col">ADP</th>
                            <th scope="col"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {draftPicks.map((p) => (
                            <tr key={`${p.overallPick}-${p.sleeperId}`}>
                              <td className="tabular">{p.overallPick}</td>
                              <td className="tabular">{p.round}</td>
                              <td>{labelByUserId.get(p.userId) || p.userId}</td>
                              <td>{p.name}</td>
                              <td>{p.pos}</td>
                              <td className="tabular">
                                {p.ecr != null && Number.isFinite(Number(p.ecr))
                                  ? Number(p.ecr).toFixed(1)
                                  : '—'}
                              </td>
                              <td className="muted">{p.pickKind === 'user' ? 'manual' : ''}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <details className="mock-draft-round-breakdown">
                      <summary>By round</summary>
                      <div className="mock-draft-round-breakdown__body">
                        {picksByRound.map(([round, picks]) => (
                          <div key={round} className="mock-draft-round-block">
                            <h4 className="mock-draft-round-block__title">Round {round}</h4>
                            <ul className="mock-draft-round-block__list">
                              {picks.map((p) => (
                                <li key={`${p.overallPick}-${p.sleeperId}`}>
                                  <strong>{labelByUserId.get(p.userId)}</strong>: {p.name}{' '}
                                  <span className="muted">
                                    ({p.pos}
                                    {p.ecr != null ? ` · ADP ${Number(p.ecr).toFixed(1)}` : ''})
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    </details>
                  </div>
                )}
              </section>
            </>
          )}
        </>
      )}

      {timedDraftActive && slotOrderUserIds?.length > 0 && (
        <div
          className="mock-draft-live-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mock-draft-live-title"
        >
          <div className="mock-draft-live-overlay__inner">
            <header className="mock-draft-live-bar">
              <button
                type="button"
                className="mock-draft-live-bar__back"
                onClick={leaveDraftRoom}
                aria-label="Leave draft room"
              >
                ← Back
              </button>
              <div className="mock-draft-live-bar__center">
                <h2 id="mock-draft-live-title" className="mock-draft-live-bar__title">
                  Mock draft room
                </h2>
                <p className="mock-draft-live-bar__meta muted">
                  {currentPickMeta && pickCursor < pickQueue.length ? (
                    <>
                      Pick <strong>{pickCursor + 1}</strong>/<strong>{pickQueue.length}</strong> · Rd{' '}
                      <strong>{currentPickMeta.round}</strong> · <strong>{labelByUserId.get(currentPickMeta.userId)}</strong>
                      {isMyPick ? <span className="mock-draft-live-bar__you"> · You</span> : null}
                    </>
                  ) : (
                    <>Wrapping up…</>
                  )}
                  <span className="mock-draft-live-bar__sep"> · </span>
                  <span>{leagueLiveSubtitle}</span>
                </p>
              </div>
              <div className="mock-draft-live-bar__right">
                {rankings.status === 'ready' &&
                  currentPickMeta &&
                  pickCursor < pickQueue.length &&
                  isMyPick && (
                    <div
                      className={
                        'mock-draft-live-bar__timer' +
                        (secondsLeft <= 10 ? ' mock-draft-live-bar__timer--warn' : '')
                      }
                      aria-live="polite"
                    >
                      {fmtClock(secondsLeft)}
                    </div>
                  )}
              </div>
            </header>

            <div className="mock-draft-live-board-shell">
              <MockDraftBoardPanel
                compact
                omitHeading
                slotOrderUserIds={slotOrderUserIds}
                boardMaxRound={boardMaxRound}
                draftPicks={draftPicks}
                keeperCostByUserRound={keeperCostByUserRound}
                lookup={lookup}
                timedDraftActive={timedDraftActive}
                currentPickMeta={currentPickMeta}
                pickCursor={pickCursor}
                pickQueueLength={pickQueue.length}
                labelByUserId={labelByUserId}
                keeperCostDraft={keeperCostDraft}
              />
            </div>

            <div className="mock-draft-live-workspace">
              <div className="mock-draft-live-mobile-dock" role="tablist" aria-label="Draft panels">
                {[
                  ['players', 'Players'],
                  ['queue', 'Queue'],
                  ['roster', 'Roster'],
                  ['chat', 'Chat'],
                ].map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={liveMobileDockTab === id}
                    className={
                      'mock-draft-live-dock-tab' +
                      (liveMobileDockTab === id ? ' mock-draft-live-dock-tab--active' : '')
                    }
                    onClick={() => setLiveMobileDockTab(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="mock-draft-live-workspace-grid">
                <section
                  className={
                    'mock-draft-live-players-col' +
                    (liveMobileDockTab !== 'players' ? ' mock-draft-live-players-col--hide-sm' : '')
                  }
                  aria-label="Available players"
                >
                  <div className="mock-draft-live-players-inner">{renderLivePlayerWorkspace()}</div>
                </section>

                <aside className="mock-draft-live-sidebar" aria-label="Queue, roster, and chat">
                  <div className="mock-draft-live-sidebar-tabs" role="tablist">
                    {[
                      ['queue', 'Queue'],
                      ['roster', 'Roster'],
                      ['chat', 'Chat'],
                    ].map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        role="tab"
                        aria-selected={liveDesktopSidebarTab === id}
                        className={
                          'mock-draft-live-tab' +
                          (liveDesktopSidebarTab === id ? ' mock-draft-live-tab--active' : '')
                        }
                        onClick={() => setLiveDesktopSidebarTab(id)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="mock-draft-live-sidebar-body">{renderLiveAuxiliaryPanel(liveDesktopSidebarTab)}</div>
                </aside>

                {liveMobileDockTab !== 'players' && (
                  <div className="mock-draft-live-mobile-aux">{renderLiveAuxiliaryPanel(liveMobileDockTab)}</div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
