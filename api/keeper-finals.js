import { getSql, rateLimit, clientIp, readJsonBody, send } from './_db.js';
import { assertSiteAuth, getSessionPayload } from './_auth.js';

const USER_ID_RE = /^[0-9a-z]{8,40}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normStr(v, max) {
  const s = v == null ? '' : String(v).trim();
  if (s.length > max) return null;
  return s;
}

async function requireCommissioner(req, res, sql) {
  const session = getSessionPayload(req);
  const sub = session && typeof session.sub === 'string' ? session.sub : null;
  if (!sub || !UUID_RE.test(sub)) {
    send(res, 403, { error: 'Commissioner account required.' });
    return null;
  }
  const rows = await sql`
    select username, role, disabled
    from app_users
    where id = ${sub}
    limit 1
  `;
  const account = rows[0];
  if (!account || account.disabled) {
    send(res, 401, { error: 'Account is not active' });
    return null;
  }
  if (account.role !== 'commissioner') {
    send(res, 403, { error: 'Only commissioners can record locked-in keepers.' });
    return null;
  }
  return account;
}

export default async function handler(req, res) {
  try {
    if (!assertSiteAuth(req, res, send)) return;

    const sql = getSql();

    if (req.method === 'GET') {
      const rows = await sql`
        select
          id,
          sleeper_user_id,
          carry_into_season,
          source_season,
          league_id_snapshot,
          k1_player_id,
          k1_text,
          second_player_id,
          second_text,
          second_from_slot,
          recorded_by,
          created_at,
          updated_at
        from keeper_finals
        order by carry_into_season desc, updated_at desc
      `;
      return send(res, 200, { finals: rows });
    }

    if (req.method === 'POST') {
      const ip = clientIp(req);
      if (!rateLimit(`keeper-finals:${ip}`, { max: 20, windowMs: 60_000 })) {
        return send(res, 429, { error: 'Too many requests, slow down a sec.' });
      }

      const account = await requireCommissioner(req, res, sql);
      if (!account) return;

      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object') {
        return send(res, 400, { error: 'Invalid JSON body' });
      }

      const sleeperUserId = normStr(body.sleeper_user_id, 80);
      if (!sleeperUserId || !USER_ID_RE.test(sleeperUserId)) {
        return send(res, 400, { error: 'sleeper_user_id is required' });
      }

      const sourceSeason = normStr(body.source_season, 8);
      if (!sourceSeason || sourceSeason.length < 3) {
        return send(res, 400, { error: 'source_season is required (e.g. 2025)' });
      }

      let carryInto = normStr(body.carry_into_season, 8);
      if (!carryInto) {
        const n = Number(sourceSeason);
        carryInto = Number.isFinite(n) ? String(n + 1) : null;
      }
      if (!carryInto || carryInto.length < 3) {
        return send(res, 400, { error: 'carry_into_season is required (e.g. 2026)' });
      }

      const leagueSnap = normStr(body.league_id_snapshot, 40);
      const k1p = normStr(body.k1_player_id, 40) || null;
      const k1t = normStr(body.k1_text, 160) || null;
      if (!k1p && !k1t) {
        return send(res, 400, { error: 'Keeper 1 is required.' });
      }

      const slot = normStr(body.second_from_slot, 8);
      if (slot && slot !== 'k2' && slot !== 'k3') {
        return send(res, 400, { error: 'second_from_slot must be k2, k3, or omitted.' });
      }
      const secondP = normStr(body.second_player_id, 40) || null;
      const secondT = normStr(body.second_text, 160) || null;
      if (slot && !secondP && !secondT) {
        return send(res, 400, { error: 'Second keeper is required when a ceremony slot is set.' });
      }

      const recordedBy = String(account.username || '').slice(0, 60) || null;

      const [row] = await sql`
        insert into keeper_finals (
          sleeper_user_id,
          carry_into_season,
          source_season,
          league_id_snapshot,
          k1_player_id,
          k1_text,
          second_player_id,
          second_text,
          second_from_slot,
          recorded_by
        )
        values (
          ${sleeperUserId},
          ${carryInto},
          ${sourceSeason},
          ${leagueSnap},
          ${k1p},
          ${k1t},
          ${secondP},
          ${secondT},
          ${slot || null},
          ${recordedBy}
        )
        on conflict (sleeper_user_id, carry_into_season)
        do update set
          source_season = excluded.source_season,
          league_id_snapshot = excluded.league_id_snapshot,
          k1_player_id = excluded.k1_player_id,
          k1_text = excluded.k1_text,
          second_player_id = excluded.second_player_id,
          second_text = excluded.second_text,
          second_from_slot = excluded.second_from_slot,
          recorded_by = excluded.recorded_by,
          updated_at = now()
        returning
          id, sleeper_user_id, carry_into_season, source_season, league_id_snapshot,
          k1_player_id, k1_text, second_player_id, second_text, second_from_slot,
          recorded_by, created_at, updated_at
      `;

      return send(res, 200, { final: row });
    }

    if (req.method === 'DELETE') {
      const account = await requireCommissioner(req, res, sql);
      if (!account) return;

      const body = await readJsonBody(req);
      const id = body && typeof body.id === 'string' ? body.id.trim() : '';
      if (!id || !UUID_RE.test(id)) {
        return send(res, 400, { error: 'id (uuid) is required' });
      }

      await sql`delete from keeper_finals where id = ${id}`;
      return send(res, 200, { ok: true });
    }

    return send(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('keeper-finals', err);
    const msg = err && err.message ? String(err.message) : 'Server error';
    if (/relation .*keeper_finals.* does not exist/i.test(msg)) {
      return send(res, 503, {
        error: 'keeper_finals table missing — run db/migrations/0002_keeper_finals.sql',
      });
    }
    return send(res, 500, { error: 'Server error' });
  }
}
