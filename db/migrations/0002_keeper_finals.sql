-- Locked-in keepers after the K2/K3 ceremony (or K1-only).
-- One row per manager per carry-into season (e.g. 2026).
-- Run: npm run db:migrate -- db/migrations/0002_keeper_finals.sql

begin;

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

commit;
