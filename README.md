# trading-analysis

A private, single-user MT5 trading journal. Export your MetaTrader 5 trade
history (`.xlsx`) and chart candles (`.csv`), upload them, and the app computes
performance + behavioural analytics and grades each trade against a rules-based
SMC/ICT strategy overlay — all client-side, nothing leaves the browser.

## Develop

```bash
npm install      # install dependencies
npm run dev      # start the Vite dev server
npm run build    # production build (output in dist/)
npm run preview  # serve the production build locally
npm test         # run the unit-test suite (Vitest)
npm run test:watch
```

## Tests

Unit tests live next to their modules as `*.test.js` and cover the pure logic —
the parsers (`src/lib/candleParser.js`, `parseWorkbookRows`), the analytics
engine (`computeAnalytics`: win rate, profit factor, R-multiples, expectancy,
streaks, monthly rollups), and the SMC engine (`src/lib/smc.js`: swings,
BOS/CHoCH, order blocks, FVGs, liquidity sweeps, confluence, the setup scan).
They run in Node (no DOM needed) and are the regression net for the numbers.

## Notes

- Persistence is browser `localStorage`; use **Settings → Export JSON** to back up.
- Deployed on Vercel; production is the `main` branch and auto-deploys on push.
