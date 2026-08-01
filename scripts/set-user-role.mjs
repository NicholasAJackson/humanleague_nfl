/**
 * Update an app_users role without changing the password.
 *
 * Example:
 *   npm run set-user-role -- DavieRocket tester
 *
 * Roles: manager | commissioner | tester
 */
import { getSql } from '../api/_db.js';

const ALLOWED_ROLES = new Set(['manager', 'commissioner', 'tester']);

const username = process.argv[2];
const roleRaw = process.argv[3];

if (!username || !roleRaw) {
  console.error('Usage: node --env-file=.env.local scripts/set-user-role.mjs <username> <role>');
  console.error('  role: manager | commissioner | tester');
  process.exit(1);
}

const role = String(roleRaw).trim().toLowerCase();
if (!ALLOWED_ROLES.has(role)) {
  console.error(`Invalid role "${roleRaw}". Use manager, commissioner, or tester.`);
  process.exit(1);
}

const sql = getSql();
const rows = await sql`
  update app_users
  set role = ${role}
  where lower(username) = lower(${username})
  returning username, role, sleeper_user_id, disabled
`;

if (!rows[0]) {
  console.error(`No app_users row found for username "${username}".`);
  process.exit(1);
}

const u = rows[0];
console.log(
  `Updated "${u.username}" → role=${u.role}` +
    (u.sleeper_user_id ? `, Sleeper id ${u.sleeper_user_id}` : '') +
    (u.disabled ? ' (DISABLED)' : '') +
    '.',
);
process.exit(0);
