# Splash Line Tracker

Paste your Splash Sports pick'em page, lock those spreads and totals, then compare them to ESPN's current lines. After games finish it grades your picks at the locked number and calls out any result the line move flipped.

## How it works
- **Paste**: select the whole Splash pick'em page, copy, paste into "Locked lines", save. Saving again replaces the slate (picks carry over for games still listed).
- **Picks**: click a team or Over/Under to mark your pick.
- **Sync ESPN**: pulls current lines and scores from ESPN's public scoreboard through `/api/lines`. Once a game kicks off, the last pre-game number is kept as the closing line.
- Data lives in your browser (localStorage), so it's per device.

## Files
- `index.html`, `styles.css`, `app.js`: the page
- `parser.js`: reads the Splash paste
- `logic.js`: ESPN matching, line movement, grading
- `api/lines.js`: Vercel function that calls ESPN
- `dev/`: local test server and a sample paste

## Run locally
```
npm run dev        # real ESPN data
npm run dev:mock   # fake line movement from dev/sample-paste.txt
```
Then open http://localhost:5173

## Deploy
Import the GitHub repo in Vercel. No build step or environment variables needed.
