import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useLeague } from '../LeagueContext.jsx';
import {
  loadDraftHistoryChain,
  fetchSeasonDraftBoard,
  formatPickPlayer,
  buildDraftGridModel,
} from '../lib/drafts.js';
import './Drafts.css';

/** Safe class suffix for position-tinted cells (Sleeper `metadata.position`). */
function draftPosTintClass(posRaw) {
  const p = String(posRaw || '').toUpperCase();
  if (!p) return '';
  if (p === 'WR' || p === 'RB' || p === 'QB' || p === 'TE' || p === 'DEF') {
    return ` draft-cell-pos-${p.toLowerCase()}`;
  }
  if (p === 'K') return ' draft-cell-pos-k';
  return ' draft-cell-pos-other';
}

export default function Drafts() {
  const { leagueId: rootLeagueId } = useLeague();
  const [chain, setChain] = useState(null);
  const [seasonIndex, setSeasonIndex] = useState(0);
  const [board, setBoard] = useState(null);
  const [loadingChain, setLoadingChain] = useState(true);
  const [loadingBoard, setLoadingBoard] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!rootLeagueId) {
      setChain([]);
      setLoadingChain(false);
      return;
    }
    let cancelled = false;
    setLoadingChain(true);
    (async () => {
      try {
        const c = await loadDraftHistoryChain(rootLeagueId);
        if (!cancelled) {
          setChain(c);
          setSeasonIndex(0);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e.message || 'Could not load league history');
          setChain([]);
        }
      } finally {
        if (!cancelled) setLoadingChain(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rootLeagueId]);

  const leagueId = chain?.[seasonIndex]?.leagueId;

  const loadBoard = useCallback(async () => {
    if (!leagueId) {
      setBoard(null);
      return;
    }
    setLoadingBoard(true);
    setError(null);
    try {
      const data = await fetchSeasonDraftBoard(leagueId);
      setBoard(data);
    } catch (e) {
      setBoard(null);
      setError(e.message || 'Could not load draft');
    } finally {
      setLoadingBoard(false);
    }
  }, [leagueId]);

  useEffect(() => {
    loadBoard();
  }, [loadBoard]);

  const grid = useMemo(() => {
    if (!board?.draft || !board.picks?.length) return null;
    return buildDraftGridModel(board.draft, board.picks, board.teamsByUserId);
  }, [board]);

  const gridStyle = useMemo(() => {
    if (!grid?.slotCount) return undefined;
    const rd = 40;
    const col = 108;
    const minW = rd + grid.slotCount * col;
    return {
      gridTemplateColumns: `${rd}px repeat(${grid.slotCount}, minmax(96px, 118px))`,
      minWidth: `${minW}px`,
    };
  }, [grid]);

  if (!rootLeagueId) {
    return (
      <div className="page">
        <p className="muted">Set VITE_SLEEPER_LEAGUE_ID to view drafts.</p>
      </div>
    );
  }

  return (
    <div className="page drafts-page">
      <header className="page-header">
        <span className="eyebrow">League history</span>
        <h1>Draft boards</h1>
        <p className="muted">Columns follow draft slot (round 1 order). Rows are rounds.</p>
      </header>

      {loadingChain && <div className="skeleton" style={{ height: 44, maxWidth: 420 }} />}

      {error && (
        <div className="card">
          <p className="drafts-error">{error}</p>
        </div>
      )}

      {!loadingChain && chain && chain.length === 0 && (
        <div className="card muted">No linked seasons found for this league.</div>
      )}

      {!loadingChain && chain && chain.length > 0 && (
        <>
          <div className="drafts-season-tabs scroll-x" role="tablist" aria-label="Season">
            {chain.map((row, i) => (
              <button
                key={row.leagueId}
                type="button"
                role="tab"
                aria-selected={i === seasonIndex}
                className={'drafts-tab' + (i === seasonIndex ? ' active' : '')}
                onClick={() => setSeasonIndex(i)}
              >
                {row.season}
              </button>
            ))}
          </div>

          {loadingBoard && (
            <div className="card" style={{ marginTop: 12 }}>
              <div className="skeleton" style={{ height: 200 }} />
            </div>
          )}

          {!loadingBoard && board && !board.draft && (
            <div className="card muted" style={{ marginTop: 12 }}>
              No draft found for {chain[seasonIndex].season} in Sleeper (league may predate tracked drafts or
              used a different flow).
            </div>
          )}

          {!loadingBoard && board && board.draft && !grid?.slotCount && (
            <div className="card muted" style={{ marginTop: 12 }}>
              Could not build a team grid from this draft (missing slot data).
            </div>
          )}

          {!loadingBoard && board && board.draft && grid?.slotCount > 0 && (
            <section className="card drafts-board-card" style={{ marginTop: 12 }}>
              <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
                <h2 className="drafts-board-title">{board.draftLabel || `Season ${board.draft.season}`}</h2>
                <span className="dim" style={{ fontSize: 13 }}>
                  {board.draft.status === 'complete' ? 'Complete' : board.draft.status || ''} ·{' '}
                  {board.picks.length} picks · {grid.maxRound} rounds
                </span>
              </div>

              <div className="scroll-x draft-board-outer">
                <div className="draft-board-grid" style={gridStyle}>
                  <div className="draft-board-corner" aria-hidden="true" />
                  {grid.columns.map((col) => (
                    <div key={col.slot} className="draft-board-colhead">
                      <span className="draft-board-slot">#{col.slot}</span>
                      {col.team?.avatar ? (
                        <img
                          src={col.team.avatar}
                          alt=""
                          width="28"
                          height="28"
                          className="draft-board-head-avatar"
                        />
                      ) : (
                        <span className="draft-board-head-avatar-ph" />
                      )}
                      <span className="draft-board-colname truncate" title={col.team?.name || col.userId || ''}>
                        {col.team?.name || 'Team'}
                      </span>
                    </div>
                  ))}

                  {Array.from({ length: grid.maxRound }, (_, i) => i + 1).map((round) => (
                    <React.Fragment key={round}>
                      <div className="draft-board-rd-label">{round}</div>
                      {grid.columns.map((col) => {
                        const pick = grid.getPick(round, col.slot);
                        const { name, pos, team: nfl } = formatPickPlayer(pick);
                        const posTint = pick ? draftPosTintClass(pos) : '';
                        return (
                          <div key={`${round}-${col.slot}`} className={'draft-board-cell' + posTint}>
                            {pick ? (
                              <>
                                <div className="draft-board-player truncate" title={name}>
                                  {name}
                                </div>
                                <div className="dim draft-board-cell-meta truncate">
                                  {[pos, nfl].filter(Boolean).join(' · ') || '—'}
                                </div>
                              </>
                            ) : (
                              <span className="dim">—</span>
                            )}
                          </div>
                        );
                      })}
                    </React.Fragment>
                  ))}
                </div>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
