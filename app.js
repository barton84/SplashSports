import { parseSplash } from './parser.js';
import { findEvent, liveFromEvent, mergeLive, compare, grade, weekStart, fmtLine, fmtMove } from './logic.js';

const KEY = 'lineTracker.v2';
const OLD_KEY = 'lineTracker.v1';
const $ = id => document.getElementById(id);

const view = { league: 'all', market: 'both', flagged: false, hideFinal: false, sort: 'time', hitScope: 'all', hitMarket: 'both' };
let store = load();
let pending = null;

// ---------- storage ----------
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
  if (!s.current || !s.weeks[s.current]) s.current = pickDefaultWeek(s.weeks);
  return s;
}
function save() {
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
  return Date.parse(w.updatedAt || w.lastSync || w.savedAt || 0) || 0;
}

async function connect() {
  let res;
  try { res = await api('GET'); } catch { remote.state = 'error'; return renderRemote(); }
  if (res.status === 503) { remote.state = 'off'; return renderRemote(); }
  if (res.status === 401) { remote.state = 'locked'; return renderRemote(); }
  if (res.status !== 200) { remote.state = 'error'; return renderRemote(); }
  remote.state = 'on';
  renderRemote();

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
  if (!store.weeks[store.current]) store.current = pickDefaultWeek(store.weeks);
  save();
  render();
  for (const w of uploads) await pushWeek(w);
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

async function pushSettings() {
  if (remote.state === 'on') await api('PUT', '?settings=1', { th: store.th }).catch(() => null);
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

// Pick up changes made on another device when you come back to the tab.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && remote.state === 'on') connect();
});

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

// ---------- paste ----------
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

// ---------- sync ----------
function ymd(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

$('syncBtn').onclick = sync;

async function sync() {
  const w = week();
  if (!w) return toast('Paste your Splash lines first');
  const btn = $('syncBtn');
  btn.disabled = true;
  btn.textContent = 'Syncing...';
  try {
    const leagues = [...new Set(w.games.map(g => g.league))];
    const results = await Promise.all(leagues.map(async lg => {
      const dates = w.games.filter(g => g.league === lg).map(g => new Date(g.kickoff));
      const from = new Date(Math.min(...dates));
      const to = new Date(Math.max(...dates));
      to.setDate(to.getDate() + 1);
      const r = await fetch(`/api/lines?league=${lg}&from=${ymd(from)}&to=${ymd(to)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      return [lg, j.events];
    }));
    const byLeague = Object.fromEntries(results);
    const now = new Date().toISOString();
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
      const ids = list.map(x => x.m.event.id).join(',');
      const r = await fetch(`/api/lines?league=${lg}&close=${ids}`).catch(() => null);
      if (!r || !r.ok) return;
      const { odds } = await r.json();
      for (const { g, m } of list) {
        if (!odds[m.event.id]) continue;
        w.live[g.id] = mergeLive(w.live[g.id], liveFromEvent(g, { event: { ...m.event, odds: odds[m.event.id] }, order: m.order }), now);
      }
    }));

    w.unmatched = unmatched;
    w.lastSync = now;
    touch(w);
    save();
    pushWeek(w);
    toast(unmatched.length ? `Synced. ${unmatched.length} games not found on ESPN` : 'Synced with ESPN');
    render();
  } catch (e) {
    toast(`Sync failed: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync ESPN';
  }
}

// ---------- controls ----------
function segClick(id, key) {
  $(id).addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    view[key] = b.dataset.v;
    render();
  });
}
segClick('leagueSeg', 'league');
segClick('marketSeg', 'market');
segClick('hitScope', 'hitScope');
segClick('hitMarket', 'hitMarket');
document.querySelector('.chips').addEventListener('click', e => {
  const b = e.target.closest('.chip');
  if (!b) return;
  view[b.dataset.filter] = !view[b.dataset.filter];
  render();
});
$('sortSel').onchange = e => { view.sort = e.target.value; render(); };
$('thSpread').onchange = e => { store.th.spread = +e.target.value; save(); render(); pushSettings(); };
$('thTotal').onchange = e => { store.th.total = +e.target.value; save(); render(); pushSettings(); };

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
  const c = compare(g, live, store.th);
  const sF = useSpread() && c.spreadFlag;
  const tF = useTotal() && c.totalFlag;
  return {
    ...c,
    sF, tF,
    flagged: sF || tF,
    size: Math.max(useSpread() ? Math.abs(c.spreadGap || 0) : 0, useTotal() ? Math.abs(c.totalGap || 0) : 0),
  };
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
  const w = week();
  const ids = Object.keys(store.weeks).sort().reverse();
  $('weekSel').innerHTML = ids.map(id => {
    const x = store.weeks[id];
    return `<option value="${id}" ${id === store.current ? 'selected' : ''}>${esc(weekName(x))}${x.label ? `  ·  ${esc(x.label)}` : ''}</option>`;
  }).join('');
  $('weekSel').hidden = !ids.length;
  $('weekLabel').textContent = w ? (w.lockText ? `Splash locks ${w.lockText}` : '') : 'No lines loaded';
  $('syncStatus').textContent = w?.lastSync ? `Synced ${new Date(w.lastSync).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : '';
  $('thSpread').value = String(store.th.spread);
  $('thTotal').value = String(store.th.total);
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
    $('hits').innerHTML = '';
    $('controls').hidden = true;
    $('list').innerHTML = '';
    $('empty').hidden = true;
    return;
  }
  $('controls').hidden = false;

  for (const [segId, key] of [['leagueSeg', 'league'], ['marketSeg', 'market'], ['hitScope', 'hitScope'], ['hitMarket', 'hitMarket']]) {
    for (const b of $(segId).children) b.classList.toggle('on', b.dataset.v === view[key]);
  }
  for (const b of $('leagueSeg').children) {
    const n = b.dataset.v === 'all' ? w.games.length : w.games.filter(g => g.league === b.dataset.v).length;
    b.innerHTML = `${{ all: 'All', nfl: 'NFL', cfb: 'College' }[b.dataset.v]} <span>${n}</span>`;
  }
  for (const c of document.querySelectorAll('.chip')) c.classList.toggle('on', !!view[c.dataset.filter]);

  const inLeague = g => view.league === 'all' || g.league === view.league;
  const rows = w.games.filter(inLeague).map(g => ({ g, live: w.live[g.id], c: evalGame(g, w.live[g.id]) }));
  renderSummary(w, rows);
  renderHits();

  let shown = rows.filter(r => (!view.flagged || r.c.flagged) && (!view.hideFinal || !isFinal(r.g, r.live)));
  shown = shown.slice().sort(SORTS[view.sort] || SORTS.time);

  $('empty').hidden = !!shown.length;
  $('empty').textContent = view.flagged && w.lastSync ? 'No discrepancies at these thresholds.' : 'No games match these filters.';

  let html = '';
  if (view.sort === 'time') {
    const days = new Map();
    for (const r of shown) {
      if (!days.has(r.g.dayLabel)) days.set(r.g.dayLabel, []);
      days.get(r.g.dayLabel).push(r);
    }
    for (const [day, list] of days) {
      const f = list.filter(r => r.c.flagged).length;
      html += `<h3 class="day">${esc(day)}<span>${list.length} games${f ? ` &middot; <b>${f} flagged</b>` : ''}</span></h3><div class="grid">${list.map(r => card(w, r)).join('')}</div>`;
    }
  } else {
    html = `<div class="grid">${shown.map(r => card(w, r)).join('')}</div>`;
  }
  $('list').innerHTML = html;
}

function renderSummary(w, rows) {
  const matched = rows.filter(r => r.live);
  const spreadF = rows.filter(r => r.c.sF).length;
  const totalF = rows.filter(r => r.c.tF).length;
  const flagged = rows.filter(r => r.c.flagged).length;
  const missing = w.lastSync ? rows.filter(r => w.unmatched.includes(r.g.id)).length : 0;
  const parts = [useSpread() && `${spreadF} spreads`, useTotal() && `${totalF} totals`].filter(Boolean).join(', ');
  $('summary').innerHTML = `
    <div class="tile"><span class="k">Games</span><span class="v">${rows.length}</span><span class="s">from Splash</span></div>
    <div class="tile"><span class="k">Matched on ESPN</span><span class="v">${w.lastSync ? matched.length : '--'}</span><span class="s">${w.lastSync ? (missing ? `<span class="warn">${missing} not found</span>` : 'all found') : 'press Sync ESPN'}</span></div>
    <div class="tile ${flagged ? 'hot' : ''}"><span class="k">Discrepancies</span><span class="v">${w.lastSync ? flagged : '--'}</span><span class="s">${w.lastSync ? parts : 'after sync'}</span></div>`;
}

// Hit rate by gap size: of the finished games with a gap, how often did the side the
// gap favored cover at Splash's number. Gaps are grouped by whole point (4 = 4 and 4.5).
function renderHits() {
  const weeks = view.hitScope === 'all' ? Object.values(store.weeks) : [week()];
  const buckets = new Map();
  let pushes = 0;
  const add = leg => {
    if (!leg || !leg.gap) return;
    if (leg.hit === null) { pushes++; return; }
    const k = Math.floor(leg.gap);
    const b = buckets.get(k) || { hit: 0, n: 0 };
    b.n++;
    if (leg.hit) b.hit++;
    buckets.set(k, b);
  };
  for (const w of weeks) for (const g of w.games) {
    if (view.league !== 'all' && g.league !== view.league) continue;
    const live = w.live[g.id];
    if (!live) continue;
    const r = grade(g, live, compare(g, live, store.th));
    if (!r) continue;
    // The tile has its own Both / Spreads / Totals switch, separate from the game list.
    if (view.hitMarket !== 'totals') add(r.spread);
    if (view.hitMarket !== 'spreads') add(r.total);
  }

  const keys = [...buckets.keys()].sort((a, b) => b - a);
  const what = { both: 'spreads and totals', spreads: 'spreads', totals: 'totals' }[view.hitMarket];
  const nWeeks = Object.keys(store.weeks).length;
  const scope = view.hitScope === 'all' ? (nWeeks === 1 ? 'your 1 saved week' : `all ${nWeeks} saved weeks`) : 'this week';
  let body;
  if (!keys.length) {
    body = '<p class="hits-empty">No finished games with a gap yet. Rows fill in as games go final and you sync.</p>';
  } else {
    // Running total for "this gap or bigger"
    let cumHit = 0, cumN = 0;
    const rowsHtml = keys.map(k => {
      const b = buckets.get(k);
      cumHit += b.hit; cumN += b.n;
      const pct = Math.round((b.hit / b.n) * 100);
      const cumPct = Math.round((cumHit / cumN) * 100);
      const label = k === 0 ? 'Under 1 pt' : `${k} pt${k === 1 ? '' : 's'}`;
      const cls = pct >= 55 ? 'good' : pct < 45 ? 'bad' : '';
      return `<tr>
        <td class="hl">${label}</td>
        <td class="hb"><div class="bar"><span class="${cls}" style="width:${pct}%"></span><i style="left:50%"></i></div></td>
        <td class="hp ${cls}">${pct}%</td>
        <td class="hn">${b.hit} of ${b.n}</td>
        <td class="hc">${k ? `${cumPct}% <span>(${cumHit} of ${cumN})</span>` : ''}</td>
      </tr>`;
    }).join('');
    body = `<table class="hits-table">
      <thead><tr><th>Gap</th><th></th><th>Hit</th><th></th><th>This gap or bigger</th></tr></thead>
      <tbody>${rowsHtml}</tbody></table>`;
  }

  $('hits').innerHTML = `
    <div class="hits-head">
      <div><h2>Discrepancy hit rate</h2>
      <p>How often the side favored by the gap covered Splash's number, for ${what}, across ${scope}.</p></div>
    </div>
    ${body}
    <p class="hits-note">Gaps are grouped by whole point, so 4 pts includes 4 and 4.5. Pushes${pushes ? ` (${pushes})` : ''} are not counted.</p>`;
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

function card(w, r) {
  const { g, live, c } = r;
  const unmatched = w.lastSync && w.unmatched?.includes(g.id);
  const t1 = g.teams[0];
  const sc = currentScores(g, live);
  const liveNow = live?.state === 'in' && !live?.completed;
  const scoreSpan = v => (sc ? `<span class="score ${liveNow ? 'is-live' : ''}">${v}</span>` : '');

  const teamRow = (t, idx) => {
    const splash = idx === 0 ? t1.line : -t1.line;
    const espn = live?.line1 == null ? null : idx === 0 ? live.line1 : -live.line1;
    const gap = c.spreadGap == null ? null : idx === 0 ? c.spreadGap : -c.spreadGap;
    const better = c.sF && c.spreadSide === idx;
    return `<tr class="${better ? 'better' : ''}">
      <td class="team"><div class="tc">${t.rank ? `<span class="rank">${t.rank}</span>` : ''}<span class="nm">${esc(t.name)}</span><span class="rec">${esc(t.record)}</span>${better ? '<span class="tag"><span class="long">Better at Splash</span><span class="short">Value</span></span>' : ''}${sc ? scoreSpan(sc[idx]) : ''}</div></td>
      <td class="ln">${fmtLine(splash)}</td>
      <td class="ln espn">${fmtLine(espn)}</td>
      ${gapCell(gap, c.sF)}
    </tr>`;
  };

  const totalRow = `<tr class="tot ${c.tF ? 'better' : ''}">
      <td class="team"><div class="tc"><span class="tlabel">Total</span>${c.tF ? `<span class="tag">${c.totalSide === 'over' ? 'Over' : 'Under'}<span class="long"> better at Splash</span></span>` : ''}${sc ? scoreSpan(sc[0] + sc[1]) : ''}</div></td>
      <td class="ln">${g.total ?? '--'}</td>
      <td class="ln espn">${live?.total ?? '--'}</td>
      ${gapCell(c.totalGap, c.tF)}
    </tr>`;

  // Always show both lines. The market filter only decides what gets flagged,
  // sorted, and counted; the other market is dimmed.
  const dim = (html, on) => (on ? html : html.replace(/<tr class="/g, '<tr class="muted '));
  const body = dim(teamRow(g.teams[0], 0) + teamRow(g.teams[1], 1), useSpread()) + dim(totalRow, useTotal());

  const flags = [];
  if (c.sF) flags.push(`Spread off ${Math.abs(c.spreadGap)}`);
  if (c.tF) flags.push(`Total off ${Math.abs(c.totalGap)}`);

  return `<article class="card ${c.flagged ? 'flagged' : ''} ${isFinal(g, live) ? 'is-final' : ''}">
    <div class="card-top">
      <span class="lg ${g.league}">${g.league === 'nfl' ? 'NFL' : 'CFB'}</span>
      ${statusText(g, live)}
      <span class="right">${unmatched ? '<span class="nomatch">Not found on ESPN</span>' : flags.map(f => `<span class="flagb">${f}</span>`).join('')}</span>
    </div>
    <table>
      <thead><tr><th></th><th>Splash</th><th>ESPN</th><th>Gap</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
  </article>`;
}

render();
renderRemote();
connect();
