# MT5 Trading Journal — Design & Technical Specification

**Owner:** Tejas Pawar (TJ)
**Purpose of this document:** a complete, implementation-ready spec for building a standalone, hosted version of the MT5 trading journal dashboard. Written to be handed to Claude Code, which should use it to scaffold a real repo, implement the features in phases, and prepare it for static hosting.

**Companion file:** `trading_journal.jsx` — a working single-file React prototype, already built and validated against TJ's real MT5 account export (183 trades, Jan–Jun 2026). Its parsing logic (`parseWorkbookRows`, `computeAnalytics`) and visual design tokens are the **source of truth** — port and refactor this logic into the new project structure rather than re-deriving it from scratch. It currently runs inside a Claude.ai artifact using `window.storage`; the main structural change for standalone hosting is swapping that for `localStorage` (see §9).

---

## 0. Quick start for Claude Code

1. Scaffold a Vite + React project per the structure in §2.
2. Port the parsing/analytics logic from `trading_journal.jsx` into `src/lib/mt5Parser.js` and `src/lib/analytics.js`, unchanged in behavior — **except** for the deliberate fixes called out in the Phase 1 "Porting cleanups" list (§7): the date-bucketing fix (§6) and the drawdown relabel (§6).
3. Replace all `window.storage.get/set/delete` calls with the `localStorage` wrapper in `src/lib/storage.js` (§9).
4. Verify against the test fixture in §10 before moving to Phase 2 features.
5. Build Phase 1 fully, commit, push to GitHub, deploy (§11) — get a working live URL before starting Phase 2.
6. Phase 2 and Phase 3 features (§7) are additive; implement and deploy incrementally, one feature per branch/PR if possible.

---

## 1. Project overview

**What it is:** A private, single-user trading journal for TJ's XM MT5 account. He exports his MT5 trade history as `.xlsx`/`.csv` and uploads it; the app parses it client-side, computes performance and behavioral analytics, and (in later phases) cross-references trades against price action to judge whether entries matched an SMC/ICT setup.

**Primary instruments:** XAUUSD ("GOLD.i#") and BTCUSD, occasionally others. Timeframes traded: M1, M5, M15.

**Core problem this solves:** TJ's own data showed his profitable trades and his self-destructive trades were nearly invisible to each other inside one P&L number — the clean, reproducible **duration split** (everything held 3+ minutes vs. everything under 3 minutes) was **+$375.31 vs. −$253.26**, netting to the $122.05 he actually kept. The journal's job is to keep that split visible every day, not just in a one-off analysis. (These are the canonical figures — see the §10 fixture.)

> **Do not conflate this with the behavioral split.** An earlier mid-analysis cut framed "disciplined vs. impulsive" trading as **+$478.79 / −$356.74**. That is a *behavioral* bucket — it folds same-day tilt-cluster losses into the "impulsive" side (the union of two behaviors, de-duplicated; the ~$103.48 gap on each side is exactly that tilt-cluster overlap). It is **not** reproducible from a single rule, which is why §10 uses the duration split as the canonical fixture. The behavioral pair must **not** be presented as, or alongside, the duration split. If surfaced in the UI at all, label it explicitly as a separate "disciplined vs. impulsive (behavioral)" metric.

**Non-goals for this build:**
- No live broker connection (deferred — see §7 Phase 4 / future).
- No multi-user accounts, auth, or backend. Single user, single browser, fully static site.
- No real money movement or trade execution. Read-only analytics tool.

---

## 2. Tech stack & repo structure

- **Build tool:** Vite
- **Framework:** React 18 (function components, hooks only)
- **Styling:** Tailwind CSS (full JIT config — standalone hosting removes the "core utilities only" constraint that applied inside the Claude artifact sandbox)
- **Charts:** `recharts`
- **Icons:** `lucide-react`
- **Parsing:** `xlsx` (SheetJS) for `.xlsx`, native string parsing for tab-separated MT5 CSV candle exports
- **Persistence:** browser `localStorage`, JSON-serialized (see §9)
- **No backend, no database, no API keys, no env vars.** Fully static.
- **Hosting:** static site on Vercel, Netlify, or Cloudflare Pages (§11)

```
mt5-trading-journal/
├── package.json
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
├── index.html
├── README.md
├── public/
│   └── favicon.svg
└── src/
    ├── main.jsx
    ├── App.jsx
    ├── styles/
    │   └── index.css            # Tailwind directives + font-face imports
    ├── lib/
    │   ├── mt5Parser.js          # Positions/Deals xlsx parsing (port from trading_journal.jsx)
    │   ├── candleParser.js       # Phase 3: MT5 CSV candle parsing
    │   ├── analytics.js          # all stats computations (port from trading_journal.jsx)
    │   ├── smc.js                # Phase 3: SMC/ICT detection engine
    │   ├── rmultiple.js          # Phase 2: R-multiple calculations
    │   └── storage.js            # localStorage wrapper (replaces window.storage)
    └── components/
        ├── Header.jsx
        ├── Dropzone.jsx
        ├── StatCard.jsx
        ├── ChartCard.jsx
        ├── DailyPnlChart.jsx
        ├── DurationBucketChart.jsx
        ├── DowChart.jsx
        ├── SessionChart.jsx       # Phase 2
        ├── CalendarHeatmap.jsx    # Phase 2
        ├── TiltClusterList.jsx
        ├── SymbolTable.jsx
        ├── DailyTable.jsx
        ├── SettingsPanel.jsx      # Phase 2
        ├── TradeNoteEditor.jsx    # Phase 2
        └── StrategyOverlayPanel.jsx # Phase 3
```

---

## 3. Data model

```ts
type Position = {
  ticket: string;          // unique MT5 position ID — primary dedup key
  openTime: string;        // ISO 8601
  closeTime: string;       // ISO 8601
  symbol: string;          // cleaned, e.g. "GOLD", "BTCUSD"
  type: "buy" | "sell";
  volume: number;          // lots
  openPrice: number;
  sl: number | null;
  tp: number | null;
  closePrice: number;
  commission: number;
  swap: number;
  profit: number;          // net $ for this position
  note?: string;           // Phase 2: free-text journal entry
};

type BalanceOp = {
  dealId: string;          // unique MT5 deal ID — primary dedup key
  time: string;            // ISO 8601
  profit: number;          // positive = credit, negative = debit
  balance: number;         // running account balance after this op
  comment: string;         // raw MT5 comment, used to classify the op
};

type Candle = {             // Phase 3
  time: string;            // ISO 8601
  open: number; high: number; low: number; close: number;
  tickVolume: number;
};

type Settings = {           // Phase 2, user-editable, persisted
  overtradeThreshold: number;   // default 15 (trades/day)
  tiltStreakMin: number;        // default 3 (consecutive losses)
  revengeWindowMin: number;     // default 3 (minutes)
  brokerGmtOffsetHours: number; // default null — drives the shared tradeDate() helper for all date/day/session bucketing (§6)
};

type AccountMeta = {
  account: string;
  name: string;
  company: string;
};
```

**LocalStorage keys** (all JSON strings):

| Key | Contents |
|---|---|
| `tj_positions` | `Position[]` |
| `tj_balance_ops` | `BalanceOp[]` |
| `tj_account_meta` | `AccountMeta` |
| `tj_last_updated` | ISO timestamp string |
| `tj_settings` | `Settings` |
| `tj_candles_{SYMBOL}_{TIMEFRAME}` | `Candle[]` (Phase 3, one key per symbol+timeframe) |

---

## 4. MT5 trade report parsing (`.xlsx`)

The "Trade History Report" exported from MT5 (Toolbox → History → right-click → Report → Open XML) is a single-sheet workbook with three labeled sections in column A: `Positions`, `Orders`, `Deals`, each preceded by a header row.

**Section detection:** scan column A for the literal strings `"Positions"`, `"Orders"`, `"Deals"`. Header row is one row below the label; data starts two rows below the label and runs until the next section label (or, for Deals, until a row where column A equals `"Balance:"`).

**Positions row schema** (0-indexed columns):

| idx | field | notes |
|---|---|---|
| 0 | OpenTime | `YYYY.MM.DD HH:MM:SS` string |
| 1 | Ticket | unique position ID |
| 2 | Symbol | e.g. `"GOLD.i#"` — strip `#` and `.i` for display |
| 3 | Type | `"buy"` / `"sell"` |
| 4 | Volume | lots |
| 5 | OpenPrice | |
| 6 | SL | nullable |
| 7 | TP | nullable |
| 8 | CloseTime | same format as col 0 |
| 9 | ClosePrice | |
| 10 | Commission | |
| 11 | Swap | |
| 12 | Profit | net $ |

A row is valid data only if column 1 (ticket) is non-null.

**Deals row schema** (0-indexed columns):

| idx | field | notes |
|---|---|---|
| 0 | Time | |
| 1 | Deal ID | unique |
| 2 | Symbol | empty for balance ops |
| 3 | Type | `"balance"` for deposits/withdrawals/transfers; trade fills have other values — **only rows with Type === "balance" are balance ops** |
| 4 | Direction | |
| 5 | Volume | |
| 6 | Price | |
| 7 | Order | |
| 8 | Commission | |
| 9 | Fee | |
| 10 | Swap | |
| 11 | Profit | the $ amount of this balance event |
| 12 | Balance | running account balance after this event |
| 13 | Comment | classify by substring (see below) |

**Balance op classification** (case-insensitive substring match on Comment):
- contains `"transfer to"` → money sent **out** to another account (TJ's profit-skim habit)
- contains `"transfer from"` → money brought **back in** from another account
- anything else (e.g. `"CD-EC-UPI"`, `"EXP05-..."`) → external deposit/bonus credit
- `depositsTotal` for ROI purposes = sum of profit for all ops that are **not** transfers (transfers are balance-neutral across TJ's two accounts, not new capital)

**Date parsing:** strings matching `^(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2}):(\d{2})` parse directly into `y, mo, d, h, mi, s`. If a cell comes through as a number instead (Excel serial date), convert via `new Date(Math.round((value - 25569) * 86400 * 1000))`.

**Merge/dedup rule:** every new upload's positions and balance ops are upserted into existing stored arrays keyed by `ticket` / `dealId`. Never wipe on upload — only an explicit "Reset" clears storage. This makes it safe to re-upload the full account history every time, or just a recent slice — duplicates always resolve to the same record.

---

## 5. Candle data parsing (Phase 3, `.csv`)

MT5 chart data export format (tab-separated, header row included):

```
<DATE>	<TIME>	<OPEN>	<HIGH>	<LOW>	<CLOSE>	<TICKVOL>	<VOL>	<SPREAD>
2026.05.01	01:00:00	4625.63	4636.17	4625.50	4628.66	757	0	24
```

- Split on tab, skip header row (starts with `<DATE>`).
- Datetime = same `YYYY.MM.DD` + `HH:MM:SS` parse as above.
- Symbol and timeframe aren't in the file content — infer from filename (MT5's default export naming is `SYMBOL__TIMEFRAME_STARTDATE_ENDDATE.csv`, e.g. `GOLD_i__M5_202605010100_202606191950.csv`) or prompt the user to confirm/tag on upload if filename parsing fails.
- Store under `tj_candles_{SYMBOL}_{TIMEFRAME}`, merged/deduped by candle timestamp (later upload wins on overlap, since re-exports of the same range should be identical anyway).

---

## 6. Analytics engine — formulas & algorithms

All of the below operate on the merged, sorted `Position[]` (sorted by `openTime`) and `BalanceOp[]` (sorted by `time`).

**Headline stats**
- `winRate` = wins / total × 100
- `grossProfit` / `grossLoss` = sum of profit where profit > 0 / < 0
- `netProfit` = grossProfit + grossLoss
- `profitFactor` = |grossProfit / grossLoss|
- `currentBalance` = `balance` field of the chronologically last `BalanceOp`
- **Balance drawdown (approximate)** — Phase 1; the prototype's `maxDrawdownPct` — = max over time of `(runningPeakBalance − balance) / runningPeakBalance × 100`, walking `BalanceOp.balance` in time order. This walks **only** `balance`-type deal rows (deposits/withdrawals/transfers), so it measures drawdown at those balance events, **not** intra-trade equity dips — it is balance-curve drawdown, not equity drawdown, and can miss a deeper dip that occurred between two balance events. Surface it in the UI labeled "Balance drawdown," not "Max drawdown." A true equity-curve drawdown is a Phase 2 refinement (see §7).
- `roiPct` = `netProfit / depositsTotal × 100`

**Daily aggregation:** group positions by the trade's date as returned by the shared `tradeDate(position, offset)` helper (`YYYY-MM-DD`; see *Date bucketing* below). Per day: trade count, sum of profit, win rate. `overtrading` flag = trade count ≥ `settings.overtradeThreshold`.

**Date bucketing — one shared helper (required).** All date/day/session bucketing MUST go through a single helper, `tradeDate(position, offset)`, driven by `settings.brokerGmtOffsetHours`. Daily grouping, the day-of-week chart, and the Phase 2 session view must all call this same helper with the same offset, so a trade can never fall on two different days across views. The helper MUST derive the bucket from the trade's MT5 server-time wall-clock plus the offset; it MUST NOT use `Date.prototype.toISOString()` or `.getDay()` on a browser-zoned `Date` — both silently inject the *viewer's* timezone. (That is the exact bug in the prototype: daily grouping uses `toISOString().slice(0,10)` (UTC) while the day-of-week chart uses `.getDay()` (browser-local), so the same trade can land on two different days in two views.) Note that "local date" is itself ambiguous on a static site — it resolves to whatever zone the viewer's browser is in (UTC+5:30 for TJ, while the data is in MT5 server time); pick **one** explicit zone and apply it everywhere through this helper. When `brokerGmtOffsetHours` is `null`, the helper falls back to the raw MT5 server wall-clock (the face-value timestamp), which keeps daily and day-of-week views working and mutually consistent before the offset is set; the offset is strictly required only to map times onto named GMT sessions (Asian/London/NY).

**Duration buckets:** `<1m`, `1-3m`, `3-10m`, `10-30m`, `>30m` by `(closeTime − openTime)` in minutes. Net P/L and win rate per bucket. This is the single most important chart in the app — it's what exposed the **$253 "impulsive tax"** (the −$253.26 net on sub-3-minute trades; this is the duration-only figure, not the −$356.74 behavioral figure — see §1) in TJ's real data, and should always be visible above the fold.

**Tilt cluster detection:** within each calendar day, walk positions in time order; accumulate a streak of consecutive losing trades; whenever the streak breaks (a win occurs, or day ends) with length ≥ `settings.tiltStreakMin`, emit a cluster `{date, start, end, count, pl, symbols, lotEscalation}`. `lotEscalation` = true if any trade in the streak has `volume` greater than the immediately preceding trade's `volume`.

**Revenge re-entry detection:** for each position with a previous position on record, if previous trade's profit < 0, gap between previous close and this open ≤ `settings.revengeWindowMin` minutes, and same symbol → flag as a revenge re-entry. Track count and net P/L of all flagged trades.

**Day-of-week / session stats:** group by weekday or by hour-bucketed trading session, both derived from the same `tradeDate(position, offset)` helper as daily aggregation (never `.getDay()` on a browser-zoned `Date`). **Session bucketing requires `settings.brokerGmtOffsetHours`** — MT5 server time is not UTC and not TJ's local time; without this offset, session labels (Asian/London/NY) will be wrong. Surface this as a required setup step the first time a user opens the Settings panel, defaulting to `null` (no session view shown until set — daily and day-of-week views still work via the helper's null-offset fallback).

**Symbol stats:** group by symbol; trade count, win rate, net P/L.

---

## 7. Feature roadmap

### Phase 1 — MVP (port existing artifact, get it deployed)
Everything already built and validated in `trading_journal.jsx`:
- Upload (multi-file, drag-and-drop), merge/dedup logic
- Header stat cards: net P/L, win rate, profit factor, current balance, ROI, balance drawdown (approximate — see §6), gross profit/loss, largest win/loss
- "Patience pays" two-card comparison (<3min vs 3min+ net P/L)
- Daily P/L bar chart + cumulative trading P/L line (dual axis), tilt-cluster days outlined in amber
- Duration bucket chart
- Day-of-week chart
- Tilt cluster alert cards
- Symbol table
- Scrollable daily breakdown table with Calm/Busy/Tilt status chips
- Reset/clear-data flow with inline confirm

**Porting cleanups (carry into the refactor — these deviate from a verbatim port):**
- **Drop the duplicate file input.** The prototype renders `<input ref={fileInputRef}>` twice — once in the header (the live one) and once as a trailing element at the very bottom of the component (dead leftover from artifact iteration). Keep the header one; delete the trailing one. No behavior change.
- **Fix the date-bucketing bug.** Route daily grouping and the day-of-week chart through the single `tradeDate()` helper (§6); do not carry over the prototype's `toISOString().slice(0,10)` / `.getDay()` mismatch.
- **Relabel drawdown.** Surface the Phase 1 metric as "Balance drawdown," not "Max drawdown" (§6).

**Goal: deploy this phase live before adding anything else.**

### Phase 2 — Quick-win improvements
- **R-multiples** (`src/lib/rmultiple.js`): for trades with a non-null SL, risk = `|openPrice − sl| × volume × pointValue`. Point value per symbol isn't reliably known up front — derive it empirically per symbol by reverse-solving from existing closed trades (`pointValue ≈ profit / (volume × |closePrice − openPrice|)` averaged across many trades on that symbol) rather than hardcoding contract specs, since this avoids needing TJ to look up exact XM contract sizes. Show R-multiple alongside $ profit everywhere it's meaningful; this is what makes performance comparable across the 0.01–0.10 lot range TJ actually traded.
- **Per-trade notes**: a free-text field stored as `Position.note`, editable inline or via a small modal from the daily table. Persisted with the position record.
- **Settings panel**: editable `overtradeThreshold`, `tiltStreakMin`, `revengeWindowMin`, `brokerGmtOffsetHours`, persisted to `tj_settings`.
- **Session view**: Asian (00:00–08:00 GMT) / London (08:00–16:00 GMT) / New York (13:00–21:00 GMT, overlapping London) bucketing, using `brokerGmtOffsetHours` to convert. Bar chart, same visual language as day-of-week chart.
- **Counterfactual equity curve**: a second line on the daily P/L chart showing cumulative P/L if all trades under 3 minutes were excluded — lets the "what if I'd just been patient" gap be seen growing in real time, not just stated as a stat.
- **True equity-curve drawdown**: replace the Phase 1 balance-drawdown approximation (§6) with real equity drawdown — reconstruct a per-trade equity curve by replaying `Position.profit` in **close-time** order against the starting balance, then take the max peak-to-trough drop on that curve. The per-trade data is already present, so this upgrades the approximation to a true figure and catches dips that occur between balance events.
- **Calendar heatmap**: month-grid view, each day cell shaded by net P/L sign/magnitude, for fast multi-month scanning once history grows.

### Phase 3 — Strategy / entry-validation overlay
Requires candle data uploaded per §5. Implemented in `src/lib/smc.js`, ported conceptually from TJ's own existing SMC/ICT Pine Script v6 indicator and MIDAS bot strategy logic (Order Block + liquidity sweep, FVG rebalancing) — simplified into a rules-based, non-discretionary approximation:

1. **Swing detection**: fractal pivots, default lookback 5 candles each side (configurable).
2. **Structure/bias**: sequence of confirmed swing breaks → current BOS/CHoCH direction.
3. **Order blocks**: last opposing-color candle immediately before an impulsive move that produces a BOS.
4. **Fair Value Gaps**: 3-candle imbalance (gap between candle 1's wick and candle 3's wick); size relative to local ATR classifies Strong / Regular / Weak.
5. **Liquidity sweeps**: a wick that pierces a prior swing point and closes back inside it.

For every trade, look at the candle series in the relevant symbol/timeframe at `openTime`:
- Check whether an OB or FVG in the trade's direction was active at entry.
- Check whether the trade direction matches the prevailing BOS bias.
- Check for a liquidity sweep in the few candles immediately before entry.
- Compose a verdict string, e.g. *"Setup confirmed: entered at a bearish OB with FVG confluence, aligned with active bearish BOS, preceded by a liquidity sweep of the prior session low."* or *"No structure support: entered against the active bullish BOS with no OB/FVG confluence nearby."*

Display: an expandable row per trade in the daily table (or a "Trade detail" panel), surfaced via `StrategyOverlayPanel.jsx`. Make all five thresholds above configurable in Settings, since SMC/ICT judgment calls vary and TJ may want to tune them against his own chart reading over time.

**Honesty note to preserve in any UI copy:** this is a consistent rules-based approximation, not full discretionary chart-reading judgment — phrase verdicts as "structure-based read" rather than a definitive grade.

### Phase 4 — Future (explicitly deferred, not in this build)
Live MT5 connection: a local Python script (using the `MetaTrader5` package, attaching to TJ's already-logged-in terminal — no credentials stored) that periodically exports the same data this app already knows how to parse, removing the manual upload step. Out of scope until Phases 1–3 are live and stable.

---

## 8. Visual design system

Dark "trading terminal" aesthetic, deliberately not a generic SaaS look — grounded in the fact that the primary instrument is literally gold.

**Color tokens:**

| Token | Hex | Use |
|---|---|---|
| `bg` | `#04070D` | page background |
| `panel` | `#0B121C` | card surfaces |
| `panelAlt` | `#101A28` | nested surfaces, tooltips |
| `border` | `#1C2A3A` | card borders |
| `borderSoft` | `#152233` | chart gridlines |
| `text` | `#E6EDF5` | primary text |
| `textMuted` | `#8B9AAE` | secondary text |
| `textFaint` | `#5B6B80` | captions, axis labels |
| `amber` | `#FBB94B` | brand accent — gold theme, cumulative-line, tilt-day outline |
| `emerald` | `#39C29A` | profit, positive states |
| `rose` | `#E5697A` | loss, negative states, danger |

**Typography:**
- Display/headers: `Space Grotesk` (500/600 weight)
- Numeric data (all $ figures, percentages, stat card values): `JetBrains Mono` — reinforces the "terminal" identity and makes numbers easy to scan/compare
- Body/labels: system sans-serif stack

**Signature element:** a colored left-border "discipline stripe" on every daily-table row (emerald = calm day, amber = busy/overtrading day, rose = a tilt cluster occurred) — the visual language of the whole app is literally the same discipline-vs-impulse distinction the data analysis surfaced, repeated consistently everywhere a day or trade is shown.

**Quality floor:** responsive down to mobile width, visible keyboard focus states, respect `prefers-reduced-motion`, no animation beyond simple chart-load transitions.

---

## 9. Persistence (standalone hosting change)

The Claude-artifact prototype uses `window.storage.get/set/delete(key, shared)`, which does not exist outside Claude.ai. Replace with a thin wrapper:

```js
// src/lib/storage.js
export const storage = {
  get(key) {
    const raw = localStorage.getItem(key);
    return raw == null ? null : JSON.parse(raw);
  },
  set(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  },
  remove(key) {
    localStorage.removeItem(key);
  },
};
```

Call sites in the ported components change from `await window.storage.get(k, false)` → `storage.get(k)` (synchronous, no try/catch needed beyond a guard for `JSON.parse` failure).

**Recommended addition not in the original prototype:** an Export/Import JSON button (Settings panel) that dumps all `tj_*` localStorage keys to a downloadable `.json` file and can re-import it. `localStorage` is cleared by browser cache-clears, private browsing, or switching devices — a backup/restore path protects against losing months of journal history. This should be built in Phase 2 alongside the Settings panel.

**Privacy note for README:** no data ever leaves the browser. Parsing, storage, and all analytics are 100% client-side; there is no backend to send data to.

---

## 10. Test fixture — validate the port against known-correct output

Before considering Phase 1 done, parse TJ's original export and confirm these exact figures (computed and verified earlier in this project):

- Total closed positions: **183**
- Win rate: **51.9%**
- Net profit: **$122.05**
- Gross profit: **$1,064.18** / Gross loss: **−$942.13**
- Profit factor: **1.13**
- Largest win: **$118.20** / Largest loss: **−$41.50**
- Final account balance: **$74.88**
- Trades held under 3 minutes: **98 trades, net −$253.26**
- Trades held 3+ minutes: **85 trades, net +$375.31**
- Tilt clusters (3+ same-day consecutive losses): **8 clusters**, biggest being June 17, 21:08–21:32, 4 losses, −$111.68

If the ported parser/analytics produce different numbers on this same file, there's a bug in the port — debug against §4 and §6 before proceeding.

**On the date-bucketing fix (§6):** the duration split (98 / −$253.26 and 85 / +$375.31) is **date-invariant** — it depends only on `closeTime − openTime`, not on calendar day — so along with totals, win rate, net/gross/PF, largest win/loss, and final balance it stays an **exact hard gate**. The **date-sensitive** fixtures — the daily breakdown, the day-of-week chart, and the **tilt-cluster count/dates** (tilt detection runs within a calendar day) — depend on the zone the shared `tradeDate()` helper uses. The "8 clusters / June 17 21:08–21:32" figures were derived under the prototype's old UTC bucketing; the evening cluster is far from any midnight boundary and should survive, but trades near midnight can shift days. Once the helper is set to the canonical zone (recommended: **MT5 server wall-clock**), re-derive these under that zone and update this fixture. A shift in the date-sensitive figures is the bucketing fix working as intended, **not** a port bug.

---

## 11. Deployment

1. `npm create vite@latest mt5-trading-journal -- --template react`
2. Add dependencies: `npm i recharts lucide-react xlsx` and dev dependency `tailwindcss postcss autoprefixer`, run `npx tailwindcss init -p`.
3. Build out `src/` per §2.
4. `git init`, commit, push to a new GitHub repo (TJ already has GitHub connectivity set up — Claude Code should create the repo and push directly).
5. **Hosting — pick one:**
   - **Vercel**: import the GitHub repo at vercel.com, auto-detects Vite, zero config needed, auto-deploys on every push to `main`.
   - **Netlify**: same flow, `npm run build` / publish directory `dist`.
   - **Cloudflare Pages**: same flow, generous free tier, fast global CDN.
   - All three are free for this use case (fully static, no backend, low traffic, single user) and support custom domains if TJ wants one later.
6. No environment variables or secrets needed anywhere in this build.

---

## 12. Open items TJ should resolve (not blockers for Phase 1)

- **Broker GMT offset**: needed before the Phase 2 session view is meaningful. Check XM MT5 terminal's server time vs. GMT (visible in MT5 under the Market Watch clock or broker info) and enter it in Settings once built.
- **SMC parameter preferences** (Phase 3): default swing lookback, minimum FVG size threshold, etc. — can launch with sensible defaults and tune later once TJ can compare verdicts against his own chart reading.
- **Custom domain** (optional): decide later if/when wanted.
