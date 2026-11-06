// Vercel serverless function: pulls ESPN's scoreboard for a date range and returns
// a compact list of games with scores, status, and ESPN's current spread/total.
//   GET /api/lines?league=nfl|cfb|cbb&from=YYYYMMDD&to=YYYYMMDD
//   GET /api/lines?league=...&close=id1,id2   -> closing lines for finished games
// The fetch functions are exported so the daily scheduled sync can use them directly.

const BASE = {
  nfl: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard',
  cfb: 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard',
  cbb: 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard',
};
// ESPN group ids for "all of Division I" in each college sport.
const GROUPS = { cfb: '80', cbb: '50' };

// Fallback names for ESPN's men's basketball conference ids. Names found in the
// scoreboard data itself take priority over these.
const CBB_CONF = {
  1: 'America East', 2: 'ACC', 3: 'Atlantic 10', 4: 'Big East', 5: 'Big Sky', 6: 'Big South',
  7: 'Big Ten', 8: 'Big 12', 9: 'Big West', 10: 'CAA', 11: 'Conference USA', 12: 'Ivy League',
  13: 'MAAC', 14: 'MAC', 16: 'MEAC', 18: 'Missouri Valley', 19: 'NEC', 20: 'Ohio Valley',
  21: 'Pac-12', 22: 'Patriot', 23: 'SEC', 24: 'SoCon', 25: 'Southland', 26: 'SWAC',
  27: 'Sun Belt', 29: 'WCC', 30: 'WAC', 44: 'Mountain West', 45: 'Horizon', 46: 'ASUN',
  49: 'Summit', 62: 'American',
};

const UA = { headers: { 'User-Agent': 'line-tracker' } };

function dayList(from, to) {
  const d = new Date(Date.UTC(+from.slice(0, 4), +from.slice(4, 6) - 1, +from.slice(6, 8)));
  const end = new Date(Date.UTC(+to.slice(0, 4), +to.slice(4, 6) - 1, +to.slice(6, 8)));
  const out = [];
  while (d <= end && out.length < 10) {
    out.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/^[ou]/i, ''));
  return Number.isFinite(n) ? n : null;
}

export function parseOdds(comp) {
  const o = (comp.odds || [])[0];
  if (!o) return null;
  const home = comp.competitors.find(c => c.homeAway === 'home');
  const away = comp.competitors.find(c => c.homeAway === 'away');
  let spreadHome = null;

  const d = (o.details || '').trim();
  if (/^(even|pk|pick'?em)$/i.test(d)) spreadHome = 0;
  else {
    const m = d.match(/^(.+?)\s+([+-]?\d+(?:\.\d+)?)$/);
    if (m) {
      const abbr = m[1].toUpperCase();
      if (abbr === (home?.team?.abbreviation || '').toUpperCase()) spreadHome = +m[2];
      else if (abbr === (away?.team?.abbreviation || '').toUpperCase()) spreadHome = -m[2];
    }
  }
  if (spreadHome == null) spreadHome = num(o.pointSpread?.home?.close?.line);
  if (spreadHome == null && typeof o.spread === 'number') spreadHome = o.spread;

  const total = num(o.overUnder) ?? num(o.total?.over?.close?.line);

  // Some ESPN feeds also carry the opening number. Used by the basketball tab.
  let openSpreadHome = num(o.pointSpread?.home?.open?.line);
  if (openSpreadHome == null) {
    const a = num(o.pointSpread?.away?.open?.line);
    if (a != null) openSpreadHome = -a;
  }
  const openTotal = num(o.total?.over?.open?.line) ?? num(o.total?.under?.open?.line);

  return { provider: o.provider?.name || 'ESPN', details: d || null, spreadHome, total, openSpreadHome, openTotal };
}

function compactEvent(ev, confNames) {
  const comp = ev.competitions?.[0];
  if (!comp) return null;
  const st = comp.status?.type || ev.status?.type || {};
  return {
    id: ev.id,
    date: ev.date,
    state: st.state || 'pre',
    completed: !!st.completed,
    detail: st.shortDetail || st.detail || '',
    neutral: !!comp.neutralSite,
    teams: comp.competitors.map(c => {
      const rank = c.curatedRank?.current;
      const confId = c.team?.conferenceId;
      return {
        homeAway: c.homeAway,
        score: c.score != null && c.score !== '' ? +c.score : null,
        location: c.team?.location,
        name: c.team?.name,
        short: c.team?.shortDisplayName,
        display: c.team?.displayName,
        abbr: c.team?.abbreviation,
        rank: rank && rank < 99 ? rank : null,
        record: c.records?.[0]?.summary || null,
        conf: confId != null ? confNames[confId] || CBB_CONF[confId] || `Conference ${confId}` : null,
      };
    }),
    odds: parseOdds(comp),
  };
}

export async function scoreboard(league, from, to) {
  const urls = dayList(from, to).map(day => {
    const u = new URL(BASE[league]);
    u.searchParams.set('dates', day);
    u.searchParams.set('limit', '400');
    if (GROUPS[league]) u.searchParams.set('groups', GROUPS[league]);
    return u.toString();
  });
  const pages = await Promise.all(urls.map(async u => {
    const r = await fetch(u, UA);
    if (!r.ok) throw new Error(`ESPN ${r.status}`);
    return r.json();
  }));

  // Conference games carry the conference name; use it for both teams' conference id.
  const confNames = {};
  for (const p of pages) for (const ev of p.events || []) {
    const g = ev.competitions?.[0]?.groups;
    if (g?.isConference && g.id) confNames[g.id] = g.shortName || g.name;
  }

  const byId = new Map();
  for (const p of pages) for (const ev of p.events || []) {
    const c = compactEvent(ev, league === 'cbb' ? confNames : {});
    if (c) byId.set(c.id, c);
  }
  return [...byId.values()];
}

// ESPN drops odds from the scoreboard once a game is final, but each game's summary
// page keeps the closing line in "pickcenter".
export async function closingLines(league, ids) {
  const base = BASE[league].replace(/scoreboard$/, 'summary');
  const out = {};
  await Promise.all(ids.map(async id => {
    try {
      const r = await fetch(`${base}?event=${id}`, UA);
      if (!r.ok) return;
      const j = await r.json();
      const comp = j.header?.competitions?.[0];
      const pc = (j.pickcenter || []).filter(p => p && (p.details || p.overUnder != null));
      if (!comp || !pc.length) return;
      const odds = parseOdds({ odds: pc, competitors: comp.competitors || [] });
      if (odds && (odds.spreadHome != null || odds.total != null)) out[id] = odds;
    } catch {}
  }));
  return out;
}

export default async function handler(req, res) {
  const { league, from, to, close } = req.query || {};
  if (!BASE[league]) return res.status(400).json({ error: 'league must be nfl, cfb, or cbb' });
  if (close) {
    const ids = String(close).split(',').filter(x => /^\d{1,12}$/.test(x)).slice(0, 60);
    res.setHeader('Cache-Control', 's-maxage=3600');
    return res.status(200).json({ league, odds: await closingLines(league, ids) });
  }
  if (!/^\d{8}$/.test(from || '') || !/^\d{8}$/.test(to || '')) {
    return res.status(400).json({ error: 'from and to must be YYYYMMDD' });
  }
  try {
    const events = await scoreboard(league, from, to);
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=60');
    return res.status(200).json({ league, fetchedAt: new Date().toISOString(), events });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
