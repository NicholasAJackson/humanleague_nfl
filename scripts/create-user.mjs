/**
 * Create or update a league member row in app_users (run schema + role migration first).
 *
 * Examples:
 *   npm run create-user -- nicho "your-secure-pass" 1234567890abcdef
 *   npm run create-user -- DavieRocket "temp-pass" 878425203456491520 tester
 *
 * Args: <username> <password> [sleeper_user_id] [role]
 * role: manager | commissioner | tester (default manager)
 *
 * If the username already exists, updates password_hash, sleeper_user_id (when provided), and role.
 */
import { getSql } from '../api/_db.js';
import { hashPassword } from '../api/_password.js';

const ALLOWED_ROLES = new Set(['manager', 'commissioner', 'tester']);

const username = process.argv[2];
const password = process.argv[3];
const sleeperUserId = process.argv[4] || null;
const roleRaw = process.argv[5] || 'manager';

if (!username || !password) {
  console.error(
    'Usage: node --env-file=.env.local scripts/create-user.mjs <username> <password> [sleeper_user_id] [role]',
  );
  console.error('  role: manager | commissioner | tester (default: manager)');
  process.exit(1);
}

const role = String(roleRaw).trim().toLowerCase();
if (!ALLOWED_ROLES.has(role)) {
  console.error(`Invalid role "${roleRaw}". Use manager, commissioner, or tester.`);
  process.exit(1);
}

const hash = hashPassword(password);
const sql = getSql();
const sid = sleeperUserId && String(sleeperUserId).trim() ? String(sleeperUserId).trim() : null;

const existing = await sql`
  select id, username, role, sleeper_user_id
  from app_users
  where lower(username) = lower(${username})
  limit 1
`;

if (existing[0]) {
  const nextSid = sid != null ? sid : existing[0].sleeper_user_id;
  await sql`
    update app_users
    set
      password_hash = ${hash},
      sleeper_user_id = ${nextSid},
      role = ${role},
      disabled = false
    where id = ${existing[0].id}
  `;
  console.log(
    `Updated app user "${existing[0].username}" → role=${role}` +
      (nextSid ? `, Sleeper id ${nextSid}` : '') +
      ' (password reset).',
  );
} else {
  await sql`
    insert into app_users (username, password_hash, sleeper_user_id, role)
    values (${username}, ${hash}, ${sid}, ${role})
  `;
  console.log(
    `Created app user "${username}" with role=${role}` + (sid ? ` (Sleeper id ${sid})` : '') + '.',
  );
}

process.exit(0);
