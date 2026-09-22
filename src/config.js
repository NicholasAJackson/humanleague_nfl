/** Midday GMT 1 Aug 2026 — override with `VITE_KEEPERS_REVEAL_AT` (ISO 8601). */
export const DEFAULT_KEEPERS_REVEAL_AT = '2026-08-01T12:00:00Z';

/** Rule suggestions / votes / discussion close at this instant by default (same as keeper reveal). */
export const DEFAULT_RULES_CHANGES_CLOSE_AT = DEFAULT_KEEPERS_REVEAL_AT;

/** League startup draft — 8 Aug 2026, 7:00pm BST. Override with `VITE_DRAFT_AT`. */
export const DEFAULT_DRAFT_AT = '2026-08-08T19:00:00+01:00';

const viteEnv =
  typeof import.meta !== 'undefined' && import.meta.env && typeof import.meta.env === 'object'
    ? import.meta.env
    : {};

export const config = {
  leagueId: viteEnv.VITE_SLEEPER_LEAGUE_ID || '',
  /** ISO 8601, e.g. `2026-08-20T17:00:00-04:00`. Uses {@link DEFAULT_KEEPERS_REVEAL_AT} when env unset. */
  keepersRevealAt: (viteEnv.VITE_KEEPERS_REVEAL_AT || DEFAULT_KEEPERS_REVEAL_AT).trim(),
  /** ISO 8601. Uses {@link DEFAULT_RULES_CHANGES_CLOSE_AT} when env unset. */
  rulesChangesCloseAt: (viteEnv.VITE_RULES_CHANGES_CLOSE_AT || DEFAULT_RULES_CHANGES_CLOSE_AT).trim(),
  /** Startup draft kickoff (default: 8 Aug 2026, 7pm BST). Override with `VITE_DRAFT_AT`. */
  draftAt: (viteEnv.VITE_DRAFT_AT || DEFAULT_DRAFT_AT).trim(),
};

function envFlagTrue(name) {
  const v = viteEnv[name];
  if (typeof v !== 'string') return false;
  const s = v.trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/**
 * Local-only: keep `/login` reachable so you can paste a Sleeper league ID for guest browse,
 * even when site auth is off (dev bypass). Set `VITE_DEV_LOGIN_SCREEN=1` in `.env.local`.
 * Ignored in production builds.
 */
export const DEV_LOGIN_SCREEN = Boolean(viteEnv.DEV && envFlagTrue('VITE_DEV_LOGIN_SCREEN'));

/**
 * Guest browse via a pasted Sleeper league ID — available to everyone on the login screen
 * (signed-in members, anonymous visitors, and local DEV).
 */
export function canAccessGuestBrowse(_user, _devBypass, _opts = {}) {
  return true;
}

/** Human League roster/draft shape — used for keeper cost vs consensus view on Rankings. */
export const leagueFormat = {
  teamCount: 10,
  draftRounds: 14,
  /** Waivers / trades: sacrifice this round if kept (no draft slot in league startup). */
  undraftedKeeperRound: 14,
  /** Starter slots for need scoring (1 QB + 2 flex, no kickers). */
  starterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, DST: 1 },
};

/**
 * Guest “browse another league” may use these Sleeper-read routes only.
 * Keepers, rules, mock draft, and ceremony stay on the Human League auth path.
 * My Team is allowed so guests can pick a roster and see waiver upgrades.
 */
export const GUEST_ALLOWED_PATHS = new Set(['/', '/stats', '/drafts', '/rankings', '/trades', '/me']);

export function isGuestAllowedPath(pathname) {
  return GUEST_ALLOWED_PATHS.has(pathname);
}

/** Mock draft: gated off after startup draft. Flip {@link SHOW_MOCK_DRAFT_PAGE} to reopen. Guests: no. */
export function canAccessMockDraft(user, devBypass, isGuest = false) {
  if (isGuest) return false;
  if (!SHOW_MOCK_DRAFT_PAGE) return false;
  if (user) return true;
  if (viteEnv.DEV && devBypass) return true;
  return false;
}

/** Flip these when reopening pages to the league.
 *  Also restore the matching API file (strip the leading `_`):
 *  Rules → `_rules.js`, `_votes.js`, `_rule-posts.js`
 *  Ceremony / keepers locked-in → `_keeper-finals.js`
 *  Trade hype → `_trade-hype.js` and `SHOW_TRADE_HYPE` in TradeAnalyzer.jsx
 */
export const SHOW_MOCK_DRAFT_PAGE = false;
export const SHOW_KEEPERS_PAGE = false;
export const SHOW_CEREMONY_PAGE = false;
export const SHOW_RULES_PAGE = false;

/** Keepers page — gated while offseason tooling is paused. Guests: no. */
export function canAccessKeepers(isGuest = false) {
  if (isGuest) return false;
  return SHOW_KEEPERS_PAGE;
}

/** Keeper ceremony: commissioners only when the page is enabled. Guests: no. */
export function canAccessKeeperCeremony(user, devBypass, isGuest = false) {
  if (isGuest) return false;
  if (!SHOW_CEREMONY_PAGE) return false;
  if (user?.role === 'commissioner') return true;
  if (viteEnv.DEV && devBypass) return true;
  return false;
}

/** Rules page — gated while offseason tooling is paused. Guests: no. */
export function canAccessRules(isGuest = false) {
  if (isGuest) return false;
  return SHOW_RULES_PAGE;
}

/**
 * Trade analyzer: any signed-in member; guests in browse mode; local DEV bypass.
 */
export function canAccessTradeAnalyzer(user, devBypass, isGuest = false) {
  if (isGuest) return true;
  if (user) return true;
  if (viteEnv.DEV && devBypass) return true;
  return false;
}

/**
 * My Team: member sessions with a linked Sleeper id, or guest browse (team picker).
 */
export function canAccessMyTeam(user, isGuest = false) {
  if (isGuest) return true;
  return typeof user?.sleeperUserId === 'string' && user.sleeperUserId.length > 0;
}

export function isConfigured(leagueId = config.leagueId) {
  return Boolean(leagueId);
}

/** Milliseconds at draft kickoff, or null if unset / invalid. */
export function getDraftTimestamp() {
  if (!config.draftAt) return null;
  const t = Date.parse(config.draftAt);
  return Number.isFinite(t) ? t : null;
}

/** Milliseconds at which keeper nominations become visible in the UI, or null if not configured / invalid. */
export function getKeepersRevealTimestamp() {
  if (!config.keepersRevealAt) return null;
  const t = Date.parse(config.keepersRevealAt);
  return Number.isFinite(t) ? t : null;
}

/** When true, the All nominations table is not shown (and the list is not fetched). */
export function areKeeperNominationsHiddenInUi() {
  const ts = getKeepersRevealTimestamp();
  return ts != null && Date.now() < ts;
}

/** When true, new nominations and edits are blocked (reveal instant has passed). */
export function areKeeperNominationsClosed() {
  const ts = getKeepersRevealTimestamp();
  return ts != null && Date.now() >= ts;
}

/** Milliseconds after which rule changes are closed, or null if not configured / invalid. */
export function getRulesChangesCloseTimestamp() {
  if (!config.rulesChangesCloseAt) return null;
  const t = Date.parse(config.rulesChangesCloseAt);
  return Number.isFinite(t) ? t : null;
}

/** When true, new suggestions, votes, and discussion posts are blocked. */
export function areRuleChangesClosed() {
  const ts = getRulesChangesCloseTimestamp();
  return ts != null && Date.now() >= ts;
}
