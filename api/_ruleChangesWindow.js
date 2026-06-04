/** Same default as client `DEFAULT_RULES_CHANGES_CLOSE_AT` / `VITE_RULES_CHANGES_CLOSE_AT`. */
const DEFAULT_RULES_CHANGES_CLOSE_AT = '2026-08-01T12:00:00Z';

export const RULE_CHANGES_CLOSED_ERROR =
  'The window for rule changes has now closed.';

function rulesChangesCloseAtRaw() {
  return (
    process.env.RULES_CHANGES_CLOSE_AT ||
    process.env.VITE_RULES_CHANGES_CLOSE_AT ||
    DEFAULT_RULES_CHANGES_CLOSE_AT
  ).trim();
}

/** When true, POST rule suggestions, votes, and discussion messages are rejected. */
export function areRuleChangesClosed() {
  const raw = rulesChangesCloseAtRaw();
  if (!raw) return false;
  const t = Date.parse(raw);
  return Number.isFinite(t) && Date.now() >= t;
}
