// Vercel serverless function: pulls ESPN's scoreboard for a date range and returns
// a compact list of games with scores, status, and ESPN's current spread/total.
//   GET /api/lines?league=nfl|cfb&from=YYYYMMDD&to=YYYYMMDD

const BASE = {
  nfl: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard',
  cfb: 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard',
};

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
  if (v == null) return null;
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
  return { provider: o.provider?.name || 'ESPN', details: d || null, spreadHome, total };
}

function compactEvent(ev) {
  const comp = ev.competitions?.[0];
  if (!comp) return null;
  const st = comp.status?.type || ev.status?.type || {};
  return {
    id: ev.id,
    date: ev.date,
    state: st.state || 'pre',
    completed: !!st.completed,
    detail: st.shortDetail || st.detail || '',
    teams: comp.competitors.map(c => ({
      homeAway: c.homeAway,
      score: c.score != null && c.score !== '' ? +c.score : null,
      location: c.team?.location,
      name: c.team?.name,
      short: c.team?.shortDisplayName,
      display: c.team?.displayName,
      abbr: c.team?.abbreviation,
    })),
    odds: parseOdds(comp),
  };
}

// ESPN drops odds from the scoreboard once a game is final, but each game's summary
// page keeps the closing line in "pickcenter".
async function closingLines(league, ids) {
  const base = BASE[league].replace(/scoreboard$/, 'summary');
  const out = {};
  await Promise.all(ids.map(async id => {
    try {
      const r = await fetch(`${base}?event=${id}`, { headers: { 'User-Agent': 'line-tracker' } });
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
  if (!BASE[league]) return res.status(400).json({ error: 'league must be nfl or cfb' });
  if (close) {
    const ids = String(close).split(',').filter(x => /^\d{1,12}$/.test(x)).slice(0, 60);
    res.setHeader('Cache-Control', 's-maxage=3600');
    return res.status(200).json({ league, odds: await closingLines(league, ids) });
  }
  if (!/^\d{8}$/.test(from || '') || !/^\d{8}$/.test(to || '')) {
    return res.status(400).json({ error: 'from and to must be YYYYMMDD' });
  }

  const urls = dayList(from, to).map(day => {
    const u = new URL(BASE[league]);
    u.searchParams.set('dates', day);
    u.searchParams.set('limit', '400');
    if (league === 'cfb') u.searchParams.set('groups', '80');
    return u.toString();
  });

  try {
    const pages = await Promise.all(urls.map(async u => {
      const r = await fetch(u, { headers: { 'User-Agent': 'line-tracker' } });
      if (!r.ok) throw new Error(`ESPN ${r.status}`);
      return r.json();
    }));
    const byId = new Map();
    for (const p of pages) for (const ev of p.events || []) {
      const c = compactEvent(ev);
      if (c) byId.set(c.id, c);
    }
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=60');
    return res.status(200).json({ league, fetchedAt: new Date().toISOString(), events: [...byId.values()] });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
