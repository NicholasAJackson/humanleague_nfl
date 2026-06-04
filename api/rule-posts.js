import { getSql, rateLimit, clientIp, readJsonBody, send } from './_db.js';
import { assertSiteAuth } from './_auth.js';
import { isUndefinedRelation } from './_pgErrors.js';
import { areRuleChangesClosed, RULE_CHANGES_CLOSED_ERROR } from './_ruleChangesWindow.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseRuleId(req) {
  const q = req.query?.rule_id;
  if (q != null) {
    const v = Array.isArray(q) ? q[0] : q;
    if (typeof v === 'string' && v.length > 0) return v;
  }
  try {
    const pathAndQuery = (req.url || '/').split('?');
    const search = pathAndQuery.length > 1 ? pathAndQuery[1] : '';
    const u = new URL(`http://local/?${search}`);
    return u.searchParams.get('rule_id');
  } catch {
    return null;
  }
}

function posterHeader(req) {
  const raw = req.headers['x-poster-token'];
  if (typeof raw !== 'string' || raw.length < 8 || raw.length > 80) return null;
  return raw.trim();
}

export default async function handler(req, res) {
  try {
    if (!assertSiteAuth(req, res, send)) return;

    const sql = getSql();

    if (req.method === 'GET') {
      const ruleId = parseRuleId(req);
      if (!ruleId || !UUID_RE.test(ruleId)) {
        return send(res, 400, { error: 'rule_id query must be a valid UUID' });
      }

      const [rule] = await sql`select id from rules where id = ${ruleId} limit 1`;
      if (!rule) {
        return send(res, 404, { error: 'Rule not found' });
      }

      const viewer = posterHeader(req);
      let rows;
      try {
        rows = viewer
          ? await sql`
              select id, body, author, created_at, (poster_token = ${viewer}) as mine
              from rule_posts
              where rule_id = ${ruleId}
              order by created_at asc
            `
          : await sql`
              select id, body, author, created_at, false as mine
              from rule_posts
              where rule_id = ${ruleId}
              order by created_at asc
            `;
      } catch (e) {
        if (isUndefinedRelation(e, 'rule_posts')) {
          return send(res, 200, {
            posts: [],
            notice:
              'Discussion is not enabled on this database yet. Run db/schema.sql (includes rule_posts), then refresh.',
          });
        }
        throw e;
      }

      return send(res, 200, { posts: rows });
    }

    if (req.method === 'POST') {
      if (areRuleChangesClosed()) {
        return send(res, 403, { error: RULE_CHANGES_CLOSED_ERROR });
      }

      const ip = clientIp(req);
      if (!rateLimit(`rule-posts:${ip}`, { max: 24, windowMs: 60_000 })) {
        return send(res, 429, { error: 'Too many requests, slow down a sec.' });
      }

      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object') {
        return send(res, 400, { error: 'Invalid JSON body' });
      }

      const ruleId = String(body.rule_id || '').trim();
      if (!UUID_RE.test(ruleId)) {
        return send(res, 400, { error: 'rule_id must be a valid UUID' });
      }

      const text = String(body.body || '').trim();
      if (text.length < 1 || text.length > 2000) {
        return send(res, 400, { error: 'Message must be 1-2000 characters' });
      }

      const authorRaw = body.author == null ? null : String(body.author).trim();
      const author = authorRaw && authorRaw.length > 0 ? authorRaw.slice(0, 60) : null;

      const posterToken = String(body.poster_token || '').trim();
      if (posterToken.length < 8 || posterToken.length > 80) {
        return send(res, 400, { error: 'poster_token is required' });
      }

      const [exists] = await sql`select id from rules where id = ${ruleId} limit 1`;
      if (!exists) {
        return send(res, 404, { error: 'Rule not found' });
      }

      let post;
      try {
        const inserted = await sql`
          insert into rule_posts (rule_id, body, author, poster_token)
          values (${ruleId}, ${text}, ${author}, ${posterToken})
          returning id, body, author, created_at
        `;
        post = inserted[0];
      } catch (e) {
        if (isUndefinedRelation(e, 'rule_posts')) {
          return send(res, 503, {
            error:
              'Discussion tables are missing. Run db/schema.sql on this database, then try again.',
          });
        }
        throw e;
      }

      if (!post) {
        return send(res, 500, { error: 'Insert did not return a row' });
      }

      return send(res, 201, {
        post: { ...post, mine: true },
      });
    }

    if (req.method === 'DELETE') {
      const ip = clientIp(req);
      if (!rateLimit(`rule-posts-del:${ip}`, { max: 30, windowMs: 60_000 })) {
        return send(res, 429, { error: 'Too many requests, slow down a sec.' });
      }

      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object') {
        return send(res, 400, { error: 'Invalid JSON body' });
      }

      const id = String(body.id || '').trim();
      if (!UUID_RE.test(id)) {
        return send(res, 400, { error: 'id must be a valid UUID' });
      }

      const posterToken = String(body.poster_token || '').trim();
      if (posterToken.length < 8 || posterToken.length > 80) {
        return send(res, 400, { error: 'poster_token is required' });
      }

      let deleted;
      try {
        deleted = await sql`
          delete from rule_posts
          where id = ${id} and poster_token = ${posterToken}
          returning id
        `;
      } catch (e) {
        if (isUndefinedRelation(e, 'rule_posts')) {
          return send(res, 503, {
            error:
              'Discussion tables are missing. Run db/schema.sql on this database, then try again.',
          });
        }
        throw e;
      }
      if (!deleted.length) {
        return send(res, 404, { error: 'Post not found or not yours' });
      }
      return send(res, 200, { ok: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return send(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('rule-posts handler error', err);
    return send(res, 500, { error: 'Server error' });
  }
}
