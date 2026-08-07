# Fantasy Dashboards

A mobile-first Vite + React app for a Sleeper fantasy football league.

- `/` — Full-page hero, Hall of Fame, and quick links into Keepers / Rules / Stats
- `/stats` — Combined league analytics in collapsible sections: All-Time Standings, Latest Season Standings, Playoffs, Head-to-Head records (the legacy `/h2h` URL redirects here)
- `/drafts` — **Draft board** per linked season: teams as columns, rounds as rows (Sleeper picks + `draft_order`)
- `/rules` — Rule suggestions, voting, and **per-rule discussion** threads. One vote and one suggestion per logged-in account; the suggester is implied from the account, no free-text name field.
- `/keepers` — Manager keeper nominations from your Sleeper roster (logged-in managers can only nominate for their own team; commissioners can edit on anyone's behalf). Rule: keeper 1 is guaranteed; if you want a second keeper, you must pick both keeper 2 and keeper 3 — one is randomised at the league ceremony. Optional `VITE_KEEPERS_REVEAL_AT` (ISO 8601) hides the **All nominations** table until that time; your own latest pick stays visible on `/keepers`. After that instant, nominations are **locked** (UI + `POST /api/keeper-nominations`) for everyone. Set the same instant as **`KEEPERS_REVEAL_AT`** (server env) so `GET /api/keeper-nominations` returns only each member's own rows until reveal — commissioners still receive the full list.
- `/mock-draft` — Timed snake mock draft. Player pool is **Sleeper Half-PPR ADP**. CPU / timer picks use **FantasyPros-style** logic: each team gets a random cheat sheet (Sleeper ADP, DynastyProcess ECR, and FantasyPros live ECR when the API key is set) with rank jitter, then picks with roster-need and positional scarcity. Locked-in keepers from `/api/keeper-finals` fill cost-round slots for every manager. Before reveal / without finals, falls back to nominations.
- `/keeper-ceremony` — Commissioner-only wheel / picker to flip between each manager’s K2 and K3, then **lock results into Postgres** (`keeper_finals`). Locked keepers show on `/keepers` under **Locked in** (K1 + ceremony winner for the carry-into season, e.g. 2026).
- `/rankings` — **Expert player rankings**: FantasyPros Expert Consensus redraft **overall** via [DynastyProcess](https://github.com/dynastyprocess/data) (filter by position — no kickers; **ALL** omits kickers), optional **FP live ECR (Half-PPR)** when `FANTASYPROS_API_KEY` is set, **Sleeper ADP (Half-PPR)** from Sleeper projections, plus **Keeper: draft vs consensus** (linked Sleeper startup draft vs DynastyProcess ECR for rostered players). Keeper merge runs in the browser.
- `/trades` — **Trade analyzer** (redraft Half-PPR): DynastyProcess ECR → trade points, Side A vs Side B fairness band, optional package adjust, **starter-upgrade** deltas (optimal 1QB/2RB/2WR/1TE/1FLEX/1DST lineup), a **trade finder** that suggests mutual-upgrade deals from linked Sleeper rosters, and **Any Hype?** (ESPN NFL headlines + Sleeper 24h trending adds/drops for players in the deal via `/api/trade-hype`).

Hosted on Vercel. Voting state lives in Neon Postgres (free tier). Sleeper data is read from the public Sleeper API.

## Stack

- Vite + React (JavaScript), `react-router-dom`
- Vercel serverless functions in `/api/*.js`
- Postgres via `pg` and `DATABASE_URL` (local / pgAdmin, Docker, or Neon TCP connection strings)
- No service worker; manifest + icons only for PWA install

## Local development

### 1. Prerequisites

- Node 18 or newer
- A Sleeper league id (the long number in your league URL on `sleeper.app`)
- Optional: a Neon connection string for testing the rules/voting API locally

### 2. Install and configure

```bash
npm install
cp .env.example .env
```

Edit `.env`:

```
VITE_SLEEPER_LEAGUE_ID=your_league_id_here
DATABASE_URL=postgres://...   # only needed if you want to test /api locally
# Optional: VITE_KEEPERS_REVEAL_AT=2026-08-20T12:00:00-04:00
```

### 3. Run

**Important:** `npm run dev` starts **Vite only**. It does **not** run `/api/*` (those are Vercel serverless functions). If you open `/rules` with only Vite, the Rules page cannot talk to Postgres until you use `vercel dev` below.

For **Home, Stats, and Wheel** (Sleeper only):

```bash
npm run dev
```

Then visit http://localhost:5173.

With `npm run dev`, Vite serves **`/api/auth/*` only** (so optional `SITE_PASSWORD` login works from `.env.local`). Other `/api/*` routes still return 503 until you run `npx vercel dev` (needed for Rules + Postgres).

For **Rules, keeper nominations, and voting** (needs `DATABASE_URL` and `db/schema.sql` applied):

```bash
npx vercel dev
```

Use the URL printed in the terminal (often http://localhost:3000). `vercel dev` runs Vite **and** the `/api` routes against your `.env` `DATABASE_URL` (local Postgres or Neon).

`DATABASE_URL` must be a real connection string, e.g. `postgresql://postgres:YOUR_PASSWORD@localhost:5432/fantasy_dashboard` — use your actual password, not placeholder braces.

First-time Vercel CLI may ask you to log in and link the project; that is normal for local dev.

## Database setup (Neon)

### First-time setup

Run `db/schema.sql` once against your Neon database. Easiest path:

1. Open the Neon dashboard for the project that the Vercel integration provisioned.
2. Open the SQL editor.
3. Paste the contents of `db/schema.sql` and run it.

The script is idempotent, so re-running it is safe — but note that `create table if not exists` skips tables that already exist, so it does **not** apply changes to live tables (use migrations for that).

### Applying schema changes (migrations)

Schema changes after the initial setup live under `db/migrations/`. Apply one with:

```bash
npm run db:migrate -- db/migrations/0001_user_votes.sql
```

This runs the SQL against whichever database `DATABASE_URL` points at in `.env.local` — the same one your local dev server uses, so there's no risk of running it on the wrong Neon branch. The script is also safe to run from CI against your production `DATABASE_URL` if you prefer.

Each migration file is wrapped in a transaction so it's all-or-nothing.

## Deployment to Vercel

1. Push this repo to GitHub.
2. In Vercel, "Add New → Project" and import the repo. Vercel auto-detects the Vite framework preset.
3. In the project's "Storage" tab, click "Connect Database → Neon" and provision a new Postgres. This injects `DATABASE_URL` automatically.
4. In "Settings → Environment Variables", add:
   - `VITE_SLEEPER_LEAGUE_ID` — your Sleeper league id, in all environments (Production, Preview, Development).
   - Optional **site login** (shared password for everyone in the league): set `SITE_PASSWORD` to a passphrase and `AUTH_SECRET` to a long random string (at least 16 characters). If either is missing or `AUTH_SECRET` is too short, login is disabled and the app stays public. Add both to Production (and Preview if you use preview deploys).
   - Optional **per-member logins** (after `app_users` exists in `db/schema.sql`): set **`APP_USERS_ENABLED`** to `1`, `true`, or `yes` on **Production** (and Preview if you use it), alongside **`DATABASE_URL`** and **`AUTH_SECRET`** (at least 16 characters). Without all three, the app stays public and there is no sign-in gate. Create rows with `npm run create-user -- <username> <password> [sleeper_user_id] [role]` (requires Node 20+ for `--env-file` in the script). Roles: `manager` (default), `commissioner`, `tester` (mock draft access without ceremony). You can use member accounts only, shared password only, or both; the sign-in page adapts.
   - Optional **`FANTASYPROS_API_KEY`** — enables live Half-PPR ECR view on `/rankings` (server-only; never `VITE_*`).
5. Apply the schema: Neon dashboard → SQL editor → paste `db/schema.sql` → run.  
   `schema.sql` is idempotent for **new** tables, so re-running picks up any tables that didn't exist before (e.g. `rule_posts`, `app_users`). It does **not** alter existing tables — for those, apply the relevant file from `db/migrations/` instead. The safest path is `npm run db:migrate -- db/migrations/<file>.sql` from a machine whose `.env.local` points at the same DB you're targeting (see "Applying schema changes" above).
6. Trigger a deploy. Visit your `*.vercel.app` URL.
7. Sanity check:
   - `/api/rules` should return `{ "rules": [...] }` (or `[]` on a fresh DB).
   - `/stats` should populate after a few seconds.

## File layout

```
api/                Vercel serverless functions (Node 18, ESM)
  _db.js              shared Postgres pool + helpers
  _pgErrors.js        detect missing tables / Postgres error shapes
  _auth.js            optional shared-password + member session (HMAC cookie)
  _password.js        scrypt password hashes for app_users
  auth/config.js      GET — which login modes are enabled (no cookie)
  auth/me.js          session status + optional `user` for member sessions
  auth/login.js       POST username/password or shared password → Set-Cookie
  auth/logout.js      clear session cookie
  rules.js            GET (with `my_vote` per rule), POST — author is the logged-in user
  votes.js            POST, DELETE — keyed to the logged-in `app_users.id`
  rule-posts.js       GET, POST, DELETE — forum messages under a rule
  keeper-nominations.js  GET, POST — Sleeper-roster keeper picks; managers can only edit their own
  rankings.js         GET — DynastyProcess ECR mirror + Sleeper ADP + optional FantasyPros live Half-PPR ECR
db/
  schema.sql          first-time database setup (idempotent)
  migrations/         additive schema changes; apply with `npm run db:migrate -- <file>`
    0001_user_votes.sql  switch votes from browser tokens to user_id
public/
  manifest.webmanifest
  img/                static images served at /img/* (winner photo, etc.)
  icons/              192/512/maskable SVG icons
scripts/
  create-user.mjs        insert a row into app_users
  hash-password.mjs      generate scrypt hashes
  run-migration.mjs      apply a SQL file via `npm run db:migrate`
  verify-database-url.mjs sanity check the DATABASE_URL connection
src/
  main.jsx
  App.jsx             routing + lazy-loaded pages
  AuthContext.jsx     session state for the React tree
  config.js           reads VITE_SLEEPER_LEAGUE_ID
  lib/
    sleeper.js        Sleeper API helpers + previous-season walker + drafts
    stats.js          pure functions for derived stats
    h2h.js            head-to-head record helpers
    hallOfFame.js     past champions (homepage)
    drafts.js         draft board helpers (uses `buildTeams` for picker names)
    voter.js          anonymous browser token used for rule-discussion posts
                      (votes themselves now use the logged-in account)
  pages/              Home, Stats, Wheel, Drafts, Rules, Keepers, Login
  components/         Nav, BottomSheet, Wheel, RuleCard, RuleDiscussionSheet
  styles/             tokens.css, globals.css
index.html
vercel.json           SPA rewrites (everything except /api, /assets, /icons,
                      /img, /src, /favicon.svg, /manifest.webmanifest -> /index.html)
vite.config.js
```

## Mobile-first notes

- Layout designed for portrait phone first (~360–430 px wide).
- Bottom tab bar nav on mobile, sticky top nav on desktop (≥ 768 px).
- All tap targets ≥ 44×44 px; iOS safe-area handled in shell, nav, and bottom sheet.
- Inputs use `inputmode`/`enterkeyhint` for better keyboards; base font 16 px to prevent zoom on focus.
- Wheel sized to `min(90vw, 480px)` so it never overflows.
- Result modal becomes a bottom sheet on mobile; brief vibration on result where supported.
- `React.lazy` per route so phones on slow data only download the page they visit.

## Voting model

- Voting requires a logged-in member account (`app_users`). Site-password-only sessions can read the rules but cannot vote or suggest.
- The `votes` table is keyed on `(rule_id, user_id)` where `user_id` is the caller's `app_users.id` — so each manager gets exactly one vote per rule, regardless of browser, device, or session.
- Toggling, switching, or removing a vote is idempotent (server upserts on the primary key; DELETE removes the row).
- `GET /api/rules` returns each row's `my_vote` for the caller (`1`, `-1`, or `0`) so the UI hydrates the correct up/down arrow state on first load.
- Suggesting a rule is also account-gated; the `author` column is set server-side from `app_users.username` and the client cannot override it.
- A best-effort per-(user_id × IP) rate limit is applied on each Vercel function instance.

## Rule discussions

- Each rule has a linear thread in `rule_posts` (oldest first in the UI).
- Discussion posts still use an anonymous browser token (`voter:token` / `getVoterToken()`), separate from the user-ID-based vote dedup. The token is sent as `poster_token` when posting; the API never exposes other users' tokens. Pass `X-Poster-Token` on `GET /api/rule-posts` so responses include `mine: true` on your own messages (for **Delete**).
- Deleting a post requires the same `poster_token` that created it.

## Out of scope (v1)

- OAuth / SSO (member accounts use scrypt-hashed passwords stored in `app_users`; shared site password is also supported)
- Server-side caching of Sleeper data
- Real-time vote updates (refetch on action)
- Optimal-lineup analysis (would require fetching the full Sleeper player database)
- Offline mode / service worker

## Expert rankings (`/rankings`)

The rankings page views consensus and ADP data from three sources.

- **Source (DynastyProcess ECR):** [`dynastyprocess/data`](https://github.com/dynastyprocess/data) — `db_fpecr_latest.csv` (~700 KB, weekly cron) and `db_playerids.csv` (~2.5 MB) for the Sleeper ↔ FantasyPros id join. Used by **Redraft rankings**, **Keeper**, Mock Draft, and My Team.
- **Source (Sleeper ADP):** Undocumented Sleeper projections feed (`adp_half_ppr`) for the current NFL season. Powers **Sleeper ADP (Half-PPR)** (`?page_type=sleeper-adp-half`). Cached **30 minutes** in memory (6h stale-on-error). No API key required.
- **Source (live FantasyPros):** Optional `GET …/consensus-rankings` via the [public v2 API](https://www.fantasypros.com/api-data/) when **`FANTASYPROS_API_KEY`** is set (server-only). Powers **FP live ECR (Half-PPR)** (`?page_type=fp-ecr-half`). Cached **30 minutes** in memory (6h stale-on-error). Without the key that view returns 503; DynastyProcess redraft and Sleeper ADP still work.
- **Server:** `api/rankings.js` caches **`redraft-overall`** for **1 hour** (24h stale-on-error). Unknown `?page_type=` falls back to `redraft-overall`.
- **Client:** `src/pages/Rankings.jsx` — **Redraft rankings** / live FP ECR / Sleeper ADP (Bye / SD / Best-Worst / Owned where available) vs **Keeper: draft vs consensus** (startup **PICK {season}**, **RD cost**, **RD ECR**, consensus **ECR**, **Delta**, manager filter, sortable columns). Keeper always uses DynastyProcess `redraft-overall`. Kickers excluded from filters and from ALL.
- **Auth:** Same `assertSiteAuth` gate as the rest of the API — the page is read-only and accessible to any logged-in member or shared-password session.
- **Env:** DynastyProcess and Sleeper ADP need no secrets. Live FP ECR needs `FANTASYPROS_API_KEY` in `.env` / Vercel (never `VITE_*`).
