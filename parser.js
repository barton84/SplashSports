// Parses the text you get from select-all + copy on a Splash Sports pick'em page.
// Pure functions only, so the same file runs in the browser and in Node for testing.

const NFL_TEAMS = new Set([
  'cardinals', 'falcons', 'ravens', 'bills', 'panthers', 'bears', 'bengals', 'browns',
  'cowboys', 'broncos', 'lions', 'packers', 'texans', 'colts', 'jaguars', 'chiefs',
  'raiders', 'chargers', 'rams', 'dolphins', 'vikings', 'patriots', 'saints', 'giants',
  'jets', 'eagles', 'steelers', '49ers', 'seahawks', 'buccaneers', 'titans', 'commanders',
]);

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

const DAY_RE = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+([A-Za-z]{3,9})\.?\s+(\d{1,2})$/;
const TIME_RE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{1,2}):(\d{2})\s*(am|pm)$/i;
const RECORD_RE = /^\d{1,2}-\d{1,2}(-\d{1,2})?$/;
const SPREAD_RE = /^([+-]?\d{1,2}(\.\d)?|PK|EVEN|Pick'?em)$/i;
const RANK_RE = /^#(\d{1,2})\s*ranked/i;
const SCORE_RE = /^\d{1,3}$/;
const OVER_RE = /^Over\s+(\d{1,3}(\.\d)?)$/i;
const UNDER_RE = /^Under\s+(\d{1,3}(\.\d)?)$/i;

export function normName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[‘’ʻ']/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function parseSpread(s) {
  if (/^(PK|EVEN|Pick'?em)$/i.test(s)) return 0;
  return parseFloat(s);
}

function isNflTeam(name) {
  return NFL_TEAMS.has(normName(name));
}

export function gameKey(g) {
  return `${g.league}|${normName(g.teams[0].name)}|${normName(g.teams[1].name)}`;
}

export function parseSplash(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = { label: null, lockText: null, games: [], warnings: [] };

  let year = new Date().getFullYear();
  for (let i = 0; i < lines.length; i++) {
    if (!out.label && /week\s+\d+/i.test(lines[i]) && lines[i].length < 60) out.label = lines[i];
    if (/^Picks lock:?$/i.test(lines[i]) && lines[i + 1]) {
      out.lockText = lines[i + 1];
      const y = lines[i + 1].match(/\b(20\d{2})\b/);
      if (y) year = +y[1];
    }
  }

  let day = null;
  let i = 0;
  while (i < lines.length) {
    const dm = lines[i].match(DAY_RE);
    if (dm) {
      const mon = MONTHS[dm[2].slice(0, 3).toLowerCase()];
      day = { label: lines[i], month: mon, date: +dm[3] };
      i++;
      continue;
    }
    if (!day) { i++; continue; }

    const g = tryGame(lines, i, day, year);
    if (g) {
      out.games.push(g.game);
      i = g.next;
    } else {
      i++;
    }
  }

  // Duplicate keys can happen if the page was pasted twice; keep the first.
  const seen = new Set();
  out.games = out.games.filter(g => (seen.has(g.id) ? false : seen.add(g.id)));
  if (!out.games.length) out.warnings.push('No games found. Make sure you copied the whole pick\'em page.');
  return out;
}

function tryGame(L, start, day, year) {
  let i = start;
  const name1 = L[i];
  if (!name1 || SCORE_RE.test(name1) || OVER_RE.test(name1)) return null;

  let scores = null, name2, status, time = null;
  if (SCORE_RE.test(L[i + 1] || '') && L[i + 2] === '-' && SCORE_RE.test(L[i + 3] || '')) {
    scores = [+L[i + 1], +L[i + 3]];
    name2 = L[i + 4];
    status = L[i + 5];
    i += 6;
  } else {
    name2 = L[i + 1];
    status = L[i + 2];
    i += 3;
  }
  if (!name2 || !status) return null;
  if (TIME_RE.test(L[i] || '')) { time = L[i]; i++; }

  const teams = [];
  let guard = 0;
  while (teams.length < 2 && i < L.length && guard++ < 12) {
    let rank = null;
    const rm = L[i].match(RANK_RE);
    if (rm) { rank = +rm[1]; i++; }
    const name = L[i], rec = L[i + 1], spr = L[i + 2];
    if (name && RECORD_RE.test(rec || '') && SPREAD_RE.test(spr || '')) {
      teams.push({ name, record: rec, rank, line: parseSpread(spr) });
      i += 3;
    } else {
      i++;
    }
  }
  if (teams.length < 2) return null;
  if (normName(teams[0].name) !== normName(name1) || normName(teams[1].name) !== normName(name2)) return null;

  let total = null;
  for (let k = 0; k < 6 && i < L.length; k++, i++) {
    const om = L[i].match(OVER_RE);
    if (om) {
      total = parseFloat(om[1]);
      if (UNDER_RE.test(L[i + 1] || '')) i++;
      i++;
      break;
    }
  }

  const league = isNflTeam(teams[0].name) && isNflTeam(teams[1].name) ? 'nfl' : 'cfb';

  let hh = 12, mm = 0;
  const tm = time && time.match(TIME_RE);
  if (tm) {
    hh = (+tm[2] % 12) + (tm[4].toLowerCase() === 'pm' ? 12 : 0);
    mm = +tm[3];
  }
  const kickoff = new Date(year, day.month, day.date, hh, mm).toISOString();

  const game = {
    league,
    dayLabel: day.label,
    timeLabel: time ? time.replace(/^\w+\s+/, '') : null,
    kickoff,
    status,
    teams,
    total,
    final: /^final/i.test(status) && scores ? scores : null,
  };
  game.id = gameKey(game);
  return { game, next: i };
}
