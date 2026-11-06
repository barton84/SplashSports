// Saved weeks and settings, kept in Upstash Redis so every device sees the same data.
//   GET    /api/store                      -> { weeks: {id: week}, settings }
//   PUT    /api/store?week=YYYY-MM-DD      body: week     -> save one week
//   DELETE /api/store?week=YYYY-MM-DD                     -> delete one week
//   PUT    /api/store?settings=1           body: settings -> save settings
//   GET    /api/store?day=YYYYMMDD                        -> one basketball day
//   PUT    /api/store?day=YYYYMMDD         body: day      -> save one basketball day
// The plain GET also returns cbbIndex (saved days and when each changed) and
// cbbGraded (compact finished-game results per day, for the hit rate tile).
// Every request needs the header  x-passcode: <APP_PASSCODE>.
import { gradedRows } from '../cbb.js';

const WEEKS = 'lt:weeks';
const SETTINGS = 'lt:settings';
const CBB_DAYS = 'lt:cbb';
const CBB_GRADED = 'lt:cbbg';
const CBB_INDEX = 'lt:cbbi';

function hashToObject(flat, parse = JSON.parse) {
  const out = {};
  for (let i = 0; i < (flat || []).length; i += 2) out[flat[i]] = parse(flat[i + 1]);
  return out;
}

// Save a basketball day along with its graded summary and index entry.
export async function saveDay(day) {
  const at = day.updatedAt || new Date().toISOString();
  await redis(['HSET', CBB_DAYS, day.id, JSON.stringify(day)]);
  await redis(['HSET', CBB_GRADED, day.id, JSON.stringify(gradedRows(day))]);
  await redis(['HSET', CBB_INDEX, day.id, JSON.stringify({ at, n: Object.keys(day.games || {}).length })]);
}

export async function loadDay(id) {
  const raw = await redis(['HGET', CBB_DAYS, id]);
  return raw ? JSON.parse(raw) : null;
}

export async function loadWeeks() {
  return hashToObject(await redis(['HGETALL', WEEKS]));
}

export async function saveWeek(w) {
  await redis(['HSET', WEEKS, w.id, JSON.stringify(w)]);
}

// Vercel's Upstash integration names these <PREFIX>_REST_API_URL / _TOKEN, where the
// prefix is whatever was typed when connecting (KV by default). Find any matching pair.
export function redisConfig() {
  const env = process.env;
  const pairs = [['KV_REST_API_URL', 'KV_REST_API_TOKEN'], ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']];
  for (const k of Object.keys(env)) {
    const m = k.match(/^(.*)_REST_API_URL$/);
    if (m) pairs.push([k, `${m[1]}_REST_API_TOKEN`]);
  }
  for (const [u, t] of pairs) if (env[u] && env[t]) return { url: env[u], token: env[t] };
  return null;
}

export async function redis(cmd) {
  const cfg = redisConfig();
  const r = await fetch(cfg.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || `Redis ${r.status}`);
  return j.result;
}

function same(a, b) {
  // Constant-time compare so the passcode can't be guessed by timing.
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!redisConfig() || !process.env.APP_PASSCODE) {
    return res.status(503).json({ error: 'Storage is not set up yet', missing: !redisConfig() ? 'database' : 'APP_PASSCODE' });
  }
  if (!same(req.headers['x-passcode'] || '', process.env.APP_PASSCODE)) {
    return res.status(401).json({ error: 'Wrong passcode' });
  }

  const { week, settings, day } = req.query || {};
  try {
    if (day && !/^\d{8}$/.test(day)) return res.status(400).json({ error: 'Bad day id' });
    if (req.method === 'GET' && day) {
      return res.status(200).json({ day: await loadDay(day) });
    }
    if (req.method === 'PUT' && day) {
      const body = await readBody(req);
      if (!body || body.id !== day || typeof body.games !== 'object') return res.status(400).json({ error: 'Bad day data' });
      await saveDay(body);
      return res.status(200).json({ ok: true });
    }
    if (req.method === 'GET') {
      const [weeks, s, cbbIndex, cbbGraded] = await Promise.all([
        loadWeeks(),
        redis(['GET', SETTINGS]),
        redis(['HGETALL', CBB_INDEX]).then(f => hashToObject(f)),
        redis(['HGETALL', CBB_GRADED]).then(f => hashToObject(f)),
      ]);
      return res.status(200).json({ weeks, settings: s ? JSON.parse(s) : null, cbbIndex, cbbGraded });
    }

    if (week && !/^\d{4}-\d{2}-\d{2}$/.test(week)) return res.status(400).json({ error: 'Bad week id' });

    if (req.method === 'PUT' && week) {
      const body = await readBody(req);
      if (!body || body.id !== week || !Array.isArray(body.games)) return res.status(400).json({ error: 'Bad week data' });
      await redis(['HSET', WEEKS, week, JSON.stringify(body)]);
      return res.status(200).json({ ok: true });
    }
    if (req.method === 'DELETE' && week) {
      await redis(['HDEL', WEEKS, week]);
      return res.status(200).json({ ok: true });
    }
    if (req.method === 'PUT' && settings) {
      const body = await readBody(req);
      await redis(['SET', SETTINGS, JSON.stringify(body || {})]);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'Not allowed' });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
