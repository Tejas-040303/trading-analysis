# Trading Journal

A private, single-user **MetaTrader 5 trading journal** that turns your raw trade
history into performance, behavioural, and strategy analytics — and grades every
trade against a rules-based SMC/ICT overlay. Everything runs **client-side**:
your files are parsed in the browser and never leave your machine.

Export your MT5 trade history (`.xlsx`) and, optionally, chart candles (`.csv`),
drop them in, and the dashboard does the rest.

> Origin spec: [TRADING_JOURNAL_DESIGN_SPEC.md](TRADING_JOURNAL_DESIGN_SPEC.md).

---

## What it does

**Performance** — net P/L, win rate, profit factor, expectancy, gross profit/loss,
largest win/loss, ROI, true current balance, and equity-curve max drawdown ($ and %).

**Behaviour (the point of the journal)** — it separates *discipline* from *impulse*:

- **Patience tax** — splits trades held 3 min+ vs under 3 min, and plots a
  counterfactual "if every sub-3-min trade were removed" equity line.
- **Tilt clusters** — runs of consecutive same-day losses (with lot-escalation flags).
- **Revenge re-entries** — quick same-symbol re-entries after a loss.
- **Streaks, overtrading flags, calendar heatmap, time-of-day × weekday heatmap,
  day-of-week and trading-session (Asian/London/NY) breakdowns.**
- **Beginner-era archive** — a "serious-start" date separates your early learning
  trades from the stats that count.
- **Notes + `#tags`** per trade, which become clickable filters.

**Strategy overlay (SMC/ICT)** — upload candle CSVs to grade each trade against six
strategies via a **causal forward pass** (bar *i* only sees bars ≤ *i* — no repainting):

| | Strategy | What it checks |
|---|---|---|
| **S1** | Market Structure | BOS / CHoCH bias alignment |
| **S2** | Order Blocks | entry inside an unmitigated opposing-candle zone |
| **S3** | Fair Value Gaps | entry inside a 3-candle imbalance |
| **S4** | Liquidity Sweeps | wick-through-swing stop-hunt before entry |
| **S5** | Volume Profile | POC / Value Area (fixed-range, tick-volume approx.) |
| **S6** | Session Context | Asian / London / New York (needs broker GMT offset) |

A **confluence score (0–5)** counts how many of S1–S5 fired supportively at entry
(S6 is context, not scored), and a **setup scan** walks every bar to compare the
setups you *took* vs *skipped* — a discipline mirror with hypothetical forward
reach (MFE/MAE in R), **not** a backtest of real exits.

---

## Get your MT5 data

**Trade history (`.xlsx`, required):**
MT5 → **Toolbox → History** tab → right-click → **Report → Open XML (.xlsx)**.
Drop one or many — overlapping trades dedupe by ticket, so daily exports merge cleanly.

**Candles (`.csv`, optional — enables the strategy overlay):**
Open a chart → right-click → **Save As… CSV**, or **View → Symbols → Bars**.
Tab-separated `DATE TIME OPEN HIGH LOW CLOSE TICKVOL …`. The filename convention
`SYMBOL__TIMEFRAME_START_END.csv` (e.g. `GOLD_i__M5_…csv`) is auto-detected; upload
one file per symbol/timeframe. Start with your primary symbol on M5.

---

## Develop

```bash
npm install      # install dependencies
npm run dev      # Vite dev server
npm run build    # production build -> dist/
npm run preview  # serve the production build locally
npm test         # run the Vitest suite
npm run test:watch
```

**Stack:** Vite + React 18 + Tailwind v4, [Recharts](https://recharts.org) for
charts, [SheetJS (`xlsx`)](https://sheetjs.com) for the MT5 report, and
`lucide-react` icons. Tests use Vitest.

---

## Project structure

```
src/
  main.jsx            app entry
  App.jsx             orchestrator — state, analytics memos, upload/settings handlers
  theme.js            shared palette + chart styling tokens
  index.css           Tailwind + global focus-ring / reduced-motion rules
  lib/                pure logic (unit-tested, no React)
    format.js         money/number/date formatters
    candleParser.js   MT5 candle CSV parser, merge, storage keys
    analytics.js      DEFAULT_SETTINGS, MT5 workbook parser, computeAnalytics, confluence, tags
    smc.js            SMC engine: swings, BOS/CHoCH, OBs, FVGs, sweeps, volume profile, setup scan
    storage.js        localStorage wrapper (quota-safe)
    useReducedMotion.js
    *.test.js         Vitest specs next to each module
  components/         presentational UI
    StatCard, BalanceTotal, ChartCard, CalendarHeatmap, TimeOfDayHeatmap,
    NoteInput, SettingsModal, DashboardTab, TradesTab, StrategyTab
```

The numeric core lives in `src/lib/` so it can be unit-tested in isolation (no
DOM). Those tests are the regression net for every number the UI shows.

---

## Privacy

100% client-side. MT5 files are parsed in the browser; data persists only to this
browser's `localStorage` (≈5 MB cap — candles are the big consumer). No backend,
no accounts, no telemetry. Use **Settings → Export JSON** to back up or move
between devices/browsers.

> Note: `xlsx`/SheetJS has known advisories with no upstream fix; risk here is low
> in practice since you only ever parse your own self-exported files locally.

---

## Caveats (honest analytics)

- **R-multiples** use a point value derived *empirically* per symbol (median of
  `profit / (signedMove × volume)`), so no hardcoded contract specs are needed —
  but it's an estimate. R is only computed for trades that carried a stop.
- **Volume profile (S5)** uses MT5 **tick** volume as a proxy, not real exchange volume.
- **Setup-scan reach** is a hypothetical max-favourable/adverse excursion vs a
  recent-swing stop — a "did I act on my own setups?" mirror, not a P/L claim.
- **Sessions (S6)** and GMT bucketing need the broker's GMT offset set in Settings
  (MT5 server time isn't GMT).
- **Drawdown** is a trades-only equity curve (deposits/withdrawals are flows, not P/L).

---

## Deployment

Deployed on **Vercel** (Vite is auto-detected). Production is the `main` branch and
**auto-deploys on every push**; feature branches get preview deployments.

---

*Personal project — no open-source license. All rights reserved.*
