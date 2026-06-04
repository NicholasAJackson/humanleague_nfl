import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import RuleCard from '../components/RuleCard.jsx';
import BottomSheet from '../components/BottomSheet.jsx';
import RuleDiscussionSheet from '../components/RuleDiscussionSheet.jsx';
import { useAuth } from '../AuthContext.jsx';
import { areRuleChangesClosed } from '../config.js';
import './Rules.css';

export default function Rules() {
  const navigate = useNavigate();
  const auth = useAuth();
  // Voting now requires a real member account (not just the shared site
  // password). Dev-bypass falls back to read-only.
  const canVote = Boolean(auth?.user?.username);
  const changesClosed = areRuleChangesClosed();

  const [rules, setRules] = useState(null);
  const [error, setError] = useState(null);
  const [showSheet, setShowSheet] = useState(false);
  const [discussionRule, setDiscussionRule] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [busyRule, setBusyRule] = useState(null);
  // Per-rule vote map driven entirely by the server response — one source of
  // truth per logged-in user, no localStorage mirror.
  const [myVotes, setMyVotes] = useState({});

  function applyRules(list) {
    setRules(list);
    const next = {};
    for (const r of list) {
      if (r.my_vote === 1 || r.my_vote === -1) next[r.id] = r.my_vote;
    }
    setMyVotes(next);
  }

  async function load() {
    try {
      const res = await fetch('/api/rules', { credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `Failed (${res.status})`);
      }
      applyRules(data.rules || []);
      setError(null);
    } catch (err) {
      setError(err.message || 'Could not load rules');
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function submitRule({ title, description }) {
    if (changesClosed) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ title, description }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed');
      setRules((list) => [data.rule, ...(list || [])]);
      setShowSheet(false);
    } catch (err) {
      alert(err.message || 'Could not submit rule');
    } finally {
      setSubmitting(false);
    }
  }

  async function vote(ruleId, value) {
    if (busyRule || changesClosed) return;
    if (!canVote) {
      alert('Sign in with your manager account to vote.');
      return;
    }
    const previousVote = myVotes[ruleId] || 0;
    const newVote = value;
    setBusyRule(ruleId);

    setRules((list) =>
      (list || []).map((r) => {
        if (r.id !== ruleId) return r;
        let up = r.up || 0;
        let down = r.down || 0;
        if (previousVote === 1) up -= 1;
        if (previousVote === -1) down -= 1;
        if (newVote === 1) up += 1;
        if (newVote === -1) down += 1;
        return { ...r, up, down };
      })
    );
    setMyVotes((m) => {
      const next = { ...m };
      if (newVote === 0) delete next[ruleId];
      else next[ruleId] = newVote;
      return next;
    });

    try {
      const res =
        newVote === 0
          ? await fetch('/api/votes', {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ rule_id: ruleId }),
            })
          : await fetch('/api/votes', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ rule_id: ruleId, value: newVote }),
            });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Vote failed');
      }
      const totals = await res.json();
      setRules((list) =>
        (list || []).map((r) =>
          r.id === ruleId ? { ...r, up: totals.up, down: totals.down } : r
        )
      );
    } catch (err) {
      load();
      setMyVotes((m) => {
        const next = { ...m };
        if (previousVote === 0) delete next[ruleId];
        else next[ruleId] = previousVote;
        return next;
      });
      alert(err.message || 'Could not record vote');
    } finally {
      setBusyRule(null);
    }
  }

  const syncPostCount = useCallback((ruleId, count) => {
    setRules((list) =>
      list ? list.map((r) => (r.id === ruleId ? { ...r, post_count: count } : r)) : list
    );
  }, []);

  const sorted = rules
    ? [...rules].sort(
        (a, b) =>
          (b.up - b.down) - (a.up - a.down) ||
          new Date(b.created_at) - new Date(a.created_at)
      )
    : null;

  return (
    <div className="page rules-page">
      {changesClosed && (
        <div
          className="rules-closed-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="rules-closed-title"
        >
          <button
            type="button"
            className="rules-closed-overlay__back"
            onClick={() => navigate(-1)}
            aria-label="Go back"
          >
            ← Back
          </button>
          <div className="rules-closed-overlay__panel">
            <h2 id="rules-closed-title" className="rules-closed-overlay__title">
              Rule changes closed
            </h2>
            <p className="rules-closed-overlay__body">
              The window for rule changes has now closed.
            </p>
          </div>
        </div>
      )}

      <header className="page-header">
        <span className="eyebrow">Vote on next season</span>
        <h1>Rule suggestions</h1>
        <p className="muted">
          {changesClosed
            ? 'Review what was suggested — voting and new suggestions are closed.'
            : 'Suggest a rule and vote on what should change.'}
        </p>
        {!canVote && auth?.ready && (
          <p className="dim" style={{ marginTop: 4 }}>
            Sign in with your manager account to cast a vote — you get one per rule.
          </p>
        )}
      </header>

      <div className="row">
        <button
          className="btn btn-primary"
          onClick={() => setShowSheet(true)}
          disabled={!canVote || changesClosed}
          title={
            changesClosed
              ? 'The window for rule changes has closed'
              : canVote
                ? ''
                : 'Sign in with your manager account to suggest a rule'
          }
        >
          Suggest a rule
        </button>
        <button className="btn btn-ghost" style={{ marginLeft: 'auto' }} onClick={load}>
          Refresh
        </button>
      </div>

      {error && (
        <div className="card">
          <h3>Could not load rules</h3>
          <p className="muted">{error}</p>
          <p className="dim">If you just deployed, make sure the database is initialised and DATABASE_URL is set.</p>
        </div>
      )}

      {!rules && !error && (
        <div className="card-grid">
          <div className="skeleton" style={{ height: 100 }} />
          <div className="skeleton" style={{ height: 100 }} />
          <div className="skeleton" style={{ height: 100 }} />
        </div>
      )}

      {sorted && sorted.length === 0 && (
        <div className="card empty">
          No rules yet. Be the first to suggest one!
        </div>
      )}

      {sorted && sorted.length > 0 && (
        <div className="card-grid">
          {sorted.map((rule) => (
            <RuleCard
              key={rule.id}
              rule={rule}
              myVote={myVotes[rule.id] || 0}
              busy={busyRule === rule.id || !canVote || changesClosed}
              onVote={vote}
              postCount={rule.post_count ?? 0}
              onDiscuss={changesClosed ? undefined : setDiscussionRule}
            />
          ))}
        </div>
      )}

      <BottomSheet
        open={showSheet}
        onClose={() => !submitting && setShowSheet(false)}
        title="Suggest a rule"
      >
        <SuggestForm
          onSubmit={submitRule}
          submitting={submitting}
          username={auth?.user?.username || null}
        />
      </BottomSheet>

      {discussionRule ? (
        <RuleDiscussionSheet
          key={discussionRule.id}
          rule={discussionRule}
          onClose={() => setDiscussionRule(null)}
          onPostCount={syncPostCount}
          readOnly={changesClosed}
        />
      ) : null}
    </div>
  );
}

function SuggestForm({ onSubmit, submitting, username }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  function submit(e) {
    e.preventDefault();
    if (!username) {
      alert('Sign in with your manager account to suggest a rule.');
      return;
    }
    if (title.trim().length < 3) {
      alert('Give it a title (at least 3 characters).');
      return;
    }
    onSubmit({ title: title.trim(), description: description.trim() });
  }

  return (
    <form onSubmit={submit} className="suggest-form">
      <p className="suggest-form__author dim">
        Posting as{' '}
        <strong>{username || 'guest'}</strong>
      </p>
      <label>
        <span className="dim">Title</span>
        <input
          autoFocus
          required
          maxLength={140}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Increase keepers to 2"
          enterKeyHint="next"
        />
      </label>
      <label>
        <span className="dim">Why? (optional)</span>
        <textarea
          rows="4"
          maxLength={2000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Add context, examples, or pros/cons."
        />
      </label>
      <button
        className="btn btn-primary"
        type="submit"
        disabled={submitting || !username}
        style={{ marginTop: 8 }}
      >
        {submitting ? 'Submitting…' : 'Submit suggestion'}
      </button>
      <style>{`
        .suggest-form { display: flex; flex-direction: column; gap: 12px; }
        .suggest-form label { display: flex; flex-direction: column; gap: 6px; }
        .suggest-form__author { margin: 0; }
      `}</style>
    </form>
  );
}
