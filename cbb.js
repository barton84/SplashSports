// Men's college basketball: ESPN's opening line vs ESPN's current/closing line.
// Shared by the page (app.js), the storage API, and the daily scheduled sync.
//
// A saved day looks like:
//   { id: 'YYYYMMDD', games: { [espnId]: Game }, lastSync, updatedAt }
// and each Game keeps the opener and the current line with the home spread:
//   open: { sh, t, ss, ts, at }  ss/ts = where the spread/total opener came from
//   cur:  { sh, t }            last line before tip-off; frozen once the game starts
import { compare, grade } from './logic.js';

function r1(v) {
  return v == null ? null : Math.round(v * 10) / 10 + 0;
}

// Fold a fresh ESPN scoreboard pull into a saved day. Returns ids of finished games
// that still need a closing line from ESPN's game summary.
export function mergeDay(day, events, now) {
  day.games ||= {};
  const needClose = [];
  for (const ev of events) {
    const away = ev.teams.find(t => t.homeAway === 'away') || ev.teams[0];
    const home = ev.teams.find(t => t.homeAway === 'home') || ev.teams[1];
    const g = day.games[ev.id] || { id: ev.id, open: { sh: null, t: null, ss: null, ts: null }, cur: { sh: null, t: null } };
    g.date = ev.date;
    g.neutral = ev.neutral;
    g.state = ev.state;
    g.completed = ev.completed;
    g.detail = ev.detail;
    g.teams = [away, home].map(t => ({
      n: t.short || t.location || t.name,
      alt: [t.display, t.location, t.name, t.abbr].filter(Boolean),
      rank: t.rank ?? null,
      rec: t.record || null,
      conf: t.conf || null,
    }));
    g.scores = away.score != null && home.score != null ? [away.score, home.score] : null;
    applyOdds(g, ev.odds, now, ev.state === 'pre');
    day.games[ev.id] = g;
    if (g.completed && g.cur.sh == null && g.cur.t == null) needClose.push(ev.id);
  }
  day.lastSync = now;
  day.updatedAt = now;
  return needClose;
}

// pre = true while the game hasn't started, so the current line can still move.
// open.ss / open.ts record where each opener came from: 'espn' (ESPN's listed opener)
// or 'first' (the first line this app saw).
export function applyOdds(g, odds, now, pre) {
  if (!odds) return;
  // ESPN's own opener always wins over the first line we happened to see.
  if (odds.openSpreadHome != null && g.open.ss !== 'espn') { g.open.sh = r1(odds.openSpreadHome); g.open.ss = 'espn'; }
  if (odds.openTotal != null && g.open.ts !== 'espn') { g.open.t = r1(odds.openTotal); g.open.ts = 'espn'; }

  if (pre) {
    if (odds.spreadHome != null) g.cur.sh = r1(odds.spreadHome);
    if (odds.total != null) g.cur.t = r1(odds.total);
    if (g.open.sh == null && g.cur.sh != null) { g.open.sh = g.cur.sh; g.open.ss = 'first'; g.open.at ||= now; }
    if (g.open.t == null && g.cur.t != null) { g.open.t = g.cur.t; g.open.ts = 'first'; g.open.at ||= now; }
    g.provider = odds.provider || g.provider;
  } else if (g.cur.sh == null && g.cur.t == null) {
    // Started or finished before we saw it pre-game: use the closing line as "current",
    // but never invent an opener from it.
    g.cur.sh = r1(odds.spreadHome);
    g.cur.t = r1(odds.total);
    g.provider = odds.provider || g.provider;
  }
}

export function applyClosing(day, oddsById, now) {
  for (const [id, odds] of Object.entries(oddsById || {})) {
    if (day.games[id]) applyOdds(day.games[id], odds, now, false);
  }
}

// Reshape a basketball game into the same shape the football cards use, so the
// comparison, flags, and grading code is shared. Away team is listed first.
export function adapt(g) {
  const sh = v => (v == null ? null : -v); // home spread -> away team's line
  const game = {
    id: g.id,
    league: 'cbb',
    kickoff: g.date,
    timeLabel: new Date(g.date).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase(),
    teams: g.teams.map((t, i) => ({ name: t.n, alt: t.alt, rank: t.rank, record: t.rec, conf: t.conf, line: i === 0 ? sh(g.open.sh) : null })),
    total: g.open.t,
    final: g.completed && g.scores ? g.scores : null,
    openSrc: g.open.ss === 'espn' || g.open.ts === 'espn' ? 'espn' : g.open.ss || g.open.ts ? 'first' : null,
    neutral: g.neutral,
  };
  const live = {
    state: g.state,
    completed: g.completed,
    detail: g.detail,
    line1: sh(g.cur.sh),
    total: g.cur.t,
    scores: g.scores,
    provider: g.provider,
  };
  return { game, live };
}

// Compact record per finished game for the hit rate tile, so the tile can cover the
// whole season without loading every day's full slate.
export function gradedRows(day) {
  const out = [];
  for (const g of Object.values(day.games || {})) {
    if (!g.completed) continue;
    const { game, live } = adapt(g);
    const r = grade(game, live, compare(game, live, { spread: 99, total: 99 }));
    if (!r || (!r.spread && !r.total)) continue;
    out.push({
      s: r.spread ? [r.spread.gap, r.spread.hit] : null,
      t: r.total ? [r.total.gap, r.total.hit] : null,
      c: g.teams.map(t => t.conf),
      k: g.teams.some(t => t.rank),
    });
  }
  return out;
}
