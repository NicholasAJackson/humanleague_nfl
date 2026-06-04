import { getSql, rateLimit, clientIp, readJsonBody, send } from './_db.js';
import { assertSiteAuth, getSessionPayload } from './_auth.js';
import { areRuleChangesClosed, RULE_CHANGES_CLOSED_ERROR } from './_ruleChangesWindow.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  try {
    if (!assertSiteAuth(req, res, send)) return;

    if (req.method !== 'POST' && req.method !== 'DELETE') {
      res.setHeader('Allow', 'POST, DELETE');
      return send(res, 405, { error: 'Method not allowed' });
    }

    // Voting requires a member account session (not just the shared site
    // password). Site-password-only sessions have no `sub` claim.
    const session = getSessionPayload(req);
    const sub = session && typeof session.sub === 'string' ? session.sub : null;
    if (!sub || !UUID_RE.test(sub)) {
      return send(res, 401, { error: 'Sign in with your manager account to vote.' });
    }

    if (areRuleChangesClosed()) {
      return send(res, 403, { error: RULE_CHANGES_CLOSED_ERROR });
    }

    const ip = clientIp(req);
    if (!rateLimit(`votes:${sub}:${ip}`, { max: 60, windowMs: 60_000 })) {
      return send(res, 429, { error: 'Too many requests, slow down a sec.' });
    }

    const sql = getSql();

    // Confirm the account is still active.
    const userRows = await sql`
      select id, disabled
      from app_users
      where id = ${sub}
      limit 1
    `;
    const account = userRows[0];
    if (!account || account.disabled) {
      return send(res, 401, { error: 'Account is not active' });
    }

    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') {
      return send(res, 400, { error: 'Invalid JSON body' });
    }

    const ruleId = String(body.rule_id || '').trim();
    if (!UUID_RE.test(ruleId)) {
      return send(res, 400, { error: 'Invalid rule_id' });
    }

    if (req.method === 'DELETE') {
      await sql`delete from votes where rule_id = ${ruleId} and user_id = ${sub}`;
    } else {
      const value = body.value === -1 || body.value === 1 ? body.value : null;
      if (value === null) {
        return send(res, 400, { error: 'value must be 1 or -1' });
      }
      await sql`
        insert into votes (rule_id, user_id, value)
        values (${ruleId}, ${sub}, ${value})
        on conflict (rule_id, user_id)
        do update set value = excluded.value, created_at = now()
      `;
    }

    const [totals] = await sql`
      select
        coalesce(sum(case when value = 1 then 1 else 0 end), 0)::int  as up,
        coalesce(sum(case when value = -1 then 1 else 0 end), 0)::int as down,
        coalesce(sum(value), 0)::int                                  as score
      from votes
      where rule_id = ${ruleId}
    `;
    return send(res, 200, { rule_id: ruleId, ...totals });
  } catch (err) {
    console.error('votes handler error', err);
    return send(res, 500, { error: 'Server error' });
  }
}
