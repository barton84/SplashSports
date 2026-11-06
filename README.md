# Splash Line Tracker

Two tabs:
- **Football**: paste your Splash Sports pick'em page, then compare Splash's lines to ESPN's.
- **College Basketball** (men's, all Division I): compare ESPN's opening line to ESPN's current or closing line.

Games where the two numbers differ by your threshold get flagged, and the hit rate tile tracks how often the side favored by the gap covers the first number (Splash's line for football, the opener for basketball).

## How it works
- **Paste**: select the whole Splash pick'em page, copy, paste into "Paste lines", save. Each paste is saved to its week (Tuesday through Monday night). Pasting a week you already saved replaces it.
- **Sync ESPN**: pulls current lines and scores from ESPN through `/api/lines`. Once a game kicks off, the last pre-game number is kept. Finished games get ESPN's closing line from the game summary.
- **Flags**: set the spread and total thresholds in the filter bar. Cards show which side is better at Splash.
- **Hit rate**: grouped by whole-point gap, with its own Both / Spreads / Totals and This week / All weeks switches.
- **Basketball**: opens on today's games. Use the arrows or date picker for other days. Filter by conference or Top 25. "Open" is ESPN's listed opener when ESPN provides one; otherwise it's the first line the app saw (marked Open*).
- **Team search**: type any part of a team name on either tab.
- **Daily sync**: Vercel runs `/api/cron` once a day (11:00 UTC, about 5am Central). It loads today's basketball slate, finishes yesterday's, and syncs the current football week. Needs a `CRON_SECRET` environment variable.
- **Storage**: weeks, basketball days, and settings are saved to Upstash Redis on Vercel, so every device sees the same data. Each device asks for the passcode once.

## Files
- `index.html`, `styles.css`, `app.js`: the page
- `parser.js`: reads the Splash paste
- `logic.js`: ESPN matching, gaps, grading
- `cbb.js`: basketball openers and current lines, graded results
- `sync.js`: ESPN sync shared by the page and the daily job
- `api/lines.js`: Vercel function that calls ESPN
- `api/store.js`: Vercel function that saves weeks and basketball days to Upstash Redis
- `api/cron.js`: the daily scheduled sync
- `vercel.json`: the daily schedule
- `dev/server.mjs`: local test server

## Run locally
```
npm run dev        # real ESPN data
npm run dev:mock   # fake ESPN data and an in-memory store (passcode 1234, cron secret devsecret)
```
Mock mode reads a sample paste from `dev/sample-paste.txt`, which is not in the repo. Then open http://localhost:5173

## Deploy
Import the GitHub repo in Vercel (preset: Other, no build step). Then:
1. Storage tab: add Upstash for Redis (free) and connect it to the project.
2. Settings, Environment Variables: add `APP_PASSCODE`, and `CRON_SECRET` (any long random string) for the daily sync.
3. Redeploy so the new variables take effect.
