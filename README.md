# Splash Line Tracker

Paste your Splash Sports pick'em page, then compare Splash's lines to ESPN's. Games where the two disagree by your threshold get flagged, and the hit rate tile tracks how often the side favored by the gap covers Splash's number.

## How it works
- **Paste**: select the whole Splash pick'em page, copy, paste into "Paste lines", save. Each paste is saved to its week (Tuesday through Monday night). Pasting a week you already saved replaces it.
- **Sync ESPN**: pulls current lines and scores from ESPN through `/api/lines`. Once a game kicks off, the last pre-game number is kept. Finished games get ESPN's closing line from the game summary.
- **Flags**: set the spread and total thresholds in the filter bar. Cards show which side is better at Splash.
- **Hit rate**: grouped by whole-point gap, with its own Both / Spreads / Totals and This week / All weeks switches.
- **Storage**: weeks and settings are saved to Upstash Redis on Vercel, so every device sees the same data. Each device asks for the passcode once.

## Files
- `index.html`, `styles.css`, `app.js`: the page
- `parser.js`: reads the Splash paste
- `logic.js`: ESPN matching, gaps, grading
- `api/lines.js`: Vercel function that calls ESPN
- `api/store.js`: Vercel function that saves weeks to Upstash Redis
- `dev/server.mjs`: local test server

## Run locally
```
npm run dev        # real ESPN data
npm run dev:mock   # fake ESPN data and an in-memory store (passcode 1234)
```
Mock mode reads a sample paste from `dev/sample-paste.txt`, which is not in the repo. Then open http://localhost:5173

## Deploy
Import the GitHub repo in Vercel (preset: Other, no build step). Then:
1. Storage tab: add Upstash for Redis (free) and connect it to the project.
2. Settings, Environment Variables: add `APP_PASSCODE`.
3. Redeploy so the new variables take effect.
