-- Run this once against your Neon database (Neon SQL editor or psql).
-- Idempotent: safe to re-run.

create extension if not exists "pgcrypto";

create table if not exists rules (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (length(title) between 1 and 140),
  description text not null default '' check (length(description) <= 2000),
  author      text null check (author is null or length(author) <= 60),
  created_at  timestamptz not null default now()
);

create index if not exists rules_created_at_idx on rules (created_at desc);

-- Votes are scoped to authenticated app users so each manager gets exactly one
-- vote per rule (still toggleable / removable). See db/migrations/0001_user_votes.sql
-- for the migration from the older browser-token scheme.
create table if not exists votes (
  rule_id    uuid not null references rules(id) on delete cascade,
  user_id    uuid not null references app_users(id) on delete cascade,
  value      smallint not null check (value in (-1, 1)),
  created_at timestamptz not null default now(),
  primary key (rule_id, user_id)
);

create index if not exists votes_rule_id_idx on votes (rule_id);
create index if not exists votes_user_id_idx on votes (user_id);

-- Per-rule discussion (forum-style thread)
create table if not exists rule_posts (
  id           uuid primary key default gen_random_uuid(),
  rule_id      uuid not null references rules(id) on delete cascade,
  body         text not null check (length(body) between 1 and 2000),
  author       text null check (author is null or length(author) <= 60),
  poster_token text not null check (length(poster_token) between 8 and 80),
  created_at   timestamptz not null default now()
);

create index if not exists rule_posts_rule_created_idx on rule_posts (rule_id, created_at asc);

-- Keeper nominations (e.g. 3 keepers: #1 guaranteed, #2/#3 subject to league random rules — stored for commissioner)
create table if not exists keeper_nominations (
  id                  uuid primary key default gen_random_uuid(),
  sleeper_user_id     text not null check (length(sleeper_user_id) between 4 and 80),
  source_season       text not null check (length(source_season) between 3 and 8),
  league_id_snapshot  text null check (league_id_snapshot is null or length(league_id_snapshot) <= 40),
  nomination_kind     text not null default 'roster' check (nomination_kind in ('roster', 'freeform')),
  k1_player_id        text null check (k1_player_id is null or length(k1_player_id) <= 40),
  k2_player_id        text null check (k2_player_id is null or length(k2_player_id) <= 40),
  k3_player_id        text null check (k3_player_id is null or length(k3_player_id) <= 40),
  k1_text             text null check (k1_text is null or length(k1_text) <= 160),
  k2_text             text null check (k2_text is null or length(k2_text) <= 160),
  k3_text             text null check (k3_text is null or length(k3_text) <= 160),
  submitted_at        timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (sleeper_user_id, source_season)
);

create index if not exists keeper_nominations_season_idx on keeper_nominations (source_season desc);

-- Final keepers after ceremony (K1 + winner of K2/K3). One row per manager per carry-into season.
create table if not exists keeper_finals (
  id                  uuid primary key default gen_random_uuid(),
  sleeper_user_id     text not null check (length(sleeper_user_id) between 4 and 80),
  carry_into_season   text not null check (length(carry_into_season) between 3 and 8),
  source_season       text not null check (length(source_season) between 3 and 8),
  league_id_snapshot  text null check (league_id_snapshot is null or length(league_id_snapshot) <= 40),
  k1_player_id        text null check (k1_player_id is null or length(k1_player_id) <= 40),
  k1_text             text null check (k1_text is null or length(k1_text) <= 160),
  second_player_id    text null check (second_player_id is null or length(second_player_id) <= 40),
  second_text         text null check (second_text is null or length(second_text) <= 160),
  second_from_slot    text null check (second_from_slot is null or second_from_slot in ('k2', 'k3')),
  recorded_by         text null check (recorded_by is null or length(recorded_by) <= 60),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (sleeper_user_id, carry_into_season)
);

create index if not exists keeper_finals_carry_idx on keeper_finals (carry_into_season desc, updated_at desc);

-- League member logins (commissioner-managed). Set APP_USERS_ENABLED=1 on the host when ready.
create table if not exists app_users (
  id                uuid primary key default gen_random_uuid(),
  username          text not null check (length(username) between 2 and 48),
  password_hash     text not null check (length(password_hash) between 16 and 220),
  sleeper_user_id   text null check (sleeper_user_id is null or length(sleeper_user_id) between 4 and 80),
  role              text not null default 'manager' check (role in ('manager', 'commissioner', 'tester')),
  disabled          boolean not null default false,
  created_at        timestamptz not null default now()
);

create unique index if not exists app_users_username_lower_idx on app_users (lower(username));
