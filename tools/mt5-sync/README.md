# MT5 sync helper

A small **local, read-only** script that pulls your closed trades, balance
operations, and recent candles straight from a running MetaTrader 5 terminal and
writes a `latest.json` the trading-journal app reads via **Settings → Sync from
MT5**. It replaces the manual "export `.xlsx` / save `.csv` / upload" ritual.

**Privacy:** it attaches to the terminal you're already logged into — no login,
no credentials in this script or the repo. The output file stays on your disk;
nothing is uploaded anywhere.

## Requirements

- **Windows** with **MetaTrader 5** installed, **running, and logged in**.
- **Python 3.8+**.
- The [`MetaTrader5`](https://pypi.org/project/MetaTrader5/) package.

## Setup

```bash
cd tools/mt5-sync
python -m pip install -r requirements.txt
copy config.example.json config.json      # then edit config.json
```

Edit `config.json`:

| key                 | meaning                                                            |
|---------------------|-------------------------------------------------------------------|
| `outputDir`         | folder to write `latest.json` into (point the app's Sync folder here) |
| `candleLookbackDays`| how many days of candles to pull per symbol (candles are the big data) |
| `symbols`           | list of `{ "symbol", "timeframe" }` — e.g. `GOLD` / `M5`. Enable each symbol in MT5's Market Watch so candles are available. |

Full trade history + balance operations are always pulled (they're small); only
candles are bounded by `candleLookbackDays`.

> **Storage budget.** The app keeps candles in browser `localStorage` (~5 MB cap).
> Rough guide: **~1 day of M5 ≈ 45 KB** in the browser, so M5 much past ~60 days —
> or several symbols/timeframes at once — can exceed the cap, and the Sync will
> report "storage full." Start modest (the example's 30 days) and widen only if the
> Settings storage meter has room. Per-trade strategy verdicts use **M5** when
> present (M15+ only feed the Setup-scan panel), so prefer M5 for your budget.

## Run

```bash
python sync.py                 # writes <outputDir>/latest.json
python sync.py --dry-run       # print a summary only
python sync.py --out D:/sync --days 60 --symbols GOLD:M5,GOLD:M15   # CLI overrides
```

Then in the app (Chrome/Edge): **Settings → Sync from MT5 → Choose sync folder**
(pick `outputDir`) → **Sync now**. Re-run `sync.py` whenever you want fresh data
and hit **Sync now** again — trades/candles merge by id, so nothing duplicates.

On Firefox/Safari (no folder API), load the generated `latest.json` via
**Settings → Import JSON** instead.

## Tests

Pure aggregation logic (deal → position, running balances) has no MT5 dependency:

```bash
python test_aggregate.py       # or: pytest test_aggregate.py
```

## How it maps to the app

- **Positions** — MT5 *deals* grouped by `position_id` into round-trips. The
  position id becomes the app's `ticket`, so a sync and a manual `.xlsx` upload of
  the same period **merge instead of duplicating**. `sl`/`tp` come from the entry
  order (blank → no R, same as an upload without a stop).
- **Balance ops** — `DEAL_TYPE_BALANCE` deals with a running balance computed over
  full history.
- **Candles** — `copy_rates_range` per configured symbol/timeframe (tick volume).
- **Timestamps** — emitted as MT5 server wall-clock `YYYY.MM.DD HH:MM:SS` strings
  and parsed by the app exactly like the `.xlsx`/`.csv` paths, so day/session
  bucketing matches.

## Notes / gotchas

- If `sync.py` says it can't connect: make sure the MT5 terminal is open and
  logged in (the script attaches to the running instance).
- No candles for a symbol usually means it isn't in **Market Watch** — add it.
- `config.json` is your local file; keep any machine-specific paths out of commits.

## P8.3 — the cloud agent (`agent.py`)

`sync.py` writes a file you import by hand; **`agent.py` pushes the same
payload to your cloud journal automatically** on an interval (default 60 s),
so the web app stays fresh without touching the Sync button. The P7 folder
flow keeps working — the agent still writes `latest.json` every cycle as an
offline fallback.

Setup (once):

1. In the app: **Settings → Signals agent → Generate agent key** (shown once — copy it).
2. `copy config.example.json config.json`, then set `agentKey` (and check
   `ingestUrl`, `symbols` — the P8 signal engine will want M5/M15/M30/H1/H4).
3. With MT5 open and logged in:

```
python agent.py            # loop forever (Ctrl+C to stop)
python agent.py --once     # one push, then exit
python agent.py --dry-run  # show what would be pushed, send nothing
```

How it stays cheap: `agent_state.json` remembers per-series cursors, so each
cycle re-sends only new bars/trades (plus a small overlap — the server upserts,
so re-sends are harmless). Delete `agent_state.json` to force a full re-push.
The agent is **read-only against MT5** and holds **no broker credentials**;
the agent key only authorizes writing journal data to *your* account, and you
can revoke it any time in Settings. Tests: `python test_agent_core.py`.
