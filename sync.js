// Syncing with ESPN, shared by the page's Sync button and the daily scheduled run.
// The caller passes in how to reach ESPN:
//   scoreboard(league, fromYYYYMMDD, toYYYYMMDD) -> events
//   closing(league, [eventIds])                  -> { id: odds }
import { findEvent, liveFromEvent, mergeLive } from './logic.js';
import { mergeDay, applyClosing } from './cbb.js';

export const TZ = 'America/Chicago';

// Calendar date in Central time as YYYYMMDD, whatever time zone the code runs in.
export function ymdIn(date, tz = TZ) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(date))
    .replace(/-/g, '');
}

function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Football: match each Splash game to ESPN and update its ESPN line and score.
export async function syncWeek(w, { scoreboard, closing }) {
  const now = new Date().toISOString();
  const leagues = [...new Set(w.games.map(g => g.league))];
  const byLeague = {};
  await Promise.all(leagues.map(async lg => {
    const times = w.games.filter(g => g.league === lg).map(g => Date.parse(g.kickoff));
    const from = ymdIn(Math.min(...times));
    const to = ymdIn(Math.max(...times) + 864e5);
    byLeague[lg] = await scoreboard(lg, from, to);
  }));

  w.live ||= {};
  const unmatched = [];
  const needClose = {};
  for (const g of w.games) {
    const m = findEvent(g, byLeague[g.league] || []);
    if (!m) { unmatched.push(g.id); continue; }
    w.live[g.id] = mergeLive(w.live[g.id], liveFromEvent(g, m), now);
    const lv = w.live[g.id];
    if (m.event.completed && lv.line1 == null && lv.total == null) (needClose[g.league] ||= []).push({ g, m });
  }

  // Finished games lose their odds on the scoreboard; fetch the closing line instead.
  await Promise.all(Object.entries(needClose).map(async ([lg, list]) => {
    for (const part of chunks(list, 40)) {
      const odds = await closing(lg, part.map(x => x.m.event.id)).catch(() => ({}));
      for (const { g, m } of part) {
        if (!odds[m.event.id]) continue;
        w.live[g.id] = mergeLive(w.live[g.id], liveFromEvent(g, { event: { ...m.event, odds: odds[m.event.id] }, order: m.order }), now);
      }
    }
  }));

  w.unmatched = unmatched;
  w.lastSync = now;
  w.updatedAt = now;
  return { unmatched };
}

// Basketball: pull one day's Division I slate and update openers, current lines, scores.
export async function syncDay(day, { scoreboard, closing }) {
  const now = new Date().toISOString();
  const events = await scoreboard('cbb', day.id, day.id);
  const need = mergeDay(day, events, now);
  for (const part of chunks(need, 40)) {
    const odds = await closing('cbb', part).catch(() => ({}));
    applyClosing(day, odds, now);
  }
  return { games: events.length };
}
