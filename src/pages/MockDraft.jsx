import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../AuthContext.jsx';
import { areKeeperNominationsHiddenInUi, config, leagueFormat } from '../config.js';
import { buildDevMockKeeperNominations } from '../lib/devMockKeeperNominations.js';
import { findLatestSeasonWithSnakePicks, buildDraftSlotByPlayerId } from '../lib/drafts.js';
import {
  shuffleDraftSlotsWithFixed,
  simulateSnakeDraft,
  buildPickQueue,
  draftPickRecord,
  combinedTakenIds,
  pickFantasyProsStyle,
  assignTeamCheatSheets,
  teamRosterForNeeds,
  buildKeeperCostRoundPlacements,
  keeperCostRoundBlocksFromPlacements,
} from '../lib/mockDraftEngine.js';
import { resolveLeagueHistoryChain, fetchUsers, fetchRosters, getNflPlayersLookup } from '../lib/sleeper.js';
import './MockDraft.css';

const useDevKeeperMocks = import.meta.env.DEV;

const POSITION_FILTERS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'DST'];

const DEFAULT_PICK_SECONDS = 90;

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

function pickCellForRoundTeam(draftPicks, round, teamUserId) {
  return draftPicks.find((p) => p.round === round && p.userId === teamUserId) || null;
}

function fmtKeeperCostPlayer(pid, lookup) {
  const x = lookup?.get(pid);
  return x ? `${x.name} (${x.position || '?'})` : pid;
}

function shortManagerLabel(label) {
  const s = String(label || '').trim();
  if (!s) return '—';
  if (s.length <= 9) return s;
  const first = s.split(/\s+/)[0];
  return first.length <= 9 ? first : `${first.slice(0, 8)}…`;
}

function shortPlayerName(name) {
  const s = String(name || '').trim();
  if (!s) return '—';
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const first = parts[0].replace(/^[^A-Za-z0-9]+/, '');
    const last = parts[parts.length - 1];
    const initial = first ? `${first[0].toUpperCase()}.` : '';
    return initial ? `${initial} ${last}` : last;
  }
  if (s.length <= 12) return s;
  return `${s.slice(0, 11)}…`;
}

/** Position tint class — same palette idea as Drafts board cells. */
function mockDraftPosClass(posRaw) {
  const p = String(posRaw || '').toUpperCase();
  if (!p) return '';
  if (p === 'DST' || p === 'DEF') return ' mock-draft-pos-dst';
  if (p === 'WR' || p === 'RB' || p === 'QB' || p === 'TE' || p === 'K') {
    return ` mock-draft-pos-${p.toLowerCase()}`;
  }
  return ' mock-draft-pos-other';
}

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 3H3v6M15 3h6v6M9 21H3v-6M21 15v6h-6" />
    </svg>
  );
}

function CollapseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 9H3V3M15 9h6V3M9 15H3v6M21 15v6h-6" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
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
  compact = false,
  dense = false,
  omitHeading = false,
  highlightUserId = '',
}) {
  const showHeading = !omitHeading && !dense;
  return (
    <div
      className={
        'mock-draft-board-wrap' +
        (compact || dense ? ' mock-draft-board-wrap--compact' : '') +
        (dense ? ' mock-draft-board-wrap--dense' : '')
      }
    >
      {showHeading && !compact && <h3 className="mock-draft-board-title">Draft board</h3>}
      {showHeading && compact && (
        <h3 className="mock-draft-board-title mock-draft-board-title--compact">Board</h3>
      )}
      <div className="mock-draft-board-scroll">
        <table className={'mock-draft-board' + (dense ? ' mock-draft-board--dense' : '')}>
          <thead>
            <tr>
              <th scope="col" className="mock-draft-board__corner">
                #
              </th>
              {slotOrderUserIds.map((uid, slotIdx) => {
                const highlightCol =
                  timedDraftActive &&
                  currentPickMeta &&
                  pickCursor < pickQueueLength &&
                  currentPickMeta.slotIndex === slotIdx;
                const mine = highlightUserId && uid === highlightUserId;
                return (
                  <th
                    key={uid}
                    scope="col"
                    className={
                      'mock-draft-board__team-head' +
                      (highlightCol ? ' mock-draft-board__team-head--active' : '') +
                      (mine ? ' mock-draft-board__team-head--mine' : '')
                    }
                    title={labelByUserId.get(uid)}
                  >
                    <span className="mock-draft-board__team-name">
                      {dense ? shortManagerLabel(labelByUserId.get(uid)) : labelByUserId.get(uid)}
                    </span>
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
                  const keeperPos =
                    hasKeeperCost && !cell
                      ? lookup?.get(keeperIds[0])?.position || lookup?.get(keeperIds[0])?.pos || ''
                      : '';
                  const cellKeeper =
                    !cell &&
                    hasKeeperCost && (
                      <div className="mock-draft-board__keeper-cost-inner">
                        {keeperIds.map((pid) => {
                          const meta = lookup?.get(pid);
                          const name = meta?.name || pid;
                          const pos = meta?.position || meta?.pos || '';
                          const team = meta?.team || '';
                          return (
                            <div key={pid} className="mock-draft-board__keeper-cost-block">
                              <span className="mock-draft-board__pick-name" title={name}>
                                {dense ? shortPlayerName(name) : fmtKeeperCostPlayer(pid, lookup)}
                              </span>
                              {dense ? (
                                <span className="mock-draft-board__pick-meta muted">
                                  {[pos, team].filter(Boolean).join(' ') || 'K'}
                                  <span className="mock-draft-board__pick-slot"> · K</span>
                                </span>
                              ) : (
                                <span className="mock-draft-board__pick-meta muted">Keeper · rd cost</span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  return (
                    <td
                      key={`${roundNum}-${uid}`}
                      className={
                        'mock-draft-board__cell' +
                        (highlightCell ? ' mock-draft-board__cell--pulse' : '') +
                        (hasKeeperCost && !cell ? ' mock-draft-board__cell--keeper-cost' : '') +
                        mockDraftPosClass(cell ? cell.pos : keeperPos)
                      }
                    >
                      {cell ? (
                        <>
                          <span className="mock-draft-board__pick-name" title={cell.name}>
                            {dense ? shortPlayerName(cell.name) : cell.name}
                          </span>
                          <span className="mock-draft-board__pick-meta muted">
                            {[cell.pos, cell.team].filter(Boolean).join(' ')}
                            {cell.overallPick != null ? (
                              <span className="mock-draft-board__pick-slot"> · {cell.overallPick}</span>
                            ) : null}
                            {!dense && cell.pickKind === 'user' ? ' · you' : ''}
                          </span>
                        </>
                      ) : (
                        cellKeeper || <span className="mock-draft-board__empty">·</span>
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
  /** Extra cheat-sheet sources for FantasyPros-style bots (Sleeper ADP is always included). */
  const [rankingBoards, setRankingBoards] = useState([]);
  /** Per-team assigned cheat sheets for the current mock run. */
  const [teamBoards, setTeamBoards] = useState(null);
  const teamBoardsRef = useRef(null);
  teamBoardsRef.current = teamBoards;
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
  /** Keeps the live room open after the last pick so results stay visible. */
  const [draftRoomOpen, setDraftRoomOpen] = useState(false);
  const [boardExpanded, setBoardExpanded] = useState(false);
  const [pickQueue, setPickQueue] = useState([]);
  const [pickCursor, setPickCursor] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(DEFAULT_PICK_SECONDS);
  const [draftPoolExhausted, setDraftPoolExhausted] = useState(false);

  const [keeperCostDraft, setKeeperCostDraft] = useState({ status: 'idle' });

  const [myTeamUserId, setMyTeamUserId] = useState('');
  /** 0-based round-1 pick slot; '' until chosen. */
  const [myPickSlot, setMyPickSlot] = useState('');
  const [playerSearch, setPlayerSearch] = useState('');
  const [playerSearchOpen, setPlayerSearchOpen] = useState(false);
  const playerSearchInputRef = useRef(null);
  const [playerPos, setPlayerPos] = useState('ALL');
  const [playerSort, setPlayerSort] = useState({ key: 'ecr', dir: 'asc' });

  const [liveMobileDockTab, setLiveMobileDockTab] = useState('players');

  useEffect(() => {
    if (!playerSearchOpen) return;
    const id = window.requestAnimationFrame(() => playerSearchInputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [playerSearchOpen]);

  const rankingsPlayers = rankings.status === 'ready' ? rankings.data.players || [] : [];

  useEffect(() => {
    if (draftRoomOpen && timedDraftActive) {
      setLiveMobileDockTab('players');
    }
  }, [draftRoomOpen, timedDraftActive]);

  useEffect(() => {
    if (!draftRoomOpen) return undefined;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [draftRoomOpen]);

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
      setRankingBoards([]);
      return;
    }
    let cancelled = false;
    setRankings({ status: 'loading' });
    setRankingBoards([]);

    const loadBoard = async (pageType, id, label) => {
      const res = await fetch(`/api/rankings?page_type=${encodeURIComponent(pageType)}`, {
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const apiMsg = typeof data.error === 'string' ? data.error : '';
        const err = new Error(apiMsg || `Could not load ${label}`);
        err.status = res.status;
        err.apiError = apiMsg;
        throw err;
      }
      const players = Array.isArray(data.players) ? data.players.filter((p) => p?.sleeper_id) : [];
      if (!players.length) return null;
      return { id, label, players, scrape_date: data.scrape_date || null, count: players.length };
    };

    (async () => {
      try {
        const [sleeper] = await Promise.all([
          loadBoard('sleeper-adp-half', 'sleeper-adp', 'Sleeper ADP (Half-PPR)'),
        ]);
        if (cancelled) return;
        if (!sleeper) throw new Error('Could not load Sleeper ADP');
        // CPU cheat sheets use Sleeper ADP only — alternate ECR boards were letting
        // mid-ADP names (e.g. Collins) leapfrog early Sleeper ADP (e.g. JSN).
        const boards = [sleeper];
        setRankings({
          status: 'ready',
          data: {
            page_type: 'sleeper-adp-half',
            scrape_date: sleeper.scrape_date,
            count: sleeper.count,
            players: sleeper.players,
            source: 'sleeper',
            boards: boards.map((b) => ({ id: b.id, label: b.label, count: b.count })),
          },
        });
        setRankingBoards(boards);
        setTeamBoards(null);
      } catch (err) {
        if (!cancelled) {
          const viteOnly =
            err?.status === 503 ||
            (typeof err?.apiError === 'string' && err.apiError.includes('Vite alone'));
          setRankings({
            status: 'error',
            message: viteOnly
              ? 'Rankings API is not available under `npm run dev`. Stop Vite and run `npx vercel dev`, then open the URL it prints (often http://localhost:3000).'
              : err.message || String(err),
          });
          setRankingBoards([]);
        }
      }
    })();

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

  const applyDraftOrder = useCallback(() => {
    if (timedDraftActive) return;
    if (!myTeamUserId || myPickSlot === '') return;
    const ids = sortedUsers.map((u) => u.user_id).filter(Boolean);
    if (!ids.includes(myTeamUserId)) return;
    setSlotOrderUserIds(shuffleDraftSlotsWithFixed(ids, myTeamUserId, Number(myPickSlot)));
    setDraftPicks([]);
    setPickQueue([]);
    setPickCursor(0);
    setTimedDraftActive(false);
    setDraftPoolExhausted(false);
    teamBoardsRef.current = null;
    setTeamBoards(null);
  }, [sortedUsers, timedDraftActive, myTeamUserId, myPickSlot]);

  useEffect(() => {
    if (timedDraftActive) return;
    if (!myTeamUserId || myPickSlot === '') return;
    applyDraftOrder();
  }, [myTeamUserId, myPickSlot, applyDraftOrder, timedDraftActive]);

  const ensureTeamBoards = useCallback(() => {
    if (!slotOrderUserIds?.length || rankingBoards.length === 0) return null;
    const assigned = assignTeamCheatSheets(slotOrderUserIds, rankingBoards);
    teamBoardsRef.current = assigned;
    setTeamBoards(assigned);
    return assigned;
  }, [slotOrderUserIds, rankingBoards]);

  const runAutoDraft = useCallback(() => {
    if (!slotOrderUserIds?.length || rankings.status !== 'ready' || timedDraftActive) return;
    const boards = ensureTeamBoards();
    const picks = simulateSnakeDraft({
      slotOrderUserIds,
      users: sortedUsers,
      nominationByUserId,
      rankingsPlayers,
      targetRosterSize: leagueFormat.draftRounds,
      keeperCostRoundsByUserId: keeperBlockedRoundsByUserId,
      teamBoards: boards,
      lookup,
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
    timedDraftActive,
    keeperBlockedRoundsByUserId,
    ensureTeamBoards,
    lookup,
  ]);

  const resetDraftOnly = useCallback(() => {
    if (timedDraftActive) return;
    setDraftPicks([]);
    setDraftPoolExhausted(false);
  }, [timedDraftActive]);

  const leaveDraftRoom = useCallback(() => {
    setDraftRoomOpen(false);
    setBoardExpanded(false);
    setTimedDraftActive(false);
    setPickQueue([]);
    setPickCursor(0);
    setDraftPoolExhausted(false);
  }, []);

  const leaveDraftRoomRef = useRef(leaveDraftRoom);
  leaveDraftRoomRef.current = leaveDraftRoom;

  useEffect(() => {
    if (!draftRoomOpen) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (boardExpanded) {
        setBoardExpanded(false);
        return;
      }
      leaveDraftRoomRef.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draftRoomOpen, boardExpanded]);

  const startTimedDraft = useCallback(() => {
    if (!slotOrderUserIds?.length || rankings.status !== 'ready') return;
    ensureTeamBoards();
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
    setBoardExpanded(false);
    setDraftRoomOpen(true);
    setTimedDraftActive(true);
    setDraftPoolExhausted(false);
    setPlayerSearch('');
  }, [
    slotOrderUserIds,
    sortedUsers,
    nominationByUserId,
    rankings.status,
    keeperBlockedRoundsByUserId,
    ensureTeamBoards,
  ]);

  const commitAutoPickForCursor = useCallback(
    (cursor, picksSnapshot) => {
      const meta = pickQueue[cursor];
      if (!meta) return null;
      const taken = combinedTakenIds(picksSnapshot, nominationByUserId);
      const sheet = teamBoardsRef.current?.get(meta.userId);
      const boardPlayers = sheet?.players || rankingsPlayers;
      const teamRoster = teamRosterForNeeds(meta.userId, picksSnapshot, nominationByUserId, lookup);
      const player = pickFantasyProsStyle({
        boardPlayers,
        takenIds: taken,
        teamRoster,
      });
      if (!player) return null;
      return draftPickRecord(meta, picksSnapshot.length + 1, player, 'auto');
    },
    [pickQueue, nominationByUserId, rankingsPlayers, lookup],
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
      const id = window.setTimeout(() => {
        if (!timedDraftActiveRef.current) return;
        if (pickCursorRef.current !== snapCursor) return;
        if (draftPicksRef.current.length !== snapCursor) return;
        autopickCommitRef.current();
      }, 1000);
      return () => window.clearTimeout(id);
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
      setBoardExpanded(false);
      setLiveMobileDockTab('roster');
    }
  }, [timedDraftActive, pickCursor, pickQueue.length]);

  const draftComplete = pickQueue.length > 0 && pickCursor >= pickQueue.length;
  const currentPickMeta = pickQueue[pickCursor] || null;
  const isMyPick =
    Boolean(currentPickMeta && myTeamUserId && currentPickMeta.userId === myTeamUserId && !draftComplete);

  useEffect(() => {
    if (isMyPick) setLiveMobileDockTab('players');
  }, [isMyPick]);

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
      } else if (playerSort.key === 'pts') {
        const ap = a.pts_half_ppr ?? -1;
        const bp = b.pts_half_ppr ?? -1;
        if (ap !== bp) return sign * (ap - bp);
      } else if (playerSort.key === 'bye') {
        const ab = a.bye ?? 99;
        const bb = b.bye ?? 99;
        if (ab !== bb) return sign * (ab - bb);
      } else if (playerSort.key === 'years') {
        const ay = a.years_exp ?? 99;
        const by = b.years_exp ?? 99;
        if (ay !== by) return sign * (ay - by);
      } else if (playerSort.key === 'pos') {
        const c = String(a.pos || '').localeCompare(String(b.pos || ''), undefined, { sensitivity: 'base' });
        if (c !== 0) return sign * c;
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

  function renderLiveRosterPanel() {
    return (
      <div className="mock-draft-live-aux-panel mock-draft-live-aux-panel--roster">
        <p className="mock-draft-live-aux-lead">
          <strong>Your roster</strong>{' '}
          <span className="muted mock-draft-live-aux-sub">
            ({labelByUserId.get(myTeamUserId) || 'your team'})
          </span>
        </p>
        {myKeeperSlotsLive.length === 0 && myDraftedPicksLive.length === 0 ? null : (
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

  function renderLivePlayerWorkspace() {
    if (draftComplete) {
      return (
        <div className="mock-draft-live-results">
          <p className="mock-draft-live-results__title">Draft complete</p>
          <div className="mock-draft-live-results__actions">
            <button type="button" className="btn btn-secondary" onClick={() => setBoardExpanded(true)} aria-label="Expand board">
              <ExpandIcon />
            </button>
            <button type="button" className="btn btn-primary" onClick={leaveDraftRoom}>
              Done
            </button>
          </div>
        </div>
      );
    }
    if (rankings.status !== 'ready') {
      return <p className="muted">Loading ADP…</p>;
    }
    const canPick = Boolean(isMyPick && currentPickMeta && pickCursor < pickQueue.length);
    const searchExpanded = playerSearchOpen || Boolean(playerSearch.trim());
    return (
      <>
        <div className="mock-draft-live-filters">
          {searchExpanded ? (
            <div className="mock-draft-live-toolbar mock-draft-live-toolbar--search">
              <label className="mock-draft-live-search">
                <span className="visually-hidden">Search players</span>
                <input
                  ref={playerSearchInputRef}
                  type="search"
                  value={playerSearch}
                  onChange={(e) => setPlayerSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setPlayerSearch('');
                      setPlayerSearchOpen(false);
                    }
                  }}
                  placeholder="Search players…"
                  autoComplete="off"
                />
              </label>
              <button
                type="button"
                className="mock-draft-live-search-close"
                aria-label="Close search"
                onClick={() => {
                  setPlayerSearch('');
                  setPlayerSearchOpen(false);
                }}
              >
                <CloseIcon />
              </button>
            </div>
          ) : (
            <div className="mock-draft-live-toolbar">
              <button
                type="button"
                className="mock-draft-live-search-btn"
                aria-label="Search players"
                onClick={() => setPlayerSearchOpen(true)}
              >
                <SearchIcon />
              </button>
              <div className="mock-draft-live-pills" role="tablist" aria-label="Position filter">
                {POSITION_FILTERS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="tab"
                    aria-selected={playerPos === p}
                    className={'mock-draft-live-pill' + (playerPos === p ? ' mock-draft-live-pill--active' : '')}
                    onClick={() => setPlayerPos(p)}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          )}
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
                  <button type="button" className="mock-draft-sort-th" onClick={() => togglePlayerSort('pos')}>
                    {sortHeaderLabel('pos', 'Pos')}
                  </button>
                </th>
                <th scope="col" className="mock-draft-live-table__team">
                  <button type="button" className="mock-draft-sort-th" onClick={() => togglePlayerSort('team')}>
                    {sortHeaderLabel('team', 'NFL')}
                  </button>
                </th>
                <th scope="col" className="mock-draft-live-table__bye">
                  <button type="button" className="mock-draft-sort-th" onClick={() => togglePlayerSort('bye')}>
                    {sortHeaderLabel('bye', 'Bye')}
                  </button>
                </th>
                <th scope="col" className="mock-draft-live-table__pts">
                  <button
                    type="button"
                    className="mock-draft-sort-th"
                    onClick={() => togglePlayerSort('pts')}
                    title="Projected Half-PPR points"
                  >
                    {sortHeaderLabel('pts', 'Proj')}
                  </button>
                </th>
                <th scope="col" className="mock-draft-live-table__yr">
                  <button type="button" className="mock-draft-sort-th" onClick={() => togglePlayerSort('years')}>
                    {sortHeaderLabel('years', 'Yr')}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedPoolTableRows.map((p) => {
                const injury = String(p.injury_status || '').trim();
                const years = p.years_exp;
                const isRookie = years === 0;
                return (
                  <tr
                    key={String(p.sleeper_id)}
                    className={
                      'mock-draft-live-table__row' + (canPick ? ' mock-draft-live-table__row--pickable' : '')
                    }
                    onClick={canPick ? () => onManualDraftPlayer(p) : undefined}
                    onKeyDown={
                      canPick
                        ? (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              onManualDraftPlayer(p);
                            }
                          }
                        : undefined
                    }
                    tabIndex={canPick ? 0 : undefined}
                    role={canPick ? 'button' : undefined}
                  >
                    <td className="tabular mock-draft-live-table__ecr">
                      {p.ecr != null && Number.isFinite(Number(p.ecr)) ? Number(p.ecr).toFixed(1) : '—'}
                    </td>
                    <td className="mock-draft-live-table__player">
                      <span className="mock-draft-live-table__name">{p.name}</span>
                      {injury ? (
                        <span
                          className={
                            'mock-draft-injury' +
                            (['Out', 'IR', 'PUP', 'Suspended', 'Covid'].includes(injury)
                              ? ' mock-draft-injury--bad'
                              : ' mock-draft-injury--warn')
                          }
                          title={injury}
                        >
                          {injury === 'Questionable' ? 'Q' : injury === 'Doubtful' ? 'D' : injury.slice(0, 3)}
                        </span>
                      ) : null}
                      {isRookie ? (
                        <span className="mock-draft-rookie" title="Rookie">
                          R
                        </span>
                      ) : null}
                    </td>
                    <td className="mock-draft-live-table__pos">
                      {p.pos ? (
                        <span className={`mock-draft-pos-badge mock-draft-pos-badge--${String(p.pos).toLowerCase()}`}>
                          {p.pos}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="muted mock-draft-live-table__team">{p.team ?? '—'}</td>
                    <td className="tabular muted mock-draft-live-table__bye">
                      {p.bye != null && Number.isFinite(Number(p.bye)) ? Number(p.bye) : '—'}
                    </td>
                    <td className="tabular mock-draft-live-table__pts">
                      {p.pts_half_ppr != null && Number.isFinite(Number(p.pts_half_ppr))
                        ? Math.round(Number(p.pts_half_ppr))
                        : '—'}
                    </td>
                    <td className="tabular muted mock-draft-live-table__yr">
                      {isRookie ? 'R' : years != null && Number.isFinite(Number(years)) ? Number(years) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </>
    );
  }

  return (
    <div className="page mock-draft-page">
      <header className="mock-draft-header">
        <h1>Mock draft</h1>
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
          {loadingAny && <p className="muted">Loading…</p>}

          {!loadingAny && sortedUsers.length === 0 && (
            <p className="muted">No managers found for this league season.</p>
          )}

          {!loadingAny && sortedUsers.length > 0 && (
            <>
              <section className="card mock-draft-card mock-draft-simulator">
                <h2 className="mock-draft-simulator__title">Draft room</h2>

                {rankings.status === 'loading' && <p className="muted">Loading…</p>}
                {rankings.status === 'error' && (
                  <p className="mock-draft-simulator__err" role="alert">
                    {rankings.message || 'Could not load ADP.'}
                  </p>
                )}

                <div className="mock-draft-my-team-row">
                  <label className="mock-draft-control mock-draft-control--inline">
                    <span className="mock-draft-control__label">You draft as</span>
                    <select
                      value={myTeamUserId}
                      disabled={Boolean(lockedSleeperUserId) || timedDraftActive}
                      onChange={(e) => {
                        setMyTeamUserId(e.target.value);
                      }}
                    >
                      <option value="">Select team…</option>
                      {sortedUsers.map((u) => (
                        <option key={u.user_id} value={u.user_id}>
                          {u.metadata?.team_name || u.display_name || u.user_id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="mock-draft-control mock-draft-control--inline">
                    <span className="mock-draft-control__label">Your pick</span>
                    <select
                      value={myPickSlot === '' ? '' : String(myPickSlot)}
                      disabled={!myTeamUserId || timedDraftActive}
                      onChange={(e) => {
                        const v = e.target.value;
                        setMyPickSlot(v === '' ? '' : Number(v));
                      }}
                    >
                      <option value="">Pick #…</option>
                      {sortedUsers.map((_, i) => {
                        const n = i + 1;
                        const mod100 = n % 100;
                        const suffix =
                          mod100 >= 11 && mod100 <= 13
                            ? 'th'
                            : n % 10 === 1
                              ? 'st'
                              : n % 10 === 2
                                ? 'nd'
                                : n % 10 === 3
                                  ? 'rd'
                                  : 'th';
                        return (
                          <option key={i} value={i}>
                            {n}
                            {suffix} overall
                          </option>
                        );
                      })}
                    </select>
                  </label>
                </div>

                <div className="mock-draft-controls">
                  <label className="mock-draft-control">
                    <span className="mock-draft-control__label">Pick timer</span>
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

                  <div className="mock-draft-actions">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={applyDraftOrder}
                      disabled={timedDraftActive || !myTeamUserId || myPickSlot === ''}
                    >
                      {slotOrderUserIds?.length ? 'Reshuffle others' : 'Set draft order'}
                    </button>
                    <button type="button" className="btn btn-secondary" onClick={resetDraftOnly} disabled={timedDraftActive}>
                      Clear board
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={leaveDraftRoom}
                      disabled={!draftRoomOpen}
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
                      Enter draft room
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={runAutoDraft}
                      disabled={
                        !slotOrderUserIds?.length || rankings.status !== 'ready' || timedDraftActive || draftPoolExhausted
                      }
                    >
                      Auto-draft
                    </button>
                  </div>
                </div>

                {draftPoolExhausted && (
                  <p className="mock-draft-simulator__err" role="status">
                    Pool exhausted.
                  </p>
                )}

                {slotOrderUserIds?.length > 0 && !timedDraftActive && (
                  <div className="mock-draft-order card mock-draft-order-card">
                    <h3 className="mock-draft-order__heading">Draft order</h3>
                    <ol className="mock-draft-order__list">
                      {slotOrderUserIds.map((uid, i) => (
                        <li key={`${uid}-${i}`} className={uid === myTeamUserId ? 'mock-draft-order__you' : undefined}>
                          <span>{labelByUserId.get(uid) || uid}</span>
                          {uid === myTeamUserId ? <span className="mock-draft-order__tag">you</span> : null}
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

      {draftRoomOpen && slotOrderUserIds?.length > 0 && (
        <div
          className="mock-draft-live-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mock-draft-live-title"
        >
          <div
            className={
              'mock-draft-live-overlay__inner' +
              (boardExpanded ? ' mock-draft-live-overlay__inner--board-expanded' : '')
            }
          >
            <header className="mock-draft-live-bar">
              <button
                type="button"
                className="mock-draft-live-bar__back"
                onClick={leaveDraftRoom}
                aria-label={draftComplete ? 'Close draft room' : 'Leave draft room'}
              >
                <BackIcon />
              </button>
              <div className="mock-draft-live-bar__center">
                <h2 id="mock-draft-live-title" className="visually-hidden">
                  {draftComplete ? 'Mock draft results' : 'Mock draft room'}
                </h2>
                {draftComplete ? (
                  <span className="mock-draft-live-bar__done" aria-live="polite">
                    ✓
                  </span>
                ) : timedDraftActive && currentPickMeta && pickCursor < pickQueue.length ? (
                  <div
                    className={
                      'mock-draft-live-bar__timer' +
                      (isMyPick ? ' mock-draft-live-bar__timer--mine' : '') +
                      (secondsLeft <= 10 ? ' mock-draft-live-bar__timer--warn' : '')
                    }
                    aria-live="polite"
                    aria-label={`Time remaining ${fmtClock(secondsLeft)}`}
                  >
                    {fmtClock(secondsLeft)}
                  </div>
                ) : (
                  <span className="mock-draft-live-bar__timer mock-draft-live-bar__timer--idle">—</span>
                )}
              </div>
              <button
                type="button"
                className="mock-draft-live-bar__expand"
                onClick={() => setBoardExpanded((v) => !v)}
                aria-pressed={boardExpanded}
                aria-label={boardExpanded ? 'Exit full-screen board' : 'Expand board full screen'}
                title={boardExpanded ? 'Exit full screen' : 'Full screen'}
              >
                {boardExpanded ? <CollapseIcon /> : <ExpandIcon />}
              </button>
            </header>

            <div
              className={
                'mock-draft-live-board-shell' +
                (boardExpanded ? ' mock-draft-live-board-shell--expanded' : '')
              }
            >
              <MockDraftBoardPanel
                dense
                omitHeading
                highlightUserId={myTeamUserId}
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

            {!boardExpanded && (
            <div className="mock-draft-live-workspace">
              <div className="mock-draft-live-mobile-dock" role="tablist" aria-label="Draft panels">
                {[
                  ['players', draftComplete ? 'Results' : 'Players'],
                  ['roster', 'Roster'],
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
                  aria-label={draftComplete ? 'Draft results' : 'Available players'}
                >
                  <div className="mock-draft-live-players-inner">{renderLivePlayerWorkspace()}</div>
                </section>

                <aside className="mock-draft-live-sidebar" aria-label="Your roster">
                  <div className="mock-draft-live-sidebar-body">{renderLiveRosterPanel()}</div>
                </aside>

                {liveMobileDockTab === 'roster' && (
                  <div className="mock-draft-live-mobile-aux">{renderLiveRosterPanel()}</div>
                )}
              </div>
            </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
