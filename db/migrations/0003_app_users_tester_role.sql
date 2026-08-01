-- Allow tester role (mock draft access without commissioner powers).
-- Postgres cannot ALTER a CHECK constraint in place; drop and recreate.

alter table app_users drop constraint if exists app_users_role_check;

alter table app_users
  add constraint app_users_role_check
  check (role in ('manager', 'commissioner', 'tester'));
