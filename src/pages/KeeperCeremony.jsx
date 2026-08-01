import React, { useCallback, useEffect, useMemo, useState } from 'react';
import BottomSheet from '../components/BottomSheet.jsx';
import Wheel from '../components/Wheel.jsx';
import { config } from '../config.js';
import { fetchUsers, getNflPlayersLookup } from '../lib/sleeper.js';
import './KeeperCeremony.css';

function playerLabel(id, text, lookup) {
  if (text) return text;
  if (!id) return null;
  const meta = lookup?.get(id);
  return meta ? `${meta.name} (${meta.position || '?'})` : id;
}

function latestNominationPerUser(nominations) {
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
  return byUser;
}

/** Managers with K2 + K3 (need a ceremony flip). */
function buildCeremonyCandidates(nominations, nameByUserId, lookup) {
  const out = [];
  for (const n of latestNominationPerUser(nominations).values()) {
    let k1Label;
    let k2Label;
    let k3Label;
    let k1Id = null;
    let k2Id = null;
    let k3Id = null;
    let k1Text = null;
    let k2Text = null;
    let k3Text = null;
    if (n.nomination_kind === 'freeform') {
      k1Text = n.k1_text || null;
      k2Text = n.k2_text || null;
      k3Text = n.k3_text || null;
      k1Label = k1Text;
      k2Label = k2Text;
      k3Label = k3Text;
    } else {
      k1Id = n.k1_player_id || null;
      k2Id = n.k2_player_id || null;
      k3Id = n.k3_player_id || null;
      k1Label = playerLabel(k1Id, null, lookup);
      k2Label = playerLabel(k2Id, null, lookup);
      k3Label = playerLabel(k3Id, null, lookup);
    }
    if (!k1Label || !k2Label || !k3Label) continue;
    const sourceSeason = String(n.source_season);
    const carryInto = Number.isFinite(Number(sourceSeason))
      ? String(Number(sourceSeason) + 1)
      : '';
    out.push({
      nominationId: n.id,
      sleeperUserId: n.sleeper_user_id,
      sourceSeason,
      carryIntoSeason: carryInto,
      leagueIdSnapshot: n.league_id_snapshot || null,
      managerName: nameByUserId[n.sleeper_user_id] || n.sleeper_user_id,
      k1: { playerId: k1Id, text: k1Text, label: k1Label },
      k2: { id: k2Id || 'k2', playerId: k2Id, text: k2Text, name: k2Label, weight: 1, slot: 'k2' },
      k3: { id: k3Id || 'k3', playerId: k3Id, text: k3Text, name: k3Label, weight: 1, slot: 'k3' },
    });
  }
  out.sort((a, b) => a.managerName.localeCompare(b.managerName));
  return out;
}

function fmtFinalKeepers(row, lookup) {
  const k1 = playerLabel(row.k1_player_id, row.k1_text, lookup) || '—';
  const second = playerLabel(row.second_player_id, row.second_text, lookup);
  return second ? `${k1} · ${second}` : k1;
}

export default function KeeperCeremony() {
  const [nameByUserId, setNameByUserId] = useState({});
  const [lookup, setLookup] = useState(null);
  const [nominations, setNominations] = useState([]);
  const [finals, setFinals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState(null);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [chosenSlot, setChosenSlot] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState(null);
  const [saveMsg, setSaveMsg] = useState(null);
  const [result, setResult] = useState(null);

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

  const loadAll = useCallback(async () => {
    setLoading(true);
    setLoadErr(null);
    try {
      const [nomRes, finRes] = await Promise.all([
        fetch('/api/keeper-nominations', { credentials: 'include' }),
        fetch('/api/keeper-finals', { credentials: 'include' }),
      ]);
      const nomData = await nomRes.json().catch(() => ({}));
      const finData = await finRes.json().catch(() => ({}));
      if (!nomRes.ok) throw new Error(nomData.error || `Nominations failed (${nomRes.status})`);
      if (!finRes.ok) throw new Error(finData.error || `Finals failed (${finRes.status})`);
      setNominations(nomData.nominations || []);
      setFinals(finData.finals || []);
    } catch (e) {
      setNominations([]);
      setFinals([]);
      setLoadErr(e.message || 'Could not load ceremony data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const candidates = useMemo(
    () => buildCeremonyCandidates(nominations, nameByUserId, lookup),
    [nominations, nameByUserId, lookup],
  );

  const selected = useMemo(
    () => candidates.find((c) => c.sleeperUserId === selectedUserId) || null,
    [candidates, selectedUserId],
  );

  const lockedKeySet = useMemo(() => {
    const set = new Set();
    for (const f of finals) {
      set.add(`${f.sleeper_user_id}:${f.carry_into_season}`);
    }
    return set;
  }, [finals]);

  const existingFinal = useMemo(() => {
    if (!selected) return null;
    return (
      finals.find(
        (f) =>
          f.sleeper_user_id === selected.sleeperUserId &&
          f.carry_into_season === selected.carryIntoSeason,
      ) || null
    );
  }, [finals, selected]);

  const wheelEntries = useMemo(() => {
    if (!selected) return [];
    return [selected.k2, selected.k3];
  }, [selected]);

  function handleWheelResult(entry) {
    if (!entry?.slot) return;
    setChosenSlot(entry.slot);
    setSaveErr(null);
    setSaveMsg(null);
    setResult({
      managerName: selected?.managerName,
      winnerName: entry.name,
      slot: entry.slot,
      loserName: entry.slot === 'k2' ? selected?.k3.name : selected?.k2.name,
      k1Label: selected?.k1.label,
    });
  }

  async function lockIn() {
    if (!selected || !chosenSlot) {
      setSaveErr('Pick keeper 2 or 3 (spin the wheel or choose manually).');
      return;
    }
    const second = chosenSlot === 'k2' ? selected.k2 : selected.k3;
    setSaving(true);
    setSaveErr(null);
    setSaveMsg(null);
    try {
      const res = await fetch('/api/keeper-finals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          sleeper_user_id: selected.sleeperUserId,
          source_season: selected.sourceSeason,
          carry_into_season: selected.carryIntoSeason,
          league_id_snapshot: selected.leagueIdSnapshot,
          k1_player_id: selected.k1.playerId,
          k1_text: selected.k1.text,
          second_player_id: second.playerId,
          second_text: second.text || (second.playerId ? null : second.name),
          second_from_slot: chosenSlot,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setSaveMsg(`Locked in for ${selected.carryIntoSeason}: ${selected.k1.label} · ${second.name}`);
      setFinals((prev) => {
        const without = prev.filter(
          (f) =>
            !(
              f.sleeper_user_id === data.final.sleeper_user_id &&
              f.carry_into_season === data.final.carry_into_season
            ),
        );
        return [data.final, ...without];
      });
    } catch (e) {
      setSaveErr(e.message || 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  async function removeFinal(id) {
    if (!confirm('Remove this locked-in result from the database?')) return;
    try {
      const res = await fetch('/api/keeper-finals', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Delete failed');
      setFinals((prev) => prev.filter((f) => f.id !== id));
    } catch (e) {
      setSaveErr(e.message || 'Could not delete');
    }
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
          Spin or pick between K2 and K3, then lock the result into the database. Locked keepers appear on{' '}
          <strong>/keepers</strong> under “Locked in”.
        </p>
      </header>

      <section className="card ceremony-pick-card">
        <label className="ceremony-select-label">
          <span className="ceremony-label">Manager</span>
          <select
            value={selectedUserId}
            onChange={(e) => {
              setSelectedUserId(e.target.value);
              setChosenSlot('');
              setResult(null);
              setSaveErr(null);
              setSaveMsg(null);
            }}
            disabled={loading || candidates.length === 0}
          >
            <option value="">
              {loading
                ? 'Loading nominations…'
                : candidates.length === 0
                  ? 'No K2/K3 nominations'
                  : 'Select a manager…'}
            </option>
            {candidates.map((c) => {
              const done = lockedKeySet.has(`${c.sleeperUserId}:${c.carryIntoSeason}`);
              return (
                <option key={c.sleeperUserId} value={c.sleeperUserId}>
                  {done ? '✓ ' : ''}
                  {c.managerName} · into {c.carryIntoSeason}
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
              <strong>{selected.k1.label}</strong>
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

            <fieldset className="ceremony-slot-pick">
              <legend className="ceremony-label">Ceremony winner</legend>
              <label className="ceremony-radio">
                <input
                  type="radio"
                  name="ceremony-slot"
                  value="k2"
                  checked={chosenSlot === 'k2'}
                  onChange={() => setChosenSlot('k2')}
                />
                <span>K2 — {selected.k2.name}</span>
              </label>
              <label className="ceremony-radio">
                <input
                  type="radio"
                  name="ceremony-slot"
                  value="k3"
                  checked={chosenSlot === 'k3'}
                  onChange={() => setChosenSlot('k3')}
                />
                <span>K3 — {selected.k3.name}</span>
              </label>
            </fieldset>

            {existingFinal && (
              <p className="ceremony-prior" role="status">
                Already locked in DB:{' '}
                <strong>{fmtFinalKeepers(existingFinal, lookup)}</strong>
                {existingFinal.updated_at
                  ? ` · ${new Date(existingFinal.updated_at).toLocaleString()}`
                  : ''}
                . Saving again overwrites.
              </p>
            )}

            {saveErr && <p className="ceremony-err">{saveErr}</p>}
            {saveMsg && <p className="ceremony-ok">{saveMsg}</p>}

            <button
              type="button"
              className="btn btn-primary ceremony-lock-btn"
              disabled={saving || !chosenSlot}
              onClick={lockIn}
            >
              {saving ? 'Saving…' : `Lock in for ${selected.carryIntoSeason}`}
            </button>
          </div>
        )}
      </section>

      {selected && (
        <section className="ceremony-wheel-block" aria-label="K2 vs K3 spin">
          <p className="ceremony-wheel-hint muted">Optional: spin to choose, then lock in above.</p>
          <Wheel key={selected.sleeperUserId} entries={wheelEntries} onResult={handleWheelResult} />
        </section>
      )}

      {finals.length > 0 && (
        <section className="card ceremony-history-card">
          <div className="ceremony-history-head">
            <h2 className="ceremony-history-title">Locked in (database)</h2>
          </div>
          <ul className="ceremony-history">
            {finals.map((f) => (
              <li key={f.id}>
                <div className="ceremony-history__main">
                  <span className="ceremony-history__manager">
                    {nameByUserId[f.sleeper_user_id] || f.sleeper_user_id}
                  </span>
                  <span className="ceremony-history__winner">{fmtFinalKeepers(f, lookup)}</span>
                </div>
                <div className="ceremony-history__meta">
                  <span>Into {f.carry_into_season}</span>
                  {f.second_from_slot && <span>via {f.second_from_slot.toUpperCase()}</span>}
                  <span>{f.updated_at ? new Date(f.updated_at).toLocaleString() : ''}</span>
                  <button type="button" className="btn btn-ghost ceremony-history__remove" onClick={() => removeFinal(f.id)}>
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <BottomSheet
        open={!!result}
        onClose={() => setResult(null)}
        title="Wheel result"
        footer={
          <button type="button" className="btn btn-primary" onClick={() => setResult(null)}>
            Use this pick
          </button>
        }
      >
        {result && (
          <div className="ceremony-winner">
            <p className="dim">{result.managerName}</p>
            <p className="ceremony-winner__name">{result.winnerName}</p>
            <p className="muted">
              Beats {result.loserName}
              {result.k1Label ? ` · locks with ${result.k1Label}` : ''}
            </p>
            <p className="muted">Confirm with “Lock in” above to write to the database.</p>
          </div>
        )}
      </BottomSheet>
    </div>
  );
}
