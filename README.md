# Splash Line Tracker

Paste your Splash Sports pick'em page, lock those spreads and totals, then compare them to ESPN's current lines. After games finish it grades your picks at the locked number and calls out any result the line move flipped.

## How it works
- **Paste**: select the whole Splash pick'em page, copy, paste into "Locked lines", save. Saving again replaces the slate (picks carry over for games still listed).
- **Picks**: click a team or Over/Under to mark your pick.
- **Sync ESPN**: pulls current lines and scores from ESPN's public scoreboard through `/api/lines`. Once a game kicks off, the last pre-game number is kept as the closing line.
- Weeks and settings are saved to Upstash Redis on Vercel, so every device sees the same data. Each device asks for the passcode once.
- Finished games: ESPN drops odds from the scoreboard after a game ends, so the app pulls the closing line from ESPN's game summary instead.

## Files
- `index.html`, `styles.css`, `app.js`: the page
- `parser.js`: reads the Splash paste
- `logic.js`: ESPN matching, line movement, grading
- `api/lines.js`: Vercel function that calls ESPN
- `api/store.js`: Vercel function that saves weeks to Upstash Redis
- `dev/`: local test server and a sample paste

## Run locally
```
npm run dev        # real ESPN data
npm run dev:mock   # fake line movement from dev/sample-paste.txt
```
Then open http://localhost:5173

## Deploy
Import the GitHub repo in Vercel (preset: Other, no build step). Then:
1. Storage tab: add Upstash for Redis (free) and connect it to the project.
2. Settings, Environment Variables: add `APP_PASSCODE`.
3. Redeploy so the new variables take effect.

Local mock mode uses an in-memory store with passcode `1234`.
