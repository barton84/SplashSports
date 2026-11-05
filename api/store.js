// Saved weeks and settings, kept in Upstash Redis so every device sees the same data.
//   GET    /api/store                      -> { weeks: {id: week}, settings }
//   PUT    /api/store?week=YYYY-MM-DD      body: week     -> save one week
//   DELETE /api/store?week=YYYY-MM-DD                     -> delete one week
//   PUT    /api/store?settings=1           body: settings -> save settings
// Every request needs the header  x-passcode: <APP_PASSCODE>.

const WEEKS = 'lt:weeks';
const SETTINGS = 'lt:settings';

// Vercel's Upstash integration names these <PREFIX>_REST_API_URL / _TOKEN, where the
// prefix is whatever was typed when connecting (KV by default). Find any matching pair.
function redisConfig() {
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

  const { week, settings } = req.query || {};
  try {
    if (req.method === 'GET') {
      const flat = (await redis(['HGETALL', WEEKS])) || [];
      const weeks = {};
      for (let i = 0; i < flat.length; i += 2) weeks[flat[i]] = JSON.parse(flat[i + 1]);
      const s = await redis(['GET', SETTINGS]);
      return res.status(200).json({ weeks, settings: s ? JSON.parse(s) : null });
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
