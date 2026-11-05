// Matching Splash games to ESPN games, and the math for line movement and results.
import { normName } from './parser.js';

// Splash name -> ESPN name, for schools where the two don't line up.
const ALIASES = {
  'miami fl': 'miami',
  'louisiana monroe': 'ul monroe',
  'umass': 'massachusetts',
  'appalachian state': 'app state',
  'florida international': 'fiu',
  'hawaii': 'hawaii',
  'southern miss': 'southern mississippi',
  'sam houston': 'sam houston',
  'ole miss': 'ole miss',
};

function namesFor(t) {
  const s = new Set();
  for (const v of [t.location, t.short, t.display, t.name, t.abbr]) if (v) s.add(normName(v));
  return s;
}

function exactMatch(splashName, espnTeam) {
  const n = normName(splashName);
  const names = namesFor(espnTeam);
  return names.has(n) || (ALIASES[n] && names.has(ALIASES[n]));
}

function looseMatch(splashName, espnTeam) {
  const n = normName(splashName);
  const d = normName(espnTeam.display);
  return d.startsWith(n + ' ');
}

// Returns { event, flip } where flip=true means Splash team[0] is ESPN's second competitor.
export function findEvent(game, events) {
  const [a, b] = game.teams.map(t => t.name);
  for (const test of [exactMatch, looseMatch]) {
    for (const ev of events) {
      const [x, y] = ev.teams;
      if (test(a, x) && test(b, y)) return { event: ev, order: [0, 1] };
      if (test(a, y) && test(b, x)) return { event: ev, order: [1, 0] };
    }
  }
  return null;
}

// Converts an ESPN event into lines from the point of view of Splash's team order.
export function liveFromEvent(game, match) {
  const { event, order } = match;
  const t1 = event.teams[order[0]], t2 = event.teams[order[1]];
  let line1 = null;
  if (event.odds && event.odds.spreadHome != null) {
    line1 = t1.homeAway === 'home' ? event.odds.spreadHome : -event.odds.spreadHome;
  }
  const scores = t1.score != null && t2.score != null ? [t1.score, t2.score] : null;
  return {
    eventId: event.id,
    state: event.state,
    completed: event.completed,
    detail: event.detail,
    line1: line1 === null ? null : Math.round(line1 * 10) / 10 + 0,
    total: event.odds?.total ?? null,
    provider: event.odds?.provider || null,
    scores,
  };
}

// Merge a fresh sync into the saved record. Once a game kicks off we keep the last
// pre-game number as the "close" so in-game odds never leak in.
export function mergeLive(prev, fresh, now) {
  const started = fresh.state !== 'pre';
  const next = { ...prev, ...fresh, syncedAt: now };
  if (started && prev && (prev.line1 != null || prev.total != null)) {
    next.line1 = prev.line1;
    next.total = prev.total;
    next.provider = prev.provider;
  }
  if (!started) next.preGameAt = now;
  return next;
}

export function fmtLine(v) {
  if (v == null || Number.isNaN(v)) return '--';
  if (v === 0) return 'PK';
  return (v > 0 ? '+' : '') + v;
}

export function fmtMove(v) {
  if (v == null || v === 0) return '0';
  return (v > 0 ? '+' : '') + v.toFixed(1).replace(/\.0$/, '');
}

// Splash line vs ESPN line for one game, from Splash's team order.
// gap > 0 on the spread means team 1 gets more points on ESPN than on Splash,
// so team 2 is the better side at Splash's number.
export function compare(game, live, th) {
  const s1 = game.teams[0].line;
  const e1 = live?.line1 ?? null;
  const sT = game.total;
  const eT = live?.total ?? null;
  const out = { spreadGap: null, totalGap: null, spreadFlag: false, totalFlag: false, spreadSide: null, totalSide: null };
  if (e1 != null) {
    out.spreadGap = round(e1 - s1);
    out.spreadFlag = Math.abs(out.spreadGap) >= th.spread;
    if (out.spreadGap) out.spreadSide = out.spreadGap > 0 ? 1 : 0;
  }
  if (eT != null && sT != null) {
    out.totalGap = round(eT - sT);
    out.totalFlag = Math.abs(out.totalGap) >= th.total;
    if (out.totalGap) out.totalSide = out.totalGap > 0 ? 'over' : 'under';
  }
  out.flagged = out.spreadFlag || out.totalFlag;
  out.size = Math.max(Math.abs(out.spreadGap || 0), Math.abs(out.totalGap || 0));
  return out;
}

function round(v) {
  return Math.round(v * 10) / 10 + 0;
}

// After a game is final: did the side the gap favored at Splash cover Splash's number?
// hit is true, false, or null for a push.
export function grade(game, live, c) {
  const scores = live?.completed && live.scores ? live.scores : game.final;
  if (!scores) return null;
  const out = {};
  if (c.spreadSide != null) {
    const idx = c.spreadSide;
    const line = idx === 0 ? game.teams[0].line : -game.teams[0].line;
    const margin = idx === 0 ? scores[0] - scores[1] : scores[1] - scores[0];
    const r = margin + line;
    out.spread = { gap: Math.abs(c.spreadGap), hit: r > 0 ? true : r < 0 ? false : null };
  }
  if (c.totalSide && game.total != null) {
    const sum = scores[0] + scores[1];
    out.total = { gap: Math.abs(c.totalGap), hit: sum === game.total ? null : (sum > game.total) === (c.totalSide === 'over') };
  }
  return out;
}

// Tuesday on or before the given date, as YYYY-MM-DD (local time).
export function weekStart(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() - 2 + 7) % 7));
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
