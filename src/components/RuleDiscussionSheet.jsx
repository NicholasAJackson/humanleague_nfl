import React, { useCallback, useEffect, useRef, useState } from 'react';
import BottomSheet from './BottomSheet.jsx';
import { getVoterToken } from '../lib/voter.js';
import './RuleDiscussionSheet.css';

export default function RuleDiscussionSheet({ rule, onClose, onPostCount, readOnly = false }) {
  const onPostCountRef = useRef(onPostCount);
  onPostCountRef.current = onPostCount;

  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [sending, setSending] = useState(false);
  const [body, setBody] = useState('');
  const [author, setAuthor] = useState(() => {
    try {
      return localStorage.getItem('voter:name') || '';
    } catch {
      return '';
    }
  });

  const load = useCallback(async () => {
    if (!rule?.id) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/rule-posts?rule_id=${encodeURIComponent(rule.id)}`, {
        credentials: 'include',
        headers: { 'X-Poster-Token': getVoterToken() },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `Failed (${res.status})`);
      }
      const list = data.posts || [];
      setPosts(list);
      setNotice(typeof data.notice === 'string' && data.notice.length > 0 ? data.notice : null);
      onPostCountRef.current?.(rule.id, list.length);
    } catch (e) {
      setError(e.message || 'Could not load discussion');
      setPosts([]);
    } finally {
      setLoading(false);
    }
  }, [rule?.id]);

  useEffect(() => {
    load();
  }, [load]);

  async function sendPost(e) {
    e.preventDefault();
    if (readOnly) return;
    const text = body.trim();
    if (text.length < 1) return;
    setSending(true);
    setError(null);
    try {
      try {
        localStorage.setItem('voter:name', author.trim());
      } catch {}
      const res = await fetch('/api/rule-posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          rule_id: rule.id,
          body: text,
          author: author.trim() || null,
          poster_token: getVoterToken(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not post');
      const p = data.post;
      if (p) {
        setPosts((prev) => {
          const next = [...prev, p];
          onPostCountRef.current?.(rule.id, next.length);
          return next;
        });
      }
      setBody('');
    } catch (e) {
      setError(e.message || 'Could not post');
    } finally {
      setSending(false);
    }
  }

  async function removePost(post) {
    if (!(post.mine === true || post.mine === 't')) return;
    setError(null);
    try {
      const res = await fetch('/api/rule-posts', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ id: post.id, poster_token: getVoterToken() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not delete');
      setPosts((prev) => {
        const next = prev.filter((x) => x.id !== post.id);
        onPostCountRef.current?.(rule.id, next.length);
        return next;
      });
    } catch (e) {
      setError(e.message || 'Could not delete');
    }
  }

  const shortTitle =
    rule.title.length > 48 ? `${rule.title.slice(0, 46)}…` : rule.title;
  const title = `Discussion · ${shortTitle}`;

  return (
    <BottomSheet open={true} title={title} onClose={onClose}>
      <p className="muted rule-discuss-lead" style={{ marginTop: 0 }}>
        {readOnly
          ? 'Read-only — the window for rule changes has closed.'
          : 'Thread for this rule suggestion. Oldest first.'}
      </p>

      {loading && <p className="muted">Loading…</p>}
      {error && !loading && (
        <p className="rule-discuss-err" role="alert">
          {error}
        </p>
      )}

      {notice && !loading && (
        <p className="rule-discuss-notice" role="status">
          {notice}
        </p>
      )}

      {!loading && posts.length === 0 && !error && !notice && (
        <p className="muted">No messages yet. Start the thread below.</p>
      )}

      <ul className="rule-thread">
        {posts.map((p) => (
          <li key={p.id} className="rule-thread-item">
            <div className="rule-thread-meta">
              <span className="dim">{formatWhen(p.created_at)}</span>
              {p.author ? <span className="rule-thread-author">{p.author}</span> : <span className="dim">Anon</span>}
              {!readOnly && (p.mine === true || p.mine === 't') && (
                <button type="button" className="btn btn-ghost rule-thread-del" onClick={() => removePost(p)}>
                  Delete
                </button>
              )}
            </div>
            <div className="rule-thread-body">{p.body}</div>
          </li>
        ))}
      </ul>

      {!readOnly && (
      <form className="rule-discuss-compose" onSubmit={sendPost} aria-disabled={Boolean(notice)}>
        <label>
          <span className="dim">Message</span>
          <textarea
            rows={3}
            maxLength={2000}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Thoughts, questions, counterpoints…"
            disabled={sending || Boolean(notice)}
            required
          />
        </label>
        <label>
          <span className="dim">Your name (optional)</span>
          <input
            maxLength={60}
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            disabled={sending || Boolean(notice)}
            autoComplete="given-name"
          />
        </label>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={sending || Boolean(notice) || body.trim().length < 1}
        >
          {sending ? 'Sending…' : 'Post message'}
        </button>
      </form>
      )}
    </BottomSheet>
  );
}

function formatWhen(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}
