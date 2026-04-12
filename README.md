# GCORES Auto Like

Automate likes on the GCORES feeds page with Playwright.

This repository currently includes:

- `scripts/gcores-playwright.js`
  Main automation entry for unattended runs.
- `gcores-playwright.config.json`
  Runtime configuration.
- `gcores-feeds-auto-like.user.js`
  Legacy Tampermonkey script kept for reference.

## Features

- Persistent login via Playwright browser profile
- Current-page-only processing
- Filterable allow/deny rules
- Unlimited mode for age and like caps
- Local run state and cooldown tracking
- Suitable for scheduled Windows execution

## Quick Start

```powershell
npm install
npx playwright install chromium
npm run gcores:login
npm run gcores:run
```

`gcores:login` opens a browser for manual login and saves the session locally.  
`gcores:run` opens `https://www.gcores.com/feeds`, scans visible feed items, likes matched content, writes state, and exits.

## Configuration

Edit `gcores-playwright.config.json` to adjust:

- delays and timeouts
- per-run / per-day limits
- allow / deny filters
- storage paths
- headless mode

Default behavior is intentionally open:

- `maxLikesPerRun = 0`
- `maxLikesPerDay = 0`
- `maxAgeHours = 0`
- `allowEntryTypes = []`
- `onlyUnliked = true`

## Data Files

Generated local files are stored under `.gcores-playwright/` and are ignored by Git.

Typical files:

- browser profile
- run state
- last error screenshot

## Notes

- The Playwright workflow is the recommended path for unattended execution.
- The Tampermonkey userscript is retained as a legacy alternative for foreground browser use.
