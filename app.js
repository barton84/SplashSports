import { parseSplash, normName } from './parser.js';
import { compare, grade, weekStart, fmtLine, fmtMove } from './logic.js';
import { adapt, gradedRows } from './cbb.js';
import { syncWeek, syncDay, ymdIn } from './sync.js';

const KEY = 'lineTracker.v2';
const OLD_KEY = 'lineTracker.v1';
const SPORT_KEY = 'lineTracker.sport';
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago';
const $ = id => document.getElementById(id);

const view = {
  sport: readSport(),
  league: 'all', market: 'both', flagged: false, hideFinal: false, sort: 'time',
  hitScope: 'all', hitMarket: 'both',
  team: '', conf: 'all',
  day: todayId(),
};
let store = load();
let pending = null;

function readSport() {
  try { return localStorage.getItem(SPORT_KEY) === 'cbb' ? 'cbb' : 'fb'; } catch { return 'fb'; }
}
function todayId() {
  return ymdIn(Date.now(), LOCAL_TZ);
}

// ---------- storage ----------
function blankCbb() {
  return { days: {}, graded: {}, index: {}, th: { spread: 1, total: 1 } };
}
function load() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(KEY)); } catch {}
  if (!s) {
    s = { th: { spread: 1, total: 1 }, weeks: {}, current: null };
    try {
      const old = JSON.parse(localStorage.getItem(OLD_KEY));
      if (old?.games?.length) {
        const w = makeWeek(old.games, old.label, old.lockText);
        Object.assign(w, { live: old.live || {}, lastSync: old.lastSync, unmatched: old.unmatched || [] });
        s.weeks[w.id] = w;
        s.current = w.id;
        if (old.th) s.th = old.th;
      }
    } catch {}
  }
  s.cbb = { ...blankCbb(), ...(s.cbb || {}) };
  if (!s.current || !s.weeks[s.current]) s.current = pickDefaultWeek(s.weeks);
  return s;
}
function save() {
  // Keep only the most recent basketball days in this browser; the cloud has the rest.
  const ids = Object.keys(store.cbb.days).sort();
  for (const id of ids.slice(0, Math.max(0, ids.length - 10))) if (id !== view.day) delete store.cbb.days[id];
  try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { toast('Could not save to this browser'); }
}

// ---------- shared storage (Vercel + Upstash) ----------
// The browser keeps a copy so the page opens instantly; the server copy is what
// keeps phone and desktop in step.
const PASS_KEY = 'lineTracker.pass';
const remote = { state: 'checking' }; // checking | on | off | locked | error

function pass() {
  try { return localStorage.getItem(PASS_KEY) || ''; } catch { return ''; }
}
async function api(method, q = '', body) {
  const r = await fetch(`/api/store${q}`, {
    method,
    headers: { 'x-passcode': pass(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, j };
}
function touch(w) {
  w.updatedAt = new Date().toISOString();
}
function stamp(w) {
  return Date.parse(w?.updatedAt || w?.lastSync || w?.savedAt || 0) || 0;
}

async function connect() {
  let res;
  try { res = await api('GET'); } catch { remote.state = 'error'; renderRemote(); return afterConnect(); }
  if (res.status === 503) { remote.state = 'off'; renderRemote(); return afterConnect(); }
  if (res.status === 401) { remote.state = 'locked'; renderRemote(); return; }
  if (res.status !== 200) { remote.state = 'error'; renderRemote(); return afterConnect(); }
  remote.state = 'on';
  renderRemote();

  // Football weeks: newest copy wins.
  const server = res.j.weeks || {};
  const merged = { ...server };
  const uploads = [];
  for (const [id, w] of Object.entries(store.weeks)) {
    const sv = server[id];
    if (!sv) {
      // Already pushed once but gone from the server means another device deleted it.
      if (w.remoteAt) continue;
      merged[id] = w;
      uploads.push(w);
    } else if (stamp(w) > stamp(sv)) {
      merged[id] = w;
      uploads.push(w);
    }
  }
  store.weeks = merged;
  if (res.j.settings?.th) store.th = res.j.settings.th;
  if (res.j.settings?.cbbTh) store.cbb.th = res.j.settings.cbbTh;
  if (!store.weeks[store.current]) store.current = pickDefaultWeek(store.weeks);

  // Basketball: the server has every day's graded results; full days load on demand.
  store.cbb.index = res.j.cbbIndex || {};
  store.cbb.graded = { ...store.cbb.graded, ...(res.j.cbbGraded || {}) };
  const dayUploads = Object.values(store.cbb.days).filter(d => stamp(d) > Date.parse(store.cbb.index[d.id]?.at || 0));

  save();
  render();
  for (const w of uploads) await pushWeek(w);
  for (const d of dayUploads) await pushDay(d);
  afterConnect();
}

// Runs once the storage check settles, whatever the result.
function afterConnect() {
  if (view.sport === 'cbb') openDay(view.day, { quiet: true });
}

async function pushWeek(w) {
  if (!w.updatedAt) touch(w);
  if (remote.state !== 'on') return;
  w.remoteAt = new Date().toISOString();
  const r = await api('PUT', `?week=${w.id}`, w).catch(() => null);
  if (!r || r.status !== 200) {
    delete w.remoteAt;
    toast('Saved on this device, but the cloud save failed');
  }
  save();
}

async function pushDay(d) {
  if (remote.state !== 'on') return;
  const r = await api('PUT', `?day=${d.id}`, d).catch(() => null);
  if (r?.status === 200) store.cbb.index[d.id] = { at: d.updatedAt, n: Object.keys(d.games).length };
  else toast('Saved on this device, but the cloud save failed');
  save();
}

async function pushSettings() {
  if (remote.state === 'on') await api('PUT', '?settings=1', { th: store.th, cbbTh: store.cbb.th }).catch(() => null);
}

function renderRemote() {
  const pill = $('cloudPill');
  const text = {
    checking: 'Connecting...',
    on: 'Synced across devices',
    off: 'This device only',
    locked: 'Enter passcode',
    error: 'Cloud unavailable',
  }[remote.state];
  pill.textContent = text;
  pill.className = `cloud ${remote.state}`;
  $('passPanel').hidden = remote.state !== 'locked';
}

$('cloudPill').onclick = () => {
  if (remote.state === 'off') toast('Shared storage is not set up on Vercel yet, so data stays in this browser');
  else if (remote.state === 'error') connect();
  else if (remote.state === 'locked') $('passInput').focus();
  else if (remote.state === 'on') connect().then(() => toast('Up to date'));
};

$('passForm').onsubmit = async e => {
  e.preventDefault();
  const v = $('passInput').value.trim();
  if (!v) return;
  try { localStorage.setItem(PASS_KEY, v); } catch {}
  await connect();
  if (remote.state === 'locked') {
    $('passMsg').textContent = 'That passcode did not work.';
  } else {
    $('passInput').value = '';
    $('passMsg').textContent = '';
    toast('Connected');
  }
};

// Pick up changes made on another device (or the daily sync) when you come back to the tab.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && remote.state === 'on') connect();
});

// ---------- football weeks ----------
function week() {
  return store.weeks[store.current] || null;
}
function pickDefaultWeek(weeks) {
  const ids = Object.keys(weeks).sort();
  if (!ids.length) return null;
  const now = weekStart(new Date());
  return ids.includes(now) ? now : ids[ids.length - 1];
}

function makeWeek(games, label, lockText) {
  // The slate runs Tuesday through Monday night. Use the Tuesday most games fall in.
  const counts = {};
  for (const g of games) { const k = weekStart(g.kickoff); counts[k] = (counts[k] || 0) + 1; }
  const id = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const [y, m, d] = id.split('-').map(Number);
  const end = new Date(y, m - 1, d + 6);
  return { id, end: end.toISOString(), label, lockText, savedAt: new Date().toISOString(), games, live: {}, lastSync: null, unmatched: [] };
}

function weekName(w) {
  const [y, m, d] = w.id.split('-').map(Number);
  const s = new Date(y, m - 1, d), e = new Date(y, m - 1, d + 6);
  const f = x => x.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${f(s)} to ${f(e)}`;
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), 3200);
}

// ---------- paste (football) ----------
$('linesBtn').onclick = () => {
  const p = $('pastePanel');
  p.hidden = !p.hidden;
  if (!p.hidden) $('pasteBox').focus();
};

$('pasteBox').addEventListener('input', () => {
  const text = $('pasteBox').value;
  if (!text.trim()) { pending = null; $('parsePreview').textContent = ''; $('saveBtn').disabled = true; return; }
  pending = parseSplash(text);
  const n = pending.games.length;
  if (!n) {
    $('parsePreview').innerHTML = `<span class="bad">${esc(pending.warnings[0] || 'Nothing recognized')}</span>`;
    $('saveBtn').disabled = true;
    return;
  }
  const w = makeWeek(pending.games, pending.label, pending.lockText);
  const exists = !!store.weeks[w.id];
  const nfl = pending.games.filter(g => g.league === 'nfl').length;
  $('parsePreview').innerHTML = `<strong>${n} games found</strong> &middot; ${nfl} NFL, ${n - nfl} College &middot; week of ${esc(weekName(w))}${exists ? ' <span class="warn">(replaces saved week)</span>' : ''}`;
  $('saveBtn').disabled = false;
  $('saveBtn').textContent = exists ? 'Replace this week' : 'Save as new week';
});

$('saveBtn').onclick = () => {
  if (!pending?.games.length) return;
  const w = makeWeek(pending.games, pending.label, pending.lockText);
  const prev = store.weeks[w.id];
  if (prev && !confirm(`Replace the saved week of ${weekName(w)}?`)) return;
  if (prev) {
    const keep = new Set(w.games.map(g => g.id));
    w.live = Object.fromEntries(Object.entries(prev.live || {}).filter(([id]) => keep.has(id)));
    w.lastSync = prev.lastSync;
  }
  touch(w);
  store.weeks[w.id] = w;
  store.current = w.id;
  save();
  pushWeek(w);
  $('pasteBox').value = '';
  pending = null;
  $('parsePreview').textContent = '';
  $('saveBtn').disabled = true;
  $('pastePanel').hidden = true;
  toast(`Saved ${w.games.length} games for ${weekName(w)}`);
  render();
};

$('deleteBtn').onclick = () => {
  const w = week();
  if (!w || !confirm(`Delete the week of ${weekName(w)}? This removes its Splash lines and ESPN data.`)) return;
  delete store.weeks[w.id];
  store.current = pickDefaultWeek(store.weeks);
  save();
  render();
  if (remote.state === 'on') api('DELETE', `?week=${w.id}`).catch(() => toast('Deleted here, but the cloud delete failed'));
};

$('weekSel').onchange = e => { store.current = e.target.value; save(); render(); };

// ---------- syncing ----------
// How the page reaches ESPN: through this app's /api/lines function.
const espn = {
  async scoreboard(league, from, to) {
    const r = await fetch(`/api/lines?league=${league}&from=${from}&to=${to}`);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j.events;
  },
  async closing(league, ids) {
    const r = await fetch(`/api/lines?league=${league}&close=${ids.join(',')}`);
    if (!r.ok) return {};
    return (await r.json()).odds || {};
  },
};

let syncing = false;
function busy(on) {
  syncing = on;
  $('syncBtn').disabled = on;
  $('syncBtn').textContent = on ? 'Syncing...' : 'Sync ESPN';
}

$('syncBtn').onclick = () => (view.sport === 'cbb' ? syncCbb() : syncFootball());

async function syncFootball() {
  const w = week();
  if (!w) return toast('Paste your Splash lines first');
  busy(true);
  try {
    const { unmatched } = await syncWeek(w, espn);
    save();
    pushWeek(w);
    toast(unmatched.length ? `Synced. ${unmatched.length} games not found on ESPN` : 'Synced with ESPN');
    render();
  } catch (e) {
    toast(`Sync failed: ${e.message}`);
  } finally {
    busy(false);
  }
}

// ---------- basketball days ----------
function dayObj() {
  return store.cbb.days[view.day] || null;
}
function shiftDay(id, n) {
  const d = new Date(Date.UTC(+id.slice(0, 4), +id.slice(4, 6) - 1, +id.slice(6, 8) + n));
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}
function dayName(id, opts = { weekday: 'long', month: 'short', day: 'numeric' }) {
  return new Date(+id.slice(0, 4), +id.slice(4, 6) - 1, +id.slice(6, 8)).toLocaleDateString([], opts);
}

// Show a day: use what's saved, grab a newer copy from the cloud if there is one,
// and pull from ESPN when the day is new or still has games to finish.
async function openDay(id, { quiet = false } = {}) {
  view.day = id;
  render();
  if (remote.state === 'on') {
    const at = Date.parse(store.cbb.index[id]?.at || 0);
    if (at && at > stamp(store.cbb.days[id])) {
      const r = await api('GET', `?day=${id}`).catch(() => null);
      if (r?.status === 200 && r.j.day) { store.cbb.days[id] = r.j.day; save(); }
      if (view.day === id) render();
    }
  }
  const d = store.cbb.days[id];
  const stale = !d || (Date.now() - stamp(d) > 10 * 60e3 && Object.values(d.games).some(g => !g.completed));
  if (stale && id <= shiftDay(todayId(), 7)) await syncCbb({ quiet: quiet && !!d });
}

async function syncCbb({ quiet = false } = {}) {
  if (syncing) return;
  const id = view.day;
  busy(true);
  if (!store.cbb.days[id]) $('empty').textContent = 'Loading games from ESPN...';
  try {
    const d = store.cbb.days[id] || { id, games: {} };
    await syncDay(d, espn);
    store.cbb.days[id] = d;
    store.cbb.graded[id] = gradedRows(d);
    save();
    pushDay(d);
    if (!quiet) toast(Object.keys(d.games).length ? 'Synced with ESPN' : 'No Division I games on this date');
  } catch (e) {
    toast(`Sync failed: ${e.message}`);
  } finally {
    busy(false);
    if (view.day === id) render();
  }
}

$('dayPick').onchange = e => { if (e.target.value) openDay(e.target.value.replace(/-/g, '')); };
$('dayPrev').onclick = () => openDay(shiftDay(view.day, -1));
$('dayNext').onclick = () => openDay(shiftDay(view.day, 1));
$('dayToday').onclick = () => openDay(todayId());

// ---------- controls ----------
function segClick(id, key, after) {
  $(id).addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    view[key] = b.dataset.v;
    if (after) after();
    render();
  });
}
segClick('leagueSeg', 'league');
segClick('marketSeg', 'market');
segClick('hitScope', 'hitScope');
segClick('hitMarket', 'hitMarket');
segClick('sportSeg', 'sport', () => {
  try { localStorage.setItem(SPORT_KEY, view.sport); } catch {}
  view.team = '';
  $('teamSearch').value = '';
  // The basketball tab always opens on today's games.
  if (view.sport === 'cbb') setTimeout(() => openDay(todayId(), { quiet: true }));
});
document.querySelector('.chips').addEventListener('click', e => {
  const b = e.target.closest('.chip');
  if (!b) return;
  view[b.dataset.filter] = !view[b.dataset.filter];
  render();
});
$('sortSel').onchange = e => { view.sort = e.target.value; render(); };
$('confSel').onchange = e => { view.conf = e.target.value; render(); };
$('teamSearch').addEventListener('input', e => { view.team = e.target.value; render(); });
function th() {
  return view.sport === 'cbb' ? store.cbb.th : store.th;
}
$('thSpread').onchange = e => { th().spread = +e.target.value; save(); render(); pushSettings(); };
$('thTotal').onchange = e => { th().total = +e.target.value; save(); render(); pushSettings(); };

// ---------- helpers ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function isFinal(g, live) {
  return !!(g.final || live?.completed);
}
const useSpread = () => view.market !== 'totals';
const useTotal = () => view.market !== 'spreads';

// Compare a game and fold in the market filter.
function evalGame(g, live) {
  const c = compare(g, live, th());
  const sF = useSpread() && c.spreadFlag;
  const tF = useTotal() && c.totalFlag;
  return {
    ...c,
    sF, tF,
    flagged: sF || tF,
    size: Math.max(useSpread() ? Math.abs(c.spreadGap || 0) : 0, useTotal() ? Math.abs(c.totalGap || 0) : 0),
  };
}

// Team search: matches any part of either team's name.
function teamMatch(g) {
  const q = normName(view.team);
  if (!q) return true;
  return g.teams.some(t => [t.name, ...(t.alt || [])].some(n => normName(n).includes(q)));
}

const SORTS = {
  time: (a, b) => new Date(a.g.kickoff) - new Date(b.g.kickoff),
  gap: (a, b) => b.c.size - a.c.size || SORTS.time(a, b),
  spreadGap: (a, b) => Math.abs(b.c.spreadGap || 0) - Math.abs(a.c.spreadGap || 0) || SORTS.time(a, b),
  totalGap: (a, b) => Math.abs(b.c.totalGap || 0) - Math.abs(a.c.totalGap || 0) || SORTS.time(a, b),
  flaggedFirst: (a, b) => (b.c.flagged - a.c.flagged) || SORTS.time(a, b),
};

// ---------- render ----------
function render() {
  document.body.dataset.sport = view.sport;
  for (const [segId, key] of [['sportSeg', 'sport'], ['leagueSeg', 'league'], ['marketSeg', 'market'], ['hitScope', 'hitScope'], ['hitMarket', 'hitMarket']]) {
    for (const b of $(segId).children) b.classList.toggle('on', b.dataset.v === view[key]);
  }
  for (const c of document.querySelectorAll('.chip')) c.classList.toggle('on', !!view[c.dataset.filter]);
  $('thSpread').value = String(th().spread);
  $('thTotal').value = String(th().total);
  if (view.sport === 'cbb') renderCbb();
  else renderFootball();
}

function renderList(rows, groupOf, cardOpts) {
  let shown = rows.filter(r => teamMatch(r.g) && (!view.flagged || r.c.flagged) && (!view.hideFinal || !isFinal(r.g, r.live)));
  shown = shown.slice().sort(SORTS[view.sort] || SORTS.time);

  $('empty').hidden = !!shown.length;
  if (!shown.length) {
    $('empty').textContent = view.team.trim()
      ? `No games match "${view.team.trim()}".`
      : view.flagged ? 'No discrepancies at these thresholds.' : 'No games match these filters.';
  }

  let html = '';
  if (view.sort === 'time') {
    const groups = new Map();
    for (const r of shown) {
      const k = groupOf(r);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    for (const [label, list] of groups) {
      const f = list.filter(r => r.c.flagged).length;
      html += `<h3 class="day">${esc(label)}<span>${list.length} game${list.length === 1 ? '' : 's'}${f ? ` &middot; <b>${f} flagged</b>` : ''}</span></h3><div class="grid">${list.map(r => card(r, cardOpts(r))).join('')}</div>`;
    }
  } else {
    html = `<div class="grid">${shown.map(r => card(r, cardOpts(r))).join('')}</div>`;
  }
  $('list').innerHTML = html;
}

function renderFootball() {
  const w = week();
  const ids = Object.keys(store.weeks).sort().reverse();
  $('weekSel').innerHTML = ids.map(id => {
    const x = store.weeks[id];
    return `<option value="${id}" ${id === store.current ? 'selected' : ''}>${esc(weekName(x))}${x.label ? `  ·  ${esc(x.label)}` : ''}</option>`;
  }).join('');
  $('weekSel').hidden = !ids.length;
  $('weekLabel').textContent = w ? (w.lockText ? `Splash locks ${w.lockText}` : '') : 'No lines loaded';
  $('syncStatus').textContent = w?.lastSync ? `Synced ${new Date(w.lastSync).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : '';
  $('deleteBtn').hidden = !w;

  // Open the paste box when there's nothing to show; close it again once a week arrives.
  if (w && $('pastePanel').dataset.auto) {
    $('pastePanel').hidden = true;
    delete $('pastePanel').dataset.auto;
  }
  if (!w) {
    if ($('pastePanel').hidden) $('pastePanel').dataset.auto = '1';
    $('pastePanel').hidden = false;
    $('summary').innerHTML = '';
    $('hitsWrap').hidden = true;
    $('controls').hidden = true;
    $('list').innerHTML = '';
    $('empty').hidden = true;
    return;
  }
  $('controls').hidden = false;
  $('hitsWrap').hidden = false;

  for (const b of $('leagueSeg').children) {
    const n = b.dataset.v === 'all' ? w.games.length : w.games.filter(g => g.league === b.dataset.v).length;
    b.innerHTML = `${{ all: 'All', nfl: 'NFL', cfb: 'College' }[b.dataset.v]} <span>${n}</span>`;
  }

  const inLeague = g => view.league === 'all' || g.league === view.league;
  const rows = w.games.filter(inLeague).map(g => ({ g, live: w.live[g.id], c: evalGame(g, w.live[g.id]) }));

  // Summary tiles
  const matched = rows.filter(r => r.live);
  const flagged = rows.filter(r => r.c.flagged).length;
  const missing = w.lastSync ? rows.filter(r => w.unmatched.includes(r.g.id)).length : 0;
  const parts = [useSpread() && `${rows.filter(r => r.c.sF).length} spreads`, useTotal() && `${rows.filter(r => r.c.tF).length} totals`].filter(Boolean).join(', ');
  $('summary').innerHTML = `
    <div class="tile"><span class="k">Games</span><span class="v">${rows.length}</span><span class="s">from Splash</span></div>
    <div class="tile"><span class="k">Matched on ESPN</span><span class="v">${w.lastSync ? matched.length : '--'}</span><span class="s">${w.lastSync ? (missing ? `<span class="warn">${missing} not found</span>` : 'all found') : 'press Sync ESPN'}</span></div>
    <div class="tile ${flagged ? 'hot' : ''}"><span class="k">Discrepancies</span><span class="v">${w.lastSync ? flagged : '--'}</span><span class="s">${w.lastSync ? parts : 'after sync'}</span></div>`;

  // Hit rate: graded legs from the chosen weeks.
  const legs = [];
  for (const wk of view.hitScope === 'all' ? Object.values(store.weeks) : [w]) for (const g of wk.games) {
    if (!inLeague(g)) continue;
    const live = wk.live[g.id];
    if (!live) continue;
    const r = grade(g, live, compare(g, live, store.th));
    if (r) legs.push({ s: r.spread ? [r.spread.gap, r.spread.hit] : null, t: r.total ? [r.total.gap, r.total.hit] : null });
  }
  const nWeeks = Object.keys(store.weeks).length;
  renderHits(legs, {
    claim: "How often the side favored by the gap covered Splash's number",
    scope: view.hitScope === 'all' ? (nWeeks === 1 ? 'your 1 saved week' : `all ${nWeeks} saved weeks`) : 'this week',
  });

  renderList(rows, r => r.g.dayLabel, r => ({
    colA: 'Splash', colB: 'ESPN', better: 'Better at Splash', moved: 'off',
    badge: `<span class="lg ${r.g.league}">${r.g.league === 'nfl' ? 'NFL' : 'CFB'}</span>`,
    unmatched: w.lastSync && w.unmatched?.includes(r.g.id),
  }));
}

function confLabel(g) {
  const cs = [...new Set(g.teams.map(t => t.conf).filter(Boolean))];
  return cs.join(' / ');
}

function renderCbb() {
  const id = view.day;
  const d = dayObj();
  $('dayPick').value = `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}`;
  $('dayToday').hidden = id === todayId();
  $('syncStatus').textContent = d?.lastSync ? `Synced ${new Date(d.lastSync).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : '';
  $('controls').hidden = false;
  $('hitsWrap').hidden = false;

  const all = Object.values(d?.games || {}).map(adapt);
  $('dayLabel').textContent = id === todayId() ? 'Today' : dayName(id, { weekday: 'long' });

  // Conference filter, with counts for this day. "Top 25" covers ranked teams.
  const counts = {};
  for (const { game } of all) for (const c of new Set(game.teams.map(t => t.conf).filter(Boolean))) counts[c] = (counts[c] || 0) + 1;
  const top = all.filter(({ game }) => game.teams.some(t => t.rank)).length;
  const confs = Object.keys(counts).sort((a, b) => a.localeCompare(b));
  if (view.conf !== 'all' && view.conf !== 'top25' && !counts[view.conf]) view.conf = 'all';
  $('confSel').innerHTML = [
    `<option value="all">All conferences (${all.length})</option>`,
    top ? `<option value="top25">Top 25 (${top})</option>` : '',
    ...confs.map(c => `<option value="${esc(c)}">${esc(c)} (${counts[c]})</option>`),
  ].join('');
  $('confSel').value = view.conf;

  const inConf = game => view.conf === 'all' || (view.conf === 'top25' ? game.teams.some(t => t.rank) : game.teams.some(t => t.conf === view.conf));
  const rows = all.filter(({ game }) => inConf(game)).map(({ game, live }) => ({ g: game, live, c: evalGame(game, live) }));

  if (!d) {
    $('summary').innerHTML = '';
    $('list').innerHTML = '';
    $('empty').hidden = false;
    $('empty').textContent = syncing ? 'Loading games from ESPN...' : 'No games saved for this date yet. Press Sync ESPN to load them.';
    renderCbbHits(inConf);
    return;
  }

  const withOpen = rows.filter(r => r.g.teams[0].line != null || r.g.total != null);
  const fromEspn = withOpen.filter(r => r.g.openSrc === 'espn').length;
  const flagged = rows.filter(r => r.c.flagged).length;
  const parts = [useSpread() && `${rows.filter(r => r.c.sF).length} spreads`, useTotal() && `${rows.filter(r => r.c.tF).length} totals`].filter(Boolean).join(', ');
  $('summary').innerHTML = `
    <div class="tile"><span class="k">Games</span><span class="v">${rows.length}</span><span class="s">${view.conf === 'all' ? 'Division I' : view.conf === 'top25' ? 'with a Top 25 team' : esc(view.conf)}</span></div>
    <div class="tile"><span class="k">Opening lines</span><span class="v">${withOpen.length}</span><span class="s">${fromEspn} from ESPN, ${withOpen.length - fromEspn} first seen*</span></div>
    <div class="tile ${flagged ? 'hot' : ''}"><span class="k">Line moves flagged</span><span class="v">${flagged}</span><span class="s">${parts}</span></div>`;

  renderCbbHits(inConf);

  const group = r => (r.live.completed ? 'Final' : r.live.state === 'in' ? 'Live now' : 'Upcoming');
  const order = { 'Live now': 0, Upcoming: 1, Final: 2 };
  // Live games first, then upcoming by tip time, then finals.
  const sortTime = SORTS.time;
  SORTS.time = (a, b) => order[group(a)] - order[group(b)] || sortTime(a, b);
  try {
    renderList(rows, group, r => ({
      colA: r.g.openSrc === 'first' ? 'Open*' : 'Open',
      colB: r.live.state === 'pre' ? 'Now' : 'Close',
      better: 'Better at open', moved: 'moved',
      badge: `<span class="lg cbb">${esc(confLabel(r.g) || 'NCAAB')}</span>`,
    }));
  } finally {
    SORTS.time = sortTime;
  }
  if (rows.length) $('list').insertAdjacentHTML('beforeend', '<p class="footnote">* Open is the first line this app saw, because ESPN did not list an opening line for that game. The daily sync captures these early each morning.</p>');
}

function renderCbbHits(inConfGame) {
  const ids = view.hitScope === 'all' ? Object.keys(store.cbb.graded) : [view.day];
  const legs = [];
  for (const id of ids) for (const row of store.cbb.graded[id] || []) {
    if (view.conf === 'top25' ? !row.k : view.conf !== 'all' && !row.c?.includes(view.conf)) continue;
    legs.push(row);
  }
  const n = Object.keys(store.cbb.graded).length;
  const where = view.conf === 'all' ? '' : view.conf === 'top25' ? ' in games with a Top 25 team' : ` in ${view.conf} games`;
  renderHits(legs, {
    claim: 'How often the side the line moved toward covered the opening number',
    scope: (view.hitScope === 'all' ? (n === 1 ? 'your 1 saved day' : `all ${n} saved days`) : 'this day') + where,
  });
}

// Hit rate by gap size. legs: [{ s: [gap, hit] | null, t: [gap, hit] | null }].
// Gaps are grouped by whole point (4 = 4 and 4.5).
function renderHits(legs, { claim, scope }) {
  const buckets = new Map();
  let pushes = 0;
  const add = leg => {
    if (!leg || !leg[0]) return;
    if (leg[1] === null) { pushes++; return; }
    const k = Math.floor(leg[0]);
    const b = buckets.get(k) || { hit: 0, n: 0 };
    b.n++;
    if (leg[1]) b.hit++;
    buckets.set(k, b);
  };
  for (const l of legs) {
    // The tile has its own Both / Spreads / Totals switch, separate from the game list.
    if (view.hitMarket !== 'totals') add(l.s);
    if (view.hitMarket !== 'spreads') add(l.t);
  }

  const keys = [...buckets.keys()].sort((a, b) => b - a);
  const what = { both: 'spreads and totals', spreads: 'spreads', totals: 'totals' }[view.hitMarket];
  let body;
  if (!keys.length) {
    body = '<p class="hits-empty">No finished games with a gap yet. Rows fill in as games go final and you sync.</p>';
  } else {
    // Each row is "this gap or bigger": the 3+ row counts every game whose gap was 3 or more.
    let cumHit = 0, cumN = 0;
    const rowsHtml = keys.map(k => {
      const b = buckets.get(k);
      cumHit += b.hit; cumN += b.n;
      const pct = Math.round((cumHit / cumN) * 100);
      const label = k === 0 ? 'Any gap' : `${k}+ pts`;
      const cls = pct >= 55 ? 'good' : pct < 45 ? 'bad' : '';
      return `<tr>
        <td class="hl">${label}</td>
        <td class="hb"><div class="bar"><span class="${cls}" style="width:${pct}%"></span><i style="left:50%"></i></div></td>
        <td class="hp ${cls}">${pct}%</td>
        <td class="hn">${cumHit} of ${cumN}</td>
      </tr>`;
    }).join('');
    body = `<table class="hits-table">
      <thead><tr><th>Gap</th><th></th><th>Hit</th><th></th></tr></thead>
      <tbody>${rowsHtml}</tbody></table>`;
  }

  $('hits').innerHTML = `
    <div class="hits-head">
      <div><h2>Discrepancy hit rate</h2>
      <p>${esc(claim)}, for ${what}, across ${esc(scope)}.</p></div>
    </div>
    ${body}
    <p class="hits-note">Each row counts every game with a gap of that size or bigger, so 3+ pts includes gaps of 3, 3.5, 4, and up. Pushes${pushes ? ` (${pushes})` : ''} are not counted.</p>`;
}

function statusText(g, live) {
  const scores = live?.completed && live.scores ? live.scores : g.final;
  if (isFinal(g, live) && scores) return `<span class="st final">Final ${scores[0]}-${scores[1]}</span>`;
  if (live?.state === 'in') return `<span class="st live"><span class="pulse"></span>${esc(live.detail || 'Live')}${live.scores ? ` &middot; ${live.scores[0]}-${live.scores[1]}` : ''}</span>`;
  return `<span class="st">${esc(g.timeLabel || '')}</span>`;
}

// Final score, or the in-progress score while a game is live.
function currentScores(g, live) {
  if (live?.completed && live.scores) return live.scores;
  if (g.final) return g.final;
  if (live?.state === 'in' && live.scores) return live.scores;
  return null;
}

function gapCell(gap, flagged) {
  if (gap == null) return '<td class="gp na">--</td>';
  if (!gap) return '<td class="gp zero">0</td>';
  return `<td class="gp ${flagged ? 'flag' : ''}">${fmtMove(gap)}</td>`;
}

// opts: { colA, colB, better, moved, badge, unmatched }
function card(r, opts) {
  const { g, live, c } = r;
  const t1 = g.teams[0];
  const sc = currentScores(g, live);
  const liveNow = live?.state === 'in' && !live?.completed;
  const scoreSpan = v => (sc ? `<span class="score ${liveNow ? 'is-live' : ''}">${v}</span>` : '');
  const neg = v => (v == null ? null : -v);

  const teamRow = (t, idx) => {
    const a = idx === 0 ? t1.line : neg(t1.line);
    const b = live?.line1 == null ? null : idx === 0 ? live.line1 : -live.line1;
    const gap = c.spreadGap == null ? null : idx === 0 ? c.spreadGap : -c.spreadGap;
    const better = c.sF && c.spreadSide === idx;
    return `<tr class="${better ? 'better' : ''}">
      <td class="team"><div class="tc">${t.rank ? `<span class="rank">${t.rank}</span>` : ''}<span class="nm">${esc(t.name)}</span><span class="rec">${esc(t.record || '')}</span>${better ? `<span class="tag"><span class="long">${opts.better}</span><span class="short">Value</span></span>` : ''}${sc ? scoreSpan(sc[idx]) : ''}</div></td>
      <td class="ln">${fmtLine(a)}</td>
      <td class="ln espn">${fmtLine(b)}</td>
      ${gapCell(gap, c.sF)}
    </tr>`;
  };

  const totalRow = `<tr class="tot ${c.tF ? 'better' : ''}">
      <td class="team"><div class="tc"><span class="tlabel">Total</span>${c.tF ? `<span class="tag">${c.totalSide === 'over' ? 'Over' : 'Under'}<span class="long"> ${opts.better.replace(/^Better/, 'better')}</span></span>` : ''}${sc ? scoreSpan(sc[0] + sc[1]) : ''}</div></td>
      <td class="ln">${g.total ?? '--'}</td>
      <td class="ln espn">${live?.total ?? '--'}</td>
      ${gapCell(c.totalGap, c.tF)}
    </tr>`;

  // Always show both lines. The market filter only decides what gets flagged,
  // sorted, and counted; the other market is dimmed.
  const dim = (html, on) => (on ? html : html.replace(/<tr class="/g, '<tr class="muted '));
  const body = dim(teamRow(g.teams[0], 0) + teamRow(g.teams[1], 1), useSpread()) + dim(totalRow, useTotal());

  const flags = [];
  if (c.sF) flags.push(`Spread ${opts.moved} ${Math.abs(c.spreadGap)}`);
  if (c.tF) flags.push(`Total ${opts.moved} ${Math.abs(c.totalGap)}`);

  return `<article class="card ${c.flagged ? 'flagged' : ''} ${isFinal(g, live) ? 'is-final' : ''}">
    <div class="card-top">
      ${opts.badge}
      ${statusText(g, live)}
      <span class="right">${opts.unmatched ? '<span class="nomatch">Not found on ESPN</span>' : flags.map(f => `<span class="flagb">${f}</span>`).join('')}</span>
    </div>
    <table>
      <thead><tr><th></th><th>${opts.colA}</th><th>${opts.colB}</th><th>Gap</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
  </article>`;
}

render();
renderRemote();
connect();
