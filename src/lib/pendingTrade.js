const KEY = 'hl:pending-trade';

/** Stash a deal for the trade analyzer to load after navigation. */
export function stashPendingTrade(deal) {
  if (typeof sessionStorage === 'undefined' || !deal) return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(deal));
  } catch {
    // ignore quota / private mode
  }
}

export function peekPendingTrade() {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function consumePendingTrade() {
  const parsed = peekPendingTrade();
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
  return parsed;
}
