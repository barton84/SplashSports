// Daily scheduled sync, run by Vercel (see vercel.json). Without anyone opening the app it:
//   - loads today's college basketball slate, capturing openers before games tip
//   - refreshes yesterday's slate so finished games get final scores and closing lines
//   - syncs the current football week so ESPN's pre-game lines get saved
// Vercel sends  Authorization: Bearer <CRON_SECRET>  when the CRON_SECRET variable is set.
import { scoreboard, closingLines } from './lines.js';
import { redisConfig, loadDay, saveDay, loadWeeks, saveWeek } from './store.js';
import { syncDay, syncWeek, ymdIn } from '../sync.js';

// The local test server swaps in fake ESPN data here; on Vercel this is always the real ESPN.
const realEspn = { scoreboard, closing: closingLines };

function dash(id) {
  return `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: secret ? 'Not allowed' : 'Add a CRON_SECRET environment variable first' });
  }
  if (!redisConfig()) return res.status(503).json({ error: 'Storage is not set up yet' });
  const espn = globalThis.__lineTrackerEspn || realEspn;

  const report = {};
  const today = ymdIn(Date.now());
  const yesterday = ymdIn(Date.now() - 864e5);

  for (const id of [yesterday, today]) {
    try {
      const day = (await loadDay(id)) || { id, games: {} };
      const r = await syncDay(day, espn);
      await saveDay(day);
      report[`cbb ${id}`] = `${r.games} games`;
    } catch (e) {
      report[`cbb ${id}`] = `failed: ${e.message || e}`;
    }
  }

  // The football week whose Tuesday-to-Monday range includes today.
  try {
    const weeks = await loadWeeks();
    const t = dash(today);
    const w = Object.values(weeks).find(x => {
      const end = ymdIn(Date.parse(`${x.id}T12:00:00Z`) + 6 * 864e5);
      return x.id <= t && t <= dash(end);
    });
    if (w) {
      const r = await syncWeek(w, espn);
      await saveWeek(w);
      report.football = `${w.id}: ${w.games.length - r.unmatched.length} matched`;
    } else {
      report.football = 'no saved week covers today';
    }
  } catch (e) {
    report.football = `failed: ${e.message || e}`;
  }

  return res.status(200).json({ ok: true, ranAt: new Date().toISOString(), report });
}
