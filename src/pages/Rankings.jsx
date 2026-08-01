import React, { useEffect, useMemo, useState } from 'react';
import { config, leagueFormat } from '../config.js';
import { resolveLeagueHistoryChain, fetchRosters, fetchUsers } from '../lib/sleeper.js';
import {
  findLatestSeasonWithSnakePicks,
  buildDraftSlotByPlayerId,
} from '../lib/drafts.js';
import {
  rosterPlayerIdSet,
  mergeKeeperDraftVsEcr,
  buildRosterPlayerToOwnerMap,
} from '../lib/keeperRankings.js';
import './Rankings.css';

const VIEW_OPTIONS = [
  { value: 'redraft', label: 'Redraft rankings' },
  { value: 'fp-ecr', label: 'FP live ECR (Half-PPR)' },
  { value: 'sleeper-adp', label: 'Sleeper ADP (Half-PPR)' },
  { value: 'keeper', label: 'Keeper: draft vs consensus' },
];

/** Map UI view → /api/rankings?page_type= (keeper always uses DynastyProcess redraft). */
function pageTypeForView(view) {
  if (view === 'fp-ecr') return 'fp-ecr-half';
  if (view === 'sleeper-adp') return 'sleeper-adp-half';
  return 'redraft-overall';
}

/** League uses 1 QB + flex — no kickers in filters or UX. */
const POSITION_FILTERS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'DST'];

function exportCsv(filename, headers, rows) {
  const escape = (v) => {
    const s = v == null ? '' : String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  const lines = [headers.map(escape).join(','), ...rows.map((r) => r.map(escape).join(','))];
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function formatScrapeDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function ageInDays(iso) {
  if (!iso) return null;
  const d = Date.parse(iso);
  if (!Number.isFinite(d)) return null;
  return Math.floor((Date.now() - d) / 86400000);
}

function fmtNum(n, digits = 1) {
  if (n == null || !Number.isFinite(n)) return '—';
  return Number(n).toFixed(digits);
}

function buildManagerSelectOptions(users) {
  if (!Array.isArray(users)) return [];
  return users
    .filter((u) => u.user_id)
    .map((u) => ({
      id: String(u.user_id),
      label: String(u.metadata?.team_name || u.display_name || u.user_id || '').trim() || String(u.user_id),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function isBlankNum(v) {
  return v == null || (typeof v === 'number' && !Number.isFinite(v));
}

/** Missing numbers sort last for both ascending and descending. */
function cmpNumNullableLast(va, vb, asc) {
  const aN = isBlankNum(va);
  const bN = isBlankNum(vb);
  if (aN && bN) return 0;
  if (aN) return 1;
  if (bN) return -1;
  const d = Number(va) - Number(vb);
  return asc ? d : -d;
}

function cmpStr(va, vb, asc) {
  const d = String(va ?? '').localeCompare(String(vb ?? ''), undefined, { sensitivity: 'base' });
  return asc ? d : -d;
}

function compareRedraftRows(a, b, key, asc) {
  switch (key) {
    case 'ecr':
      return cmpNumNullableLast(a.ecr, b.ecr, asc);
    case 'name':
      return cmpStr(a.name, b.name, asc);
    case 'pos':
      return cmpStr(a.pos, b.pos, asc);
    case 'team':
      return cmpStr(a.team, b.team, asc);
    case 'bye':
      return cmpNumNullableLast(a.bye, b.bye, asc);
    case 'sd':
      return cmpNumNullableLast(a.sd, b.sd, asc);
    case 'best': {
      let c = cmpNumNullableLast(a.best, b.best, asc);
      if (c !== 0) return c;
      return cmpNumNullableLast(a.worst, b.worst, asc);
    }
    case 'owned':
      return cmpNumNullableLast(a.owned_avg, b.owned_avg, asc);
    default:
      return 0;
  }
}

function compareKeeperRows(a, b, key, asc) {
  switch (key) {
    case 'name':
      return cmpStr(a.name, b.name, asc);
    case 'pos':
      return cmpStr(a.pos, b.pos, asc);
    case 'team':
      return cmpStr(a.team, b.team, asc);
    case 'manager':
      return cmpStr(a.manager_label, b.manager_label, asc);
    case 'draft_pick_overall':
      return cmpNumNullableLast(a.draft_pick_overall, b.draft_pick_overall, asc);
    case 'round_lost':
      return cmpNumNullableLast(a.round_lost, b.round_lost, asc);
    case 'ecr':
      return cmpNumNullableLast(a.ecr, b.ecr, asc);
    case 'ecr_implied_round':
      return cmpNumNullableLast(a.ecr_implied_round, b.ecr_implied_round, asc);
    case 'keeper_delta':
      return cmpNumNullableLast(a.keeper_delta, b.keeper_delta, asc);
    default:
      return 0;
  }
}

/** Default keeper table: startup draft order (low pick # first); undrafted/nulls sort last. */
const KEEPER_DEFAULT_SORT = { key: 'draft_pick_overall', dir: 'asc' };

function SortTh({ sortKey, sortState, onSort, alignEnd, title, className, children }) {
  const active = sortState?.key === sortKey;
  const dir = active ? sortState.dir : null;
  return (
    <th
      className={className}
      title={title}
      scope="col"
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}
    >
      <button
        type="button"
        className={
          'rankings-th-sort' +
          (alignEnd ? ' rankings-th-sort--end' : '') +
          (active ? ' rankings-th-sort--active' : '')
        }
        onClick={() => onSort(sortKey)}
      >
        <span>{children}</span>
        <span className="rankings-sort-flag" aria-hidden>
          {active ? (dir === 'asc' ? '↑' : '↓') : '↕'}
        </span>
      </button>
    </th>
  );
}

export default function Rankings() {
  const [view, setView] = useState('redraft');
  const [position, setPosition] = useState('ALL');
  const [managerFilter, setManagerFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [redraftSort, setRedraftSort] = useState(null);
  const [keeperSort, setKeeperSort] = useState(KEEPER_DEFAULT_SORT);
  const [ecr, setEcr] = useState({ status: 'loading' });
  const [keeper, setKeeper] = useState({ status: 'idle' });

  useEffect(() => {
    let cancelled = false;
    const pageType = pageTypeForView(view);
    setEcr({ status: 'loading' });
    setRedraftSort(null);
    fetch(`/api/rankings?page_type=${encodeURIComponent(pageType)}`, { credentials: 'include' })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        return data;
      })
      .then((data) => {
        if (!cancelled) setEcr({ status: 'ready', data });
      })
      .catch((err) => {
        if (!cancelled) setEcr({ status: 'error', message: err.message || String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [view]);

  useEffect(() => {
    if (view !== 'keeper') return;
    if (!config.leagueId) {
      setKeeper({ status: 'no-league' });
      return;
    }
    if (ecr.status !== 'ready') return;
    // Keeper always compares against DynastyProcess redraft, never live FP lists.
    if (ecr.data.page_type !== 'redraft-overall') return;

    const ecrPlayers = ecr.data.players;
    let cancelled = false;
    setKeeper({ status: 'loading' });

    (async () => {
      try {
        const chain = await resolveLeagueHistoryChain(config.leagueId);
        const hit = await findLatestSeasonWithSnakePicks(chain);
        if (cancelled) return;
        if (!hit) {
          setKeeper({
            status: 'no-draft',
            message: 'No completed draft found in linked league seasons yet.',
          });
          return;
        }
        const draftBy = buildDraftSlotByPlayerId(hit.board.picks);
        const [rosters, users] = await Promise.all([
          fetchRosters(hit.leagueId),
          fetchUsers(hit.leagueId),
        ]);
        if (cancelled) return;
        const rosterIds = rosterPlayerIdSet(rosters);
        const playerToOwner = buildRosterPlayerToOwnerMap(rosters);
        const managerOptions = buildManagerSelectOptions(users);
        const labelByOwnerId = new Map(managerOptions.map((m) => [m.id, m.label]));
        const rawRows = mergeKeeperDraftVsEcr(
          ecrPlayers,
          rosterIds,
          draftBy,
          leagueFormat,
          playerToOwner,
        );
        const rows = rawRows.map((r) => ({
          ...r,
          manager_label:
            r.owner_id != null ? labelByOwnerId.get(String(r.owner_id)) || String(r.owner_id) : '—',
        }));
        setKeeper({
          status: 'ready',
          season: String(hit.season),
          leagueName: hit.name || '',
          draftLabel: hit.board.draftLabel || '',
          sourceLeagueId: hit.leagueId,
          managerOptions,
          rows,
        });
      } catch (e) {
        if (!cancelled) setKeeper({ status: 'error', message: e.message || String(e) });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [view, ecr.status, ecr.data, config.leagueId]);

  useEffect(() => {
    setManagerFilter('ALL');
    setKeeperSort(KEEPER_DEFAULT_SORT);
  }, [keeper.status, keeper.sourceLeagueId]);

  const redraftFiltered = useMemo(() => {
    if (ecr.status !== 'ready') return [];
    const term = search.trim().toLowerCase();
    return ecr.data.players.filter((p) => {
      if (position === 'ALL' && p.pos === 'K') return false;
      if (position !== 'ALL' && p.pos !== position) return false;
      if (term && !p.name.toLowerCase().includes(term) && !p.team.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [ecr, search, position]);

  const keeperFiltered = useMemo(() => {
    if (keeper.status !== 'ready') return [];
    const term = search.trim().toLowerCase();
    return keeper.rows.filter((p) => {
      if (managerFilter !== 'ALL' && String(p.owner_id || '') !== managerFilter) return false;
      if (position === 'ALL' && p.pos === 'K') return false;
      if (position !== 'ALL' && p.pos !== position) return false;
      if (term && !p.name.toLowerCase().includes(term) && !p.team.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [keeper, search, position, managerFilter]);

  const toggleRedraftSort = (key) => {
    setRedraftSort((prev) =>
      prev?.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' },
    );
  };

  const toggleKeeperSort = (key) => {
    setKeeperSort((prev) =>
      prev?.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' },
    );
  };

  const redraftSorted = useMemo(() => {
    if (!redraftSort) return redraftFiltered;
    const { key, dir } = redraftSort;
    const asc = dir === 'asc';
    const rows = [...redraftFiltered];
    rows.sort((a, b) => {
      const c = compareRedraftRows(a, b, key, asc);
      if (c !== 0) return c;
      return cmpNumNullableLast(a.ecr, b.ecr, true);
    });
    return rows;
  }, [redraftFiltered, redraftSort]);

  const keeperSorted = useMemo(() => {
    const { key, dir } = keeperSort;
    const asc = dir === 'asc';
    const rows = [...keeperFiltered];
    rows.sort((a, b) => {
      const c = compareKeeperRows(a, b, key, asc);
      if (c !== 0) return c;
      return cmpNumNullableLast(a.draft_pick_overall, b.draft_pick_overall, true);
    });
    return rows;
  }, [keeperFiltered, keeperSort]);

  const handleExportRedraft = () => {
    const rankHeader = view === 'sleeper-adp' ? 'ADP' : 'ECR';
    const headers = [rankHeader, 'Player', 'Pos', 'Team', 'Bye', 'SD', 'Best', 'Worst', 'Owned%'];
    const rows = redraftSorted.map((p) => [
      p.ecr ?? '',
      p.name ?? '',
      p.pos ?? '',
      p.team ?? '',
      p.bye ?? '',
      p.sd != null && Number.isFinite(Number(p.sd)) ? Number(p.sd).toFixed(1) : '',
      p.best ?? '',
      p.worst ?? '',
      p.owned_avg != null ? Math.round(p.owned_avg) : '',
    ]);
    const filename =
      view === 'sleeper-adp'
        ? 'sleeper-adp-half-ppr.csv'
        : view === 'fp-ecr'
          ? 'fp-ecr-half-ppr.csv'
          : 'redraft-rankings.csv';
    exportCsv(filename, headers, rows);
  };

  const handleExportKeeper = () => {
    const season = keeper.season || '';
    const headers = [
      `Pick ${season}`,
      'Player',
      'Pos',
      'Team',
      'RD Cost',
      'RD ECR',
      'ECR',
      'Delta',
      'Manager',
    ];
    const rows = keeperSorted.map((p) => [
      p.draft_pick_overall ?? '',
      p.name ?? '',
      p.pos ?? '',
      p.team ?? '',
      p.round_lost ?? '',
      p.ecr_implied_round ?? '',
      p.ecr ?? '',
      p.keeper_delta != null ? Number(p.keeper_delta).toFixed(1) : '',
      p.manager_label ?? '',
    ]);
    exportCsv('keeper-rankings.csv', headers, rows);
  };

  const isKeeperView = view === 'keeper';
  const isFpLiveView = view === 'fp-ecr';
  const isSleeperAdpView = view === 'sleeper-adp';
  const isListView = !isKeeperView;
  const rankColLabel = isSleeperAdpView ? 'ADP' : 'ECR';
  const ageDays = ecr.status === 'ready' ? ageInDays(ecr.data.scrape_date) : null;
  const isStale = ageDays != null && ageDays > 14;

  const keeperWaiting =
    isKeeperView &&
    ecr.status === 'ready' &&
    (keeper.status === 'loading' || keeper.status === 'idle');

  const showKeeperSkeleton = isKeeperView && (ecr.status === 'loading' || keeperWaiting);

  return (
    <div className="page rankings-page">
      <header className="page-header">
        <span className="eyebrow">Draft prep</span>
        <h1>Expert rankings</h1>
        {ecr.status === 'ready' && isListView && ecr.data.source === 'fantasypros' && (
          <p className="rankings-source">
            FantasyPros API · Half-PPR · redraft ECR
            {ecr.data.scrape_date && (
              <>
                {' · '}as of <strong>{formatScrapeDate(ecr.data.scrape_date)}</strong>
              </>
            )}
          </p>
        )}
        {ecr.status === 'ready' && isListView && ecr.data.source === 'sleeper' && (
          <p className="rankings-source">
            Sleeper platform ADP · Half-PPR
            {ecr.data.scrape_date && (
              <>
                {' · '}as of <strong>{formatScrapeDate(ecr.data.scrape_date)}</strong>
              </>
            )}
          </p>
        )}
        {ecr.status === 'ready' && (view === 'redraft' || isKeeperView) && ecr.data.source !== 'fantasypros' && ecr.data.source !== 'sleeper' && (
          <p className="rankings-source">
            FantasyPros Expert Consensus (redraft overall), via{' '}
            <a href="https://github.com/dynastyprocess/data" target="_blank" rel="noreferrer">
              DynastyProcess
            </a>
            {ecr.data.scrape_date && (
              <>
                {' · '}as of <strong>{formatScrapeDate(ecr.data.scrape_date)}</strong>
                {ageDays != null && ageDays > 0 && (
                  <span className={isStale ? 'rankings-source__stale' : ''}>
                    {' '}
                    ({ageDays} day{ageDays === 1 ? '' : 's'} old{isStale ? ' — may be stale' : ''})
                  </span>
                )}
              </>
            )}
          </p>
        )}
        {isKeeperView && keeper.status === 'ready' && (
          <p className="rankings-keeper-rules muted">
            Keeper cost: lose the pick in the round they were drafted (
            {leagueFormat.teamCount} teams, {leagueFormat.draftRounds} rounds). Undrafted roster adds =
            round {leagueFormat.undraftedKeeperRound}. ECR = Expert Consensus Rank. Delta = overall 2025 pick minus redraft ECR
          </p>
        )}
      </header>

      <section className="card rankings-controls">
        <label className="rankings-control">
          <span className="rankings-control__label">View</span>
          <select value={view} onChange={(e) => setView(e.target.value)}>
            {VIEW_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {isKeeperView && keeper.managerOptions?.length > 0 && (
          <label className="rankings-control rankings-control--manager">
            <span className="rankings-control__label">Manager</span>
            <select value={managerFilter} onChange={(e) => setManagerFilter(e.target.value)}>
              <option value="ALL">All managers</option>
              {keeper.managerOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="rankings-control rankings-control--pills">
          <span className="rankings-control__label">Position</span>
          <div className="rankings-pills" role="tablist" aria-label="Filter by position">
            {POSITION_FILTERS.map((p) => (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={position === p}
                className={'rankings-pill' + (position === p ? ' rankings-pill--active' : '')}
                onClick={() => setPosition(p)}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        <label className="rankings-control rankings-control--search">
          <span className="rankings-control__label">Search</span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name or team (e.g. Kelce, KC)"
            inputMode="search"
            enterKeyHint="search"
          />
        </label>
      </section>

      {!isKeeperView && ecr.status === 'loading' && (
        <div className="card" aria-busy="true">
          <div className="skeleton" style={{ height: 18, width: '40%', marginBottom: 12 }} />
          <div className="skeleton" style={{ height: 280, width: '100%' }} />
        </div>
      )}

      {isKeeperView && showKeeperSkeleton && (
        <div className="card" aria-busy="true">
          <div className="skeleton" style={{ height: 18, width: '55%', marginBottom: 12 }} />
          <div className="skeleton" style={{ height: 280, width: '100%' }} />
        </div>
      )}

      {ecr.status === 'error' && (
        <div className="card rankings-error" role="alert">
          <p>
            <strong>Could not load rankings.</strong> {ecr.message}
          </p>
          {isFpLiveView ? (
            <p className="muted">
              Live FantasyPros views need <code>FANTASYPROS_API_KEY</code> set on the server (Vercel
              env or local <code>.env</code>). DynastyProcess redraft still works without it.
            </p>
          ) : isSleeperAdpView ? (
            <p className="muted">
              Sleeper ADP is loaded from Sleeper&apos;s projections feed. Try again in a minute.
            </p>
          ) : (
            <p className="muted">
              The upstream data is mirrored on GitHub and refreshes weekly. Try again in a minute, or
              check{' '}
              <a
                href="https://github.com/dynastyprocess/data/actions"
                target="_blank"
                rel="noreferrer"
              >
                the upstream pipeline
              </a>
              .
            </p>
          )}
        </div>
      )}

      {isKeeperView && keeper.status === 'no-league' && (
        <div className="card rankings-error" role="status">
          <p className="muted">Set VITE_SLEEPER_LEAGUE_ID to use keeper draft comparison.</p>
        </div>
      )}

      {isKeeperView && keeper.status === 'no-draft' && (
        <div className="card rankings-error" role="status">
          <p>{keeper.message}</p>
        </div>
      )}

      {isKeeperView && keeper.status === 'error' && (
        <div className="card rankings-error" role="alert">
          <p>
            <strong>Could not load draft data.</strong> {keeper.message}
          </p>
        </div>
      )}

      {!isKeeperView && ecr.status === 'ready' && (
        <section className="card rankings-table-card">
          <div className="rankings-meta">
            <span>
              <strong>{redraftFiltered.length.toLocaleString()}</strong>
              {redraftFiltered.length === ecr.data.count
                ? ' players'
                : ` of ${ecr.data.count.toLocaleString()} players`}
            </span>
            <button
              type="button"
              className="rankings-export-btn"
              onClick={handleExportRedraft}
              disabled={redraftSorted.length === 0}
              title="Download current view as CSV"
            >
              Export CSV
            </button>
          </div>

          {redraftFiltered.length === 0 && (
            <p className="muted rankings-empty">No players match the current filters.</p>
          )}

          {redraftFiltered.length > 0 && (
            <div className="scroll-x">
              <table className="rankings-table">
                <thead>
                  <tr>
                    <SortTh
                      sortKey="ecr"
                      sortState={redraftSort}
                      onSort={toggleRedraftSort}
                      className="rankings-th rankings-th--rank rankings-th--sortable"
                      title={
                        isSleeperAdpView
                          ? 'Sleeper average draft position (Half-PPR)'
                          : 'Expert consensus rank'
                      }
                    >
                      {rankColLabel}
                    </SortTh>
                    <SortTh
                      sortKey="name"
                      sortState={redraftSort}
                      onSort={toggleRedraftSort}
                      className="rankings-th rankings-th--sortable"
                    >
                      Player
                    </SortTh>
                    <SortTh
                      sortKey="pos"
                      sortState={redraftSort}
                      onSort={toggleRedraftSort}
                      alignEnd
                      className="rankings-th rankings-th--num rankings-th--sortable"
                    >
                      Pos
                    </SortTh>
                    <SortTh
                      sortKey="team"
                      sortState={redraftSort}
                      onSort={toggleRedraftSort}
                      alignEnd
                      className="rankings-th rankings-th--num rankings-th--sortable"
                    >
                      Team
                    </SortTh>
                    <SortTh
                      sortKey="bye"
                      sortState={redraftSort}
                      onSort={toggleRedraftSort}
                      alignEnd
                      className="rankings-th rankings-th--num rankings-th--sortable"
                      title="Bye week"
                    >
                      Bye
                    </SortTh>
                    <SortTh
                      sortKey="sd"
                      sortState={redraftSort}
                      onSort={toggleRedraftSort}
                      alignEnd
                      className="rankings-th rankings-th--num rankings-th--sortable"
                      title="Standard deviation across experts (lower = more agreement)"
                    >
                      SD
                    </SortTh>
                    <SortTh
                      sortKey="best"
                      sortState={redraftSort}
                      onSort={toggleRedraftSort}
                      alignEnd
                      className="rankings-th rankings-th--num rankings-th--sortable"
                      title="Best / worst expert rank"
                    >
                      Best / Worst
                    </SortTh>
                    <SortTh
                      sortKey="owned"
                      sortState={redraftSort}
                      onSort={toggleRedraftSort}
                      alignEnd
                      className="rankings-th rankings-th--num rankings-th--sortable"
                      title="% of leagues that have this player rostered"
                    >
                      Owned
                    </SortTh>
                  </tr>
                </thead>
                <tbody>
                  {redraftSorted.map((p) => (
                    <tr
                      key={p.sleeper_id || p.fp_id || `${p.name}-${p.pos}`}
                      className="rankings-row"
                    >
                      <td className="rankings-td rankings-td--rank">
                        <span className="rankings-rank">
                          {isSleeperAdpView ? fmtNum(p.ecr, 1) : p.ecr}
                        </span>
                      </td>
                      <td className="rankings-td">
                        <span className="rankings-name">{p.name || '—'}</span>
                      </td>
                      <td className="rankings-td rankings-td--num">
                        <span className={`rankings-pos rankings-pos--${(p.pos || '').toLowerCase()}`}>
                          {p.pos || '—'}
                        </span>
                      </td>
                      <td className="rankings-td rankings-td--num rankings-td--team">{p.team || '—'}</td>
                      <td className="rankings-td rankings-td--num">{p.bye ?? '—'}</td>
                      <td className="rankings-td rankings-td--num">{fmtNum(p.sd, 1)}</td>
                      <td className="rankings-td rankings-td--num">
                        {p.best != null && p.worst != null ? `${p.best} / ${p.worst}` : '—'}
                      </td>
                      <td className="rankings-td rankings-td--num">
                        {p.owned_avg != null ? `${Math.round(p.owned_avg)}%` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {isKeeperView && keeper.status === 'ready' && !showKeeperSkeleton && (
        <section className="card rankings-table-card">
          <div className="rankings-meta">
            <span>
              <strong>{keeperFiltered.length.toLocaleString()}</strong>
              {keeperFiltered.length === keeper.rows.length
                ? ' rostered players'
                : ` of ${keeper.rows.length.toLocaleString()} rostered players`}
            </span>
            <div className="rankings-meta__right">
              {keeper.draftLabel && (
                <span className="dim" style={{ fontSize: 13 }}>
                  Draft: {keeper.draftLabel}
                </span>
              )}
              <button
                type="button"
                className="rankings-export-btn"
                onClick={handleExportKeeper}
                disabled={keeperSorted.length === 0}
                title="Download current view as CSV"
              >
                Export CSV
              </button>
            </div>
          </div>

          {keeperFiltered.length === 0 && (
            <p className="muted rankings-empty">No players match the current filters.</p>
          )}

          {keeperFiltered.length > 0 && (
            <div className="scroll-x">
              <table className="rankings-table">
                <thead>
                  <tr>
                    <SortTh
                      sortKey="draft_pick_overall"
                      sortState={keeperSort}
                      onSort={toggleKeeperSort}
                      alignEnd
                      className="rankings-th rankings-th--num rankings-th--sortable"
                      title={`Overall startup pick number (${keeper.season} draft)`}
                    >
                      PICK {keeper.season}
                    </SortTh>
                    <SortTh
                      sortKey="name"
                      sortState={keeperSort}
                      onSort={toggleKeeperSort}
                      className="rankings-th rankings-th--sortable"
                    >
                      Player
                    </SortTh>
                    <SortTh
                      sortKey="pos"
                      sortState={keeperSort}
                      onSort={toggleKeeperSort}
                      alignEnd
                      className="rankings-th rankings-th--num rankings-th--sortable"
                    >
                      Pos
                    </SortTh>
                    <SortTh
                      sortKey="team"
                      sortState={keeperSort}
                      onSort={toggleKeeperSort}
                      alignEnd
                      className="rankings-th rankings-th--num rankings-th--sortable"
                      title="NFL team"
                    >
                      Team
                    </SortTh>
                    <SortTh
                      sortKey="round_lost"
                      sortState={keeperSort}
                      onSort={toggleKeeperSort}
                      alignEnd
                      className="rankings-th rankings-th--num rankings-th--sortable"
                      title="Round pick lost if kept"
                    >
                      RD cost
                    </SortTh>
                    <SortTh
                      sortKey="ecr_implied_round"
                      sortState={keeperSort}
                      onSort={toggleKeeperSort}
                      alignEnd
                      className="rankings-th rankings-th--num rankings-th--sortable"
                      title={`If redraft rank were your overall pick in a ${leagueFormat.teamCount}-team draft, this is the round (ceil(rank ÷ ${leagueFormat.teamCount})); snake vs linear does not change round boundaries.`}
                    >
                      RD ECR
                    </SortTh>
                    <SortTh
                      sortKey="ecr"
                      sortState={keeperSort}
                      onSort={toggleKeeperSort}
                      alignEnd
                      className="rankings-th rankings-th--num rankings-th--sortable"
                    >
                      ECR
                    </SortTh>
                    <SortTh
                      sortKey="keeper_delta"
                      sortState={keeperSort}
                      onSort={toggleKeeperSort}
                      alignEnd
                      className="rankings-th rankings-th--num rankings-th--sortable"
                      title="Overall pick minus expert rank — higher means drafted later than experts slot them now"
                    >
                      Delta
                    </SortTh>
                    <SortTh
                      sortKey="manager"
                      sortState={keeperSort}
                      onSort={toggleKeeperSort}
                      className="rankings-th rankings-th--sortable"
                    >
                      Manager
                    </SortTh>
                  </tr>
                </thead>
                <tbody>
                  {keeperSorted.map((p) => (
                    <tr
                      key={p.fp_id || `${p.sleeper_id ?? ''}-${p.name}-${p.pos}`}
                      className="rankings-row"
                    >
                      <td className="rankings-td rankings-td--num">
                        {p.draft_pick_overall != null ? p.draft_pick_overall : '—'}
                      </td>
                      <td className="rankings-td">
                        <span className="rankings-name">{p.name || '—'}</span>
                      </td>
                      <td className="rankings-td rankings-td--num">
                        <span className={`rankings-pos rankings-pos--${(p.pos || '').toLowerCase()}`}>
                          {p.pos || '—'}
                        </span>
                      </td>
                      <td className="rankings-td rankings-td--num rankings-td--team">{p.team || '—'}</td>
                      <td className="rankings-td rankings-td--num">{p.round_lost}</td>
                      <td className="rankings-td rankings-td--num">
                        {p.ecr_implied_round != null ? p.ecr_implied_round : '—'}
                      </td>
                      <td className="rankings-td rankings-td--num">{p.ecr ?? '—'}</td>
                      <td
                        className={
                          'rankings-td rankings-td--num' +
                          (p.keeper_delta != null && p.keeper_delta > 0 ? ' rankings-td--delta-pos' : '')
                        }
                      >
                        {p.keeper_delta != null ? fmtNum(p.keeper_delta, 1) : '—'}
                      </td>
                      <td className="rankings-td rankings-td--manager">
                        <span className="truncate rankings-manager-name" title={p.manager_label}>
                          {p.manager_label || '—'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="rankings-footnote muted">
            Delta = overall 2025 pick minus redraft ECR (use as a directional riser/faller vs last year). Undrafted players use a mid–round{' '}
            {leagueFormat.undraftedKeeperRound} pick for Delta only.
          </p>
        </section>
      )}
    </div>
  );
}
