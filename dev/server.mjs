// Local test server. Serves the app and /api/lines.
//   node dev/server.mjs          -> /api/lines calls ESPN for real
//   MOCK=1 node dev/server.mjs   -> /api/lines returns fake movement built from dev/sample-paste.txt
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from '../api/lines.js';
import storeHandler from '../api/store.js';
import cronHandler from '../api/cron.js';
import { parseSplash, normName } from '../parser.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +process.env.PORT || 5173;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

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
  // Final mix so keys that differ by one character still spread out.
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
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
// ---------- mock men's college basketball ----------
const CBB_TEAMS = [
  ['Duke', 'ACC', 3], ['North Carolina', 'ACC', 11], ['Virginia', 'ACC'], ['Louisville', 'ACC'], ['Clemson', 'ACC'], ['Miami', 'ACC'], ['NC State', 'ACC'], ['Wake Forest', 'ACC'],
  ['Purdue', 'Big Ten', 4], ['Michigan State', 'Big Ten', 22], ['Illinois', 'Big Ten', 20], ['Wisconsin', 'Big Ten'], ['Indiana', 'Big Ten'], ['Iowa', 'Big Ten'], ['Ohio State', 'Big Ten'], ['Maryland', 'Big Ten'],
  ['Houston', 'Big 12', 2], ['Kansas', 'Big 12', 5], ['Iowa State', 'Big 12', 9], ['Baylor', 'Big 12', 19], ['Texas Tech', 'Big 12', 24], ['Arizona', 'Big 12', 12], ['BYU', 'Big 12', 25], ['Cincinnati', 'Big 12'],
  ['Auburn', 'SEC', 6], ['Alabama', 'SEC', 14], ['Tennessee', 'SEC', 8], ['Florida', 'SEC'], ['Kentucky', 'SEC', 15], ['Arkansas', 'SEC'], ['Texas A&M', 'SEC'], ['Missouri', 'SEC'],
  ['UConn', 'Big East', 1], ['Marquette', 'Big East', 10], ['Creighton', 'Big East', 17], ['Villanova', 'Big East'], ["St. John's", 'Big East'], ['Xavier', 'Big East'], ['Providence', 'Big East'], ['Seton Hall', 'Big East'],
  ['Gonzaga', 'WCC', 7], ["Saint Mary's", 'WCC'], ['San Diego State', 'Mountain West'], ['Utah State', 'Mountain West'], ['Boise State', 'Mountain West'], ['New Mexico', 'Mountain West'],
  ['Memphis', 'American'], ['Florida Atlantic', 'American'], ['Wichita State', 'American'], ['Dayton', 'Atlantic 10'], ['VCU', 'Atlantic 10'], ['Saint Louis', 'Atlantic 10'],
  ['Drake', 'Missouri Valley'], ['Bradley', 'Missouri Valley'], ['Grambling', 'SWAC'], ['Alcorn State', 'SWAC'], ['Coppin State', 'MEAC'], ['Norfolk State', 'MEAC'],
  ['Lehigh', 'Patriot'], ['Colgate', 'Patriot'], ['Montana', 'Big Sky'], ['Weber State', 'Big Sky'], ['Wagner', 'NEC'], ['Long Island', 'NEC'],
];

// Deterministic fake slate for a date (YYYYMMDD). Game state follows the real clock,
// so today has finals, one live game, and upcoming games.
function mockCbb(date) {
  const order = CBB_TEAMS.map((t, i) => [hash(date + t[0]), i]).sort((a, b) => a[0] - b[0]).map(x => CBB_TEAMS[x[1]]);
  const games = [];
  const now = Date.now();
  const y = +date.slice(0, 4), m = +date.slice(4, 6) - 1, d = +date.slice(6, 8);
  for (let i = 0; i + 1 < order.length; i += 2) {
    const n = i / 2;
    const away = order[i], home = order[i + 1];
    const key = date + n;
    const r = hash(key), r2 = hash(key + 'b'), r3 = hash(key + 'c'), r4 = hash(key + 'd');
    // Tip times 11:00 to 21:30 Central (UTC-6 in November).
    const mins = 11 * 60 + Math.floor(r * 22) * 30;
    const tip = Date.UTC(y, m, d, 6 + Math.floor(mins / 60), mins % 60);
    const openHome = Math.round((r2 - 0.62) * 30) / 2 || -1.5;
    const openTotal = Math.round((138 + r3 * 24) * 2) / 2;
    const moveS = r4 < 0.45 ? 0 : Math.round((hash(key + 'e') - 0.5) * 12) / 2;
    const moveT = hash(key + 'f') < 0.5 ? 0 : Math.round((hash(key + 'g') - 0.5) * 14) / 2;
    const espnOpen = hash(key + 'h') < 0.6;
    const closeHome = openHome + moveS, closeTotal = openTotal + moveT;
    const live = n === 3 && date === mockToday() && tip > now - 3 * 36e5 ? true : false;
    const done = !live && tip + 2 * 36e5 < now;
    const state = live ? 'in' : done ? 'post' : now >= tip ? 'in' : 'pre';
    const margin = Math.round(-closeHome + (hash(key + 'i') - 0.5) * 26);
    const sum = Math.round(closeTotal + (hash(key + 'j') - 0.5) * 30);
    const hs = Math.round((sum + margin) / 2), as = sum - hs;
    const half = state === 'in';
    const team = (t, ha, score) => ({
      homeAway: ha, score, location: t[0], name: 'Mascots', short: t[0], display: `${t[0]} Mascots`,
      abbr: normName(t[0]).replace(/ /g, '').slice(0, 5).toUpperCase(), rank: t[2] || null,
      record: `${1 + Math.floor(hash(t[0]) * 3)}-${Math.floor(hash(t[0] + 'l') * 2)}`, conf: t[1],
    });
    games.push({
      id: `${date}${String(n).padStart(3, '0')}`,
      date: new Date(tip).toISOString(),
      state, completed: state === 'post', neutral: false,
      detail: state === 'post' ? 'Final' : half ? '2nd 8:41' : '',
      teams: [team(away, 'away', state === 'pre' ? null : half ? Math.round(as * 0.7) : as), team(home, 'home', state === 'pre' ? null : half ? Math.round(hs * 0.7) : hs)],
      odds: {
        provider: 'ESPN BET', details: null,
        spreadHome: closeHome, total: closeTotal,
        openSpreadHome: espnOpen ? openHome : null, openTotal: espnOpen ? openTotal : null,
      },
    });
  }
  return games;
}
function mockToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date()).replace(/-/g, '');
}
// Same rules as the real scoreboard: finished games come back with no odds.
const mockEspn = {
  async scoreboard(league, from) {
    if (league === 'cbb') return mockCbb(from).map(e => (e.completed ? { ...e, odds: null } : e));
    return mockEvents(league).map(e => (e.completed ? { ...e, odds: null } : e));
  },
  async closing(league, ids) {
    const pool = league === 'cbb' ? [...new Set(ids.map(id => id.slice(0, 8)))].flatMap(mockCbb) : mockEvents(league);
    const want = new Set(ids.map(String));
    return Object.fromEntries(pool.filter(e => want.has(e.id)).map(e => [e.id, e.odds]));
  },
};
if (process.env.MOCK) {
  globalThis.__lineTrackerEspn = mockEspn;
  process.env.CRON_SECRET ||= 'devsecret';
}

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
    case 'HGET': return h.get(args[0]) ?? null;
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
  if (url.pathname === '/api/cron') {
    return cronHandler(Object.assign(req, { query }), shimRes(res));
  }
  if (url.pathname === '/api/lines') {
    if (process.env.MOCK) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (query.close) {
        const odds = await mockEspn.closing(query.league, query.close.split(','));
        return res.end(JSON.stringify({ league: query.league, odds }));
      }
      const events = await mockEspn.scoreboard(query.league, query.from, query.to);
      return res.end(JSON.stringify({ league: query.league, fetchedAt: new Date().toISOString(), events }));
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
