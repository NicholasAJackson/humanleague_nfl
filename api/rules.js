import { getSql, rateLimit, clientIp, readJsonBody, send } from './_db.js';
import { assertSiteAuth, getSessionPayload } from './_auth.js';
import { isUndefinedRelation } from './_pgErrors.js';
import { areRuleChangesClosed, RULE_CHANGES_CLOSED_ERROR } from './_ruleChangesWindow.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  try {
    if (!assertSiteAuth(req, res, send)) return;

    const sql = getSql();

    if (req.method === 'GET') {
      // Resolve the caller's account id (if any) so we can also return their
      // own vote per rule. Site-password-only sessions and dev bypass get null
      // and just see the public totals.
      const session = getSessionPayload(req);
      const sub = session && typeof session.sub === 'string' && UUID_RE.test(session.sub)
        ? session.sub
        : null;

      // Note: when sub is null the subquery's `user_id = null` predicate is
      // always false, so my_vote falls back to 0 with no extra branching.
      const queryWithPosts = () => sql`
        select
          r.id,
          r.title,
          r.description,
          r.author,
          r.created_at,
          coalesce(sum(case when v.value = 1 then 1 else 0 end), 0)::int  as up,
          coalesce(sum(case when v.value = -1 then 1 else 0 end), 0)::int as down,
          coalesce(sum(v.value), 0)::int                                  as score,
          coalesce(
            (select mv.value from votes mv where mv.rule_id = r.id and mv.user_id = ${sub} limit 1),
            0
          )::int as my_vote,
          coalesce(
            (select count(*)::int from rule_posts p where p.rule_id = r.id),
            0
          ) as post_count
        from rules r
        left join votes v on v.rule_id = r.id
        group by r.id
        order by score desc, r.created_at desc
      `;

      const queryLegacy = () => sql`
        select
          r.id,
          r.title,
          r.description,
          r.author,
          r.created_at,
          coalesce(sum(case when v.value = 1 then 1 else 0 end), 0)::int  as up,
          coalesce(sum(case when v.value = -1 then 1 else 0 end), 0)::int as down,
          coalesce(sum(v.value), 0)::int                                  as score,
          coalesce(
            (select mv.value from votes mv where mv.rule_id = r.id and mv.user_id = ${sub} limit 1),
            0
          )::int as my_vote
        from rules r
        left join votes v on v.rule_id = r.id
        group by r.id
        order by score desc, r.created_at desc
      `;

      let rows;
      try {
        rows = await queryWithPosts();
      } catch (e) {
        if (isUndefinedRelation(e, 'rule_posts')) {
          rows = (await queryLegacy()).map((r) => ({ ...r, post_count: 0 }));
        } else {
          throw e;
        }
      }
      return send(res, 200, { rules: rows });
    }

    if (req.method === 'POST') {
      if (areRuleChangesClosed()) {
        return send(res, 403, { error: RULE_CHANGES_CLOSED_ERROR });
      }

      // Suggesting a rule now requires a member account so the author is
      // attributed to a real manager (no more free-text names).
      const session = getSessionPayload(req);
      const sub = session && typeof session.sub === 'string' && UUID_RE.test(session.sub)
        ? session.sub
        : null;
      if (!sub) {
        return send(res, 401, { error: 'Sign in with your manager account to suggest a rule.' });
      }

      const userRows = await sql`
        select username, disabled
        from app_users
        where id = ${sub}
        limit 1
      `;
      const account = userRows[0];
      if (!account || account.disabled) {
        return send(res, 401, { error: 'Account is not active' });
      }

      const ip = clientIp(req);
      if (!rateLimit(`rules:${sub}:${ip}`, { max: 8, windowMs: 60_000 })) {
        return send(res, 429, { error: 'Too many requests, slow down a sec.' });
      }

      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object') {
        return send(res, 400, { error: 'Invalid JSON body' });
      }
      const title = String(body.title || '').trim();
      const description = String(body.description || '').trim();
      const author = String(account.username).slice(0, 60);

      if (title.length < 3 || title.length > 140) {
        return send(res, 400, { error: 'Title must be 3-140 characters' });
      }
      if (description.length > 2000) {
        return send(res, 400, { error: 'Description is too long (max 2000)' });
      }

      const [rule] = await sql`
        insert into rules (title, description, author)
        values (${title}, ${description}, ${author})
        returning id, title, description, author, created_at
      `;
      return send(res, 201, {
        rule: { ...rule, up: 0, down: 0, score: 0, post_count: 0, my_vote: 0 },
      });
    }

    res.setHeader('Allow', 'GET, POST');
    return send(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('rules handler error', err);
    return send(res, 500, { error: 'Server error' });
  }
}
