/**
 * Match ESPN headlines + Sleeper trending to players in a proposed trade.
 */

export function normalizePlayerName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameTokens(name) {
  return normalizePlayerName(name)
    .split(' ')
    .filter((t) => t && t !== 'jr' && t !== 'sr' && t !== 'ii' && t !== 'iii' && t !== 'iv');
}

/**
 * Loose name match: full normalized equality, or last-name + first-token prefix.
 */
export function namesMatch(playerName, athleteName) {
  const a = normalizePlayerName(playerName);
  const b = normalizePlayerName(athleteName);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) {
    // Avoid short partials ("john" in "johnson")
    if (Math.min(a.length, b.length) >= 8) return true;
  }
  const at = nameTokens(playerName);
  const bt = nameTokens(athleteName);
  if (at.length < 2 || bt.length < 2) return false;
  const aLast = at[at.length - 1];
  const bLast = bt[bt.length - 1];
  if (aLast !== bLast || aLast.length < 3) return false;
  const aFirst = at[0];
  const bFirst = bt[0];
  return aFirst === bFirst || aFirst.startsWith(bFirst) || bFirst.startsWith(aFirst);
}

function articleMentionsPlayer(article, player) {
  if (!article || !player?.name) return false;
  for (const ath of article.athletes || []) {
    if (namesMatch(player.name, ath.name)) return true;
  }
  const hay = `${article.headline || ''} ${article.description || ''}`;
  // Last-resort: full name appears in headline/description
  const full = normalizePlayerName(player.name);
  if (full.length >= 8 && normalizePlayerName(hay).includes(full)) return true;
  return false;
}

function hoursAgo(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (Date.now() - t) / 36e5);
}

/**
 * @param {object[]} players — trade players (both sides)
 * @param {{ articles?: object[], trending_add?: object[], trending_drop?: object[] } | null} hype
 */
export function matchTradeHype(players, hype) {
  const list = Array.isArray(players) ? players.filter((p) => p?.name) : [];
  if (!list.length || !hype) {
    return { items: [], newsCount: 0, trendCount: 0 };
  }

  const addById = new Map((hype.trending_add || []).map((r) => [String(r.sleeper_id), r]));
  const dropById = new Map((hype.trending_drop || []).map((r) => [String(r.sleeper_id), r]));

  const items = [];
  for (const player of list) {
    const sid = player.sleeper_id != null ? String(player.sleeper_id) : null;
    const news = (hype.articles || [])
      .filter((a) => articleMentionsPlayer(a, player))
      .map((a) => ({
        id: a.id,
        headline: a.headline,
        description: a.description,
        published: a.published,
        link: a.link,
        hours_ago: hoursAgo(a.published),
      }))
      // Prefer fresher headlines; keep a few per player
      .sort((x, y) => (x.hours_ago ?? 999) - (y.hours_ago ?? 999))
      .slice(0, 3);

    const add = sid ? addById.get(sid) || null : null;
    const drop = sid ? dropById.get(sid) || null : null;

    if (!news.length && !add && !drop) continue;

    items.push({
      name: player.name,
      pos: player.pos || null,
      team: player.team || null,
      sleeper_id: sid,
      side: player._side || null,
      news,
      trending_add: add,
      trending_drop: drop,
    });
  }

  return {
    items,
    newsCount: items.reduce((n, it) => n + it.news.length, 0),
    trendCount: items.filter((it) => it.trending_add || it.trending_drop).length,
  };
}

export function formatTrendLabel(row, kind) {
  if (!row) return null;
  const verb = kind === 'add' ? 'Adds' : 'Drops';
  return `#${row.rank} ${verb.toLowerCase()} (24h) · ${Number(row.count).toLocaleString()} ${verb.toLowerCase()}`;
}

export function formatHoursAgo(hours) {
  if (hours == null || !Number.isFinite(hours)) return null;
  if (hours < 1) return 'just now';
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const d = Math.round(hours / 24);
  return d === 1 ? '1d ago' : `${d}d ago`;
}
