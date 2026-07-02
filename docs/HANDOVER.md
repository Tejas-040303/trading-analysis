# Project handover — as of Phase 7 complete (2026-07-02)

Single entry point for picking up work in a fresh session, especially the
**P8–P11 backend epic**. Read this first, then the code. (The Claude memory also
auto-loads a condensed version of this each session.)

---

## 1. What this is

A **private, single-user MetaTrader 5 trading journal**. You upload/sync your MT5
history + candles; it computes performance, behavioural, and SMC/ICT strategy
analytics. See [README.md](../README.md) for the user-facing overview and
[TRADING_JOURNAL_DESIGN_SPEC.md](../TRADING_JOURNAL_DESIGN_SPEC.md) for the origin spec.

- **Repo:** https://github.com/Tejas-040303/trading-analysis
- **Live:** https://trading-analysis-navy.vercel.app/ (Vercel; **`main` auto-deploys on push**)
- **Owner:** Tejas Pawar (TJ). Windows 11, Chrome/Edge.

## 2. Current state (Phases 1–7 DONE & merged)

`main` builds clean, **91 Vitest tests green**. Everything is **100% client-side**:
React SPA, data in `localStorage`, no backend, no accounts, no telemetry.

- **P1–P4** — journal core: MT5 `.xlsx` parse, balance ledger, serious-start filter,
  analytics (win rate, PF, expectancy, R-multiples, streaks, drawdown, monthly,
  calendar/time-of-day heatmaps, sessions), behavioural flags (patience tax, tilt
  clusters, revenge), and the full **SMC/ICT overlay** (S1–S6 + confluence + setup scan).
- **P5** — split the monolith into `src/lib` (pure logic) + `src/components`;
  accessibility + mobile. (App.jsx 2493 → ~886 lines.)
- **P6** — Vitest suite, perf hotspots (`findBarAtTime` binary search; sweep detection
  de-O(n²)'d), real README.
- **P7** — **local MT5 sync** (see §5).

## 3. Tech stack & layout

Vite 8 · React 18 · Tailwind v4 · Recharts · `xlsx` (SheetJS) · lucide-react · Vitest.
Python helper: `MetaTrader5`.

```
src/
  App.jsx              orchestrator: state, analytics memos, upload/sync/settings handlers
  theme.js             palette + chart tokens
  lib/                 PURE logic, unit-tested (no React/DOM)
    format.js          money/number/date formatters
    candleParser.js    MT5 candle CSV parse, mergeCandles, candleStorageKey
    analytics.js       DEFAULT_SETTINGS, parseWorkbookRows, computeAnalytics,
                       summarizePrior, parseMT5DateTime, confluence, tags
    smc.js             SMC engine: swings, BOS/CHoCH, OBs, FVGs, sweeps, volume
                       profile, scanSetups, computeTradeVerdicts, findBarAtTime
    storage.js         localStorage wrapper (quota-safe) + estimateUsageBytes
    mt5Sync.js         P7: parseSyncPayload + mergeSync (ingest latest.json)
    fsSync.js          P7: File System Access folder pick + IndexedDB handle
    useReducedMotion.js
    *.test.js          specs next to each module
  components/          presentational: StatCard, BalanceTotal, ChartCard,
                       CalendarHeatmap, TimeOfDayHeatmap, NoteInput, SettingsModal,
                       DashboardTab, TradesTab, StrategyTab
tools/mt5-sync/        P7 Python helper (NOT in the npm build): sync.py,
                       mt5_aggregate.py, test_aggregate.py, requirements.txt,
                       config.example.json, README.md
```

## 4. Data model & storage keys

`localStorage` (~5 MB cap; candles dominate — the app warns in Settings):

| key | shape |
|---|---|
| `tj_positions` | `[{ ticket, openTime(ISO), closeTime, symbol, type, volume, openPrice, sl, tp, closePrice, commission, swap, profit, note? }]` |
| `tj_balance_ops` | `[{ dealId, time(ISO), profit, balance, comment }]` |
| `tj_account_meta` | `{ name, account, company }` |
| `tj_candle_index` | `{ "SYMBOL_TF": { symbol, timeframe, count } }` |
| `tj_candles_<SYMBOL>_<TF>` | `[{ time(ISO), open, high, low, close, tickVolume }]` |
| `tj_settings`, `tj_last_updated` | settings object / ISO string |

Ingress paths: `.xlsx` upload (`parseWorkbookRows`), candle `.csv` upload
(`parseCandleCSV`), JSON backup import, and P7 MT5 sync (`mergeSync`). All merge by
id (`ticket`/`dealId`) and by candle time.

## 5. Phase 7 = the MT5 "sync" (interim, no backend)

**What it is:** `tools/mt5-sync/sync.py` attaches to a **running, logged-in** MT5
terminal (read-only, **no credentials**), aggregates deals → round-trip positions +
balance ops (+ candles), and writes `latest.json`. The app reads it via
**Settings → Sync from MT5** (File System Access folder pick, Chrome/Edge) or
**Import JSON** (any browser). Validated end-to-end on TJ's real account.

**Why it's file-based, not "live":** a hosted **HTTPS** page cannot talk directly to
the local machine (mixed-content), and the app has no backend. So "MT5 connected
live to the webpage" is **impossible on the Vercel URL without a backend**. This is
the key architectural fact that motivates P10/P11. Two parity properties keep sync
and manual uploads consistent: MT5 `position_id` → `ticket`; MT5 wall-clock strings
parsed by the shared `parseMT5DateTime`.

## 6. Dev workflow (IMPORTANT — TJ's rules)

- **Never push to `main`.** Branch `claude/<phase>-<slug>` off latest `main`,
  push, open a PR; **TJ reviews & merges himself** (he catches real bugs this way),
  Vercel auto-deploys on merge.
- Reviewable **sub-PRs** per phase; stack only when files would conflict.
- `npm run build` + `npm test` before pushing. UI-only changes aren't test-guarded —
  say so and lean on the Vercel preview.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## 7. Roadmap ahead — P8–P12 (the big, backend-heavy stretch)

> **Critical:** P8–P11 **reverse the original spec's non-goals** (no backend, no
> auth, no multi-user; fully static + localStorage). They are a **re-platform**
> (backend + DB + auth + tenancy), not incremental. P5/P6 were the de-risking work
> that intentionally landed first.

- **P8 = the bot epic** *(next; TJ will spec in detail)* — bot creation / upload / run.
  Almost certainly needs the backend. **Unspecified so far:** what the bot does
  (execution vs signals vs automation), inputs/outputs, where it runs, safety/limits.
  **Plan it the P7 way:** explore → AskUserQuestion on the forks → write a plan file
  → ExitPlanMode → reviewable sub-PRs.
- **P9** = dedicated testing phase.
- **P10** = security + AAA (authn/authz/access). Also **fix the known `xlsx`/SheetJS
  vuln** here (proto-pollution + ReDoS, no upstream fix; low practical risk today
  since files are self-uploaded client-side).
- **P11** = multi-tenant scale (~10k concurrent users, per-user isolated data).
- **P12** = split trading journal vs investment journal (product discussion first).

**Live automation lives in P10/P11** (TJ, 2026-07-02): real-time **market data
streamed to the webpage** and **active/open (live) trades** — none achievable on the
static client-side app. P7's folder-sync is the manual bridge until then.

### Backend epic — decisions to make when P8 starts
- **Keep the static app + add an API/DB alongside, or rebuild?** (Recommend: keep the
  React front-end, introduce a backend it talks to; migrate `localStorage` → DB.)
- **Stack/DB/auth/hosting.** Note: **Supabase MCP tools were available** in this
  workspace (Postgres + auth + edge functions) — a natural fit; confirm with TJ.
- **Data migration** from `localStorage` (`tj_*` keys) to per-user rows.
- **Where the bot runs** (server worker? user's machine? broker API?) and **credential
  handling** (P7 deliberately stored none — the backend changes that; treat as security-critical).

## 8. Constraints & lessons carried forward
- **Privacy** was the founding promise; P8+ changes it — be explicit with TJ at each step.
- **localStorage ~5 MB cap** — candles are heavy (~45 KB per M5 day). A DB removes this.
- **Timestamp convention:** app stores MT5 server wall-clock built from LOCAL date
  components (see `parseMT5DateTime` / `tradeDate`); keep any new ingest consistent.
- **Analytics approximations** to re-check if a number looks off: see the
  `trading-journal-correctness-watchpoints` memory (balance, drawdown, date bucketing,
  R-multiples, serious-start).
- R-multiples are **sparse** on TJ's data (only ~2/324 trades carry a stop).

## 9. Loose threads (nice-to-have, non-blocking)
- Stray tracked `trading_journal.jsx` at repo root — legacy pre-`src/` monolith,
  safe to delete.
- P7.4 auto-sync-on-interval — deferred; **likely subsumed by the P10/P11 backend**, may skip.
- Optional P5 a11y polish (aria-hidden on decorative icons, WCAG contrast pass,
  chart text alternatives) and extracting headerNode/dropzone/priorSection from App.jsx.

## 10. Pointers
- **Memory (auto-loads):** `trading-journal-status.md` (phase status + roadmap),
  `trading-journal-correctness-watchpoints.md` (analytics approximations).
- **Plans:** `~/.claude/plans/mossy-baking-puffin.md` (the P7 plan, as a template).
- **Origin spec:** `TRADING_JOURNAL_DESIGN_SPEC.md`.
