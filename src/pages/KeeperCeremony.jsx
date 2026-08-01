import React, { useCallback, useEffect, useMemo, useState } from 'react';
import BottomSheet from '../components/BottomSheet.jsx';
import Wheel from '../components/Wheel.jsx';
import { config } from '../config.js';
import { fetchUsers, getNflPlayersLookup } from '../lib/sleeper.js';
import './KeeperCeremony.css';

const HISTORY_KEY = 'keeper-ceremony:history';

function cryptoId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `id-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function playerLabel(id, text, lookup) {
  if (text) return text;
  if (!id) return null;
  const meta = lookup?.get(id);
  return meta ? `${meta.name} (${meta.position || '?'})` : id;
}

/** Latest nomination per manager that includes both K2 and K3. */
function buildCeremonyCandidates(nominations, nameByUserId, lookup) {
  const byUser = new Map();
  for (const n of nominations) {
    const uid = n.sleeper_user_id;
    if (!uid) continue;
    const prev = byUser.get(uid);
    if (!prev) {
      byUser.set(uid, n);
      continue;
    }
    const sa = Number(n.source_season);
    const sb = Number(prev.source_season);
    const na = Number.isFinite(sa) ? sa : Number.NEGATIVE_INFINITY;
    const nb = Number.isFinite(sb) ? sb : Number.NEGATIVE_INFINITY;
    if (na > nb) {
      byUser.set(uid, n);
      continue;
    }
    if (na === nb) {
      const ta = Date.parse(n.updated_at || n.submitted_at || '') || 0;
      const tb = Date.parse(prev.updated_at || prev.submitted_at || '') || 0;
      if (ta >= tb) byUser.set(uid, n);
    }
  }

  const out = [];
  for (const n of byUser.values()) {
    let k2Label;
    let k3Label;
    let k1Label;
    let k2Id = null;
    let k3Id = null;
    if (n.nomination_kind === 'freeform') {
      k1Label = n.k1_text || null;
      k2Label = n.k2_text || null;
      k3Label = n.k3_text || null;
    } else {
      k1Label = playerLabel(n.k1_player_id, null, lookup);
      k2Label = playerLabel(n.k2_player_id, null, lookup);
      k3Label = playerLabel(n.k3_player_id, null, lookup);
      k2Id = n.k2_player_id || null;
      k3Id = n.k3_player_id || null;
    }
    if (!k2Label || !k3Label) continue;
    out.push({
      nominationId: n.id,
      sleeperUserId: n.sleeper_user_id,
      sourceSeason: n.source_season,
      managerName: nameByUserId[n.sleeper_user_id] || n.sleeper_user_id,
      k1Label,
      k2: { id: k2Id || 'k2', name: k2Label, weight: 1, slot: 'k2' },
      k3: { id: k3Id || 'k3', name: k3Label, weight: 1, slot: 'k3' },
    });
  }

  out.sort((a, b) => a.managerName.localeCompare(b.managerName));
  return out;
}

export default function KeeperCeremony() {
  const [nameByUserId, setNameByUserId] = useState({});
  const [lookup, setLookup] = useState(null);
  const [nominations, setNominations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState(null);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [history, setHistory] = useState(loadHistory);
  const [result, setResult] = useState(null);

  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 50)));
    } catch {
      /* ignore quota */
    }
  }, [history]);

  useEffect(() => {
    if (!config.leagueId) return;
    let cancelled = false;
    fetchUsers(config.leagueId)
      .then((users) => {
        if (cancelled || !Array.isArray(users)) return;
        const m = {};
        for (const u of users) {
          m[u.user_id] = u.metadata?.team_name || u.display_name || u.user_id;
        }
        setNameByUserId(m);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

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

  const loadNominations = useCallback(async () => {
    setLoading(true);
    setLoadErr(null);
    try {
      const res = await fetch('/api/keeper-nominations', { credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Failed (${res.status})`);
      setNominations(data.nominations || []);
    } catch (e) {
      setNominations([]);
      setLoadErr(e.message || 'Could not load nominations');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadNominations();
  }, [loadNominations]);

  const candidates = useMemo(
    () => buildCeremonyCandidates(nominations, nameByUserId, lookup),
    [nominations, nameByUserId, lookup],
  );

  const selected = useMemo(
    () => candidates.find((c) => c.sleeperUserId === selectedUserId) || null,
    [candidates, selectedUserId],
  );

  const priorSpin = useMemo(() => {
    if (!selected) return null;
    return (
      history.find(
        (h) => h.sleeperUserId === selected.sleeperUserId && h.sourceSeason === selected.sourceSeason,
      ) || null
    );
  }, [history, selected]);

  const spunUserIds = useMemo(() => {
    const set = new Set();
    for (const h of history) {
      if (h.sourceSeason && candidates.some((c) => c.sourceSeason === h.sourceSeason && c.sleeperUserId === h.sleeperUserId)) {
        set.add(`${h.sleeperUserId}:${h.sourceSeason}`);
      }
    }
    return set;
  }, [history, candidates]);

  const wheelEntries = useMemo(() => {
    if (!selected) return [];
    return [selected.k2, selected.k3];
  }, [selected]);

  function handleResult(entry) {
    if (!selected || !entry) return;
    const loser = entry.slot === 'k2' ? selected.k3 : selected.k2;
    const record = {
      id: cryptoId(),
      sleeperUserId: selected.sleeperUserId,
      sourceSeason: selected.sourceSeason,
      managerName: selected.managerName,
      winnerName: entry.name,
      winnerSlot: entry.slot,
      loserName: loser?.name || '',
      k1Label: selected.k1Label,
      at: Date.now(),
    };
    setResult(record);
    setHistory((h) => {
      const without = h.filter(
        (x) => !(x.sleeperUserId === record.sleeperUserId && x.sourceSeason === record.sourceSeason),
      );
      return [record, ...without].slice(0, 50);
    });
  }

  function clearHistory() {
    if (!confirm('Clear all ceremony results saved on this device?')) return;
    setHistory([]);
  }

  if (!config.leagueId) {
    return (
      <div className="page">
        <p className="muted">Set VITE_SLEEPER_LEAGUE_ID to run the keeper ceremony.</p>
      </div>
    );
  }

  return (
    <div className="page ceremony-page">
      <header className="page-header">
        <span className="eyebrow">Commissioner</span>
        <h1>Keeper ceremony</h1>
        <p className="muted">
          Spin for managers who nominated both keeper 2 and 3. Results save on this device only.
        </p>
      </header>

      <section className="card ceremony-pick-card">
        <label className="ceremony-select-label">
          <span className="ceremony-label">Manager</span>
          <select
            value={selectedUserId}
            onChange={(e) => {
              setSelectedUserId(e.target.value);
              setResult(null);
            }}
            disabled={loading || candidates.length === 0}
          >
            <option value="">
              {loading ? 'Loading nominations…' : candidates.length === 0 ? 'No K2/K3 nominations' : 'Select a manager…'}
            </option>
            {candidates.map((c) => {
              const done = spunUserIds.has(`${c.sleeperUserId}:${c.sourceSeason}`);
              return (
                <option key={c.sleeperUserId} value={c.sleeperUserId}>
                  {done ? '✓ ' : ''}
                  {c.managerName} · {c.sourceSeason}
                </option>
              );
            })}
          </select>
        </label>

        {loadErr && <p className="ceremony-err">{loadErr}</p>}

        {!loading && candidates.length === 0 && !loadErr && (
          <p className="muted ceremony-empty">
            Nobody has nominated both keeper 2 and keeper 3 yet — only those managers need a coin flip.
          </p>
        )}

        {selected && (
          <div className="ceremony-context">
            <p className="ceremony-context__k1">
              <span className="ceremony-label">Keeper 1 (guaranteed)</span>
              <strong>{selected.k1Label || '—'}</strong>
            </p>
            <div className="ceremony-context__pair">
              <div>
                <span className="ceremony-label">Keeper 2</span>
                <strong>{selected.k2.name}</strong>
              </div>
              <div>
                <span className="ceremony-label">Keeper 3</span>
                <strong>{selected.k3.name}</strong>
              </div>
            </div>
            {priorSpin && (
              <p className="ceremony-prior" role="status">
                Already spun: <strong>{priorSpin.winnerName}</strong> won
                {priorSpin.at ? ` · ${new Date(priorSpin.at).toLocaleString()}` : ''}. Spin again to overwrite.
              </p>
            )}
          </div>
        )}
      </section>

      {selected && (
        <section className="ceremony-wheel-block" aria-label="K2 vs K3 spin">
          <Wheel key={selected.sleeperUserId} entries={wheelEntries} onResult={handleResult} />
        </section>
      )}

      {history.length > 0 && (
        <section className="card ceremony-history-card">
          <div className="ceremony-history-head">
            <h2 className="ceremony-history-title">Results</h2>
            <button type="button" className="btn btn-ghost" onClick={clearHistory}>
              Clear
            </button>
          </div>
          <ul className="ceremony-history">
            {history.map((h) => (
              <li key={h.id}>
                <div className="ceremony-history__main">
                  <span className="ceremony-history__manager">{h.managerName}</span>
                  <span className="ceremony-history__winner">{h.winnerName}</span>
                </div>
                <div className="ceremony-history__meta">
                  <span>beat {h.loserName}</span>
                  <span>{h.sourceSeason}</span>
                  <span>{h.at ? new Date(h.at).toLocaleString() : ''}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <BottomSheet
        open={!!result}
        onClose={() => setResult(null)}
        title="Second keeper"
        footer={
          <button type="button" className="btn btn-primary" onClick={() => setResult(null)}>
            Done
          </button>
        }
      >
        {result && (
          <div className="ceremony-winner">
            <p className="dim">{result.managerName}</p>
            <p className="ceremony-winner__name">{result.winnerName}</p>
            <p className="muted">
              Beats {result.loserName}
              {result.k1Label ? ` · keeps with ${result.k1Label}` : ''}
            </p>
          </div>
        )}
      </BottomSheet>
    </div>
  );
}
