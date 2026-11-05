// Local test server. Serves the app and /api/lines.
//   node dev/server.mjs          -> /api/lines calls ESPN for real
//   MOCK=1 node dev/server.mjs   -> /api/lines returns fake movement built from dev/sample-paste.txt
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from '../api/lines.js';
import storeHandler from '../api/store.js';
import { parseSplash, normName } from '../parser.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +process.env.PORT || 5173;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

// ESPN spells a few schools differently than Splash; mirror that so matching gets tested.
const ESPN_NAMES = {
  'Miami (FL)': { location: 'Miami', short: 'Miami', abbr: 'MIA' },
  'Louisiana-Monroe': { location: 'UL Monroe', short: 'UL Monroe', abbr: 'ULM' },
  UMass: { location: 'Massachusetts', short: 'UMass', abbr: 'MASS' },
  'Appalachian State': { location: 'App State', short: 'App State', abbr: 'APP' },
  'Florida International': { location: 'Florida International', short: 'FIU', abbr: 'FIU' },
  "Hawai'i": { location: "Hawai'i", short: "Hawai'i", abbr: 'HAW' },
};

function hash(s) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0) / 4294967296;
}

function mockEvents(league) {
  const { games } = parseSplash(fs.readFileSync(path.join(root, 'dev/sample-paste.txt'), 'utf8'));
  // A few hand-set closes so the screenshots show every result state.
  const fixed = {
    'Ohio|Akron': { d: 3, t: -3 },
    'Ball State|UMass': { d: -3, t: 0 },
    'Central Michigan|Eastern Michigan': { d: -4, t: 1.5 },
    'Buffalo|Miami (OH)': { d: 0, t: 2 },
    'UTSA|Florida Atlantic': { d: -2, t: 1 },
    'Jaguars|Ravens': { d: 1.5, t: -1 },
    'Bills|Vikings': { d: -1, t: 0 },
    'Georgia|Ole Miss': { d: -1.5, t: 0 },
  };
  return games.filter(g => g.league === league).map((g, n) => {
    const key = `${g.teams[0].name}|${g.teams[1].name}`;
    const r = hash(key), r2 = hash(key + 't');
    const d = fixed[key]?.d ?? (r < 0.5 ? 0 : Math.round((r - 0.75) * 12) / 2);
    const t = fixed[key]?.t ?? (r2 < 0.55 ? 0 : Math.round((r2 - 0.78) * 14) / 2);
    const home = g.teams[1], away = g.teams[0];
    const homeLine = home.line - d; // d moves toward team 1
    const team = (tm, ha, score) => {
      const o = ESPN_NAMES[tm.name] || {};
      const nfl = league === 'nfl';
      return {
        homeAway: ha, score,
        location: o.location || (nfl ? 'City' : tm.name),
        name: nfl ? tm.name : 'Mascots',
        short: o.short || tm.name,
        display: `${o.location || (nfl ? 'City' : tm.name)} ${nfl ? tm.name : 'Mascots'}`,
        abbr: o.abbr || normName(tm.name).replace(/ /g, '').slice(0, 4).toUpperCase() + n,
      };
    };
    const inGame = key === 'UTSA|Florida Atlantic' ? [24, 17] : null; // one live game for testing
    const awayT = team(away, 'away', g.final ? g.final[0] : inGame ? inGame[0] : null);
    const homeT = team(home, 'home', g.final ? g.final[1] : inGame ? inGame[1] : null);
    const fav = homeLine <= 0 ? homeT : awayT;
    return {
      id: String(1000 + n),
      date: g.kickoff,
      state: g.final ? 'post' : inGame ? 'in' : 'pre',
      completed: !!g.final,
      detail: g.final ? 'Final' : inGame ? '3rd 5:12' : '',
      teams: n % 9 === 4 ? [homeT, awayT] : [awayT, homeT],
      odds: {
        provider: 'ESPN BET',
        details: homeLine === 0 ? 'EVEN' : `${fav.abbr} ${-Math.abs(homeLine)}`,
        spreadHome: homeLine,
        total: g.total + t,
      },
    };
  });
}

// In mock mode, stand in for Upstash with an in-memory store so /api/store runs for real.
const mem = { hash: new Map(), kv: new Map() };
if (process.env.MOCK) {
  process.env.KV_REST_API_URL = `http://localhost:${PORT}/__redis`;
  process.env.KV_REST_API_TOKEN = 'dev';
  process.env.APP_PASSCODE ||= '1234';
}
function fakeRedis([cmd, key, ...args]) {
  const h = mem.hash.get(key) || new Map();
  switch (cmd) {
    case 'HGETALL': return [...h].flat();
    case 'HSET': h.set(args[0], args[1]); mem.hash.set(key, h); return 1;
    case 'HDEL': return h.delete(args[0]) ? 1 : 0;
    case 'GET': return mem.kv.get(key) ?? null;
    case 'SET': mem.kv.set(key, args[0]); return 'OK';
  }
  throw new Error('unsupported ' + cmd);
}

function shimRes(res) {
  return {
    statusCode: 200,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o) { res.writeHead(this.statusCode, { ...this.headers, 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); },
  };
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const query = Object.fromEntries(url.searchParams);
  if (url.pathname === '/__redis' && process.env.MOCK) {
    let body = '';
    for await (const c of req) body += c;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ result: fakeRedis(JSON.parse(body)) }));
  }
  if (url.pathname === '/api/store') {
    return storeHandler(Object.assign(req, { query }), shimRes(res));
  }
  if (url.pathname === '/api/lines') {
    if (process.env.MOCK) {
      const events = mockEvents(query.league);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (query.close) {
        // Closing lines for finished games, like ESPN's summary pages.
        const want = new Set(query.close.split(','));
        const odds = Object.fromEntries(events.filter(e => want.has(e.id)).map(e => [e.id, e.odds]));
        return res.end(JSON.stringify({ league: query.league, odds }));
      }
      // Like the real scoreboard, finished games come back with no odds.
      const board = events.map(e => (e.completed ? { ...e, odds: null } : e));
      return res.end(JSON.stringify({ league: query.league, fetchedAt: new Date().toISOString(), events: board }));
    }
    return handler({ query }, shimRes(res));
  }
  const file = path.join(root, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`http://localhost:${PORT}${process.env.MOCK ? '  (mock ESPN)' : ''}`));
