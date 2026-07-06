"""MT5 -> trading-journal sync helper.

Attaches to a RUNNING, logged-in MetaTrader 5 terminal (read-only; no credentials
in this script or the repo), pulls your closed trades + balance operations + recent
candles, and writes `latest.json` into a folder the browser app watches via its
"Sync from MT5" button.

Usage:
    python sync.py                 # uses config.json (or built-in defaults)
    python sync.py --dry-run       # print a summary, don't write latest.json
    python sync.py --out DIR --days 60 --symbols GOLD:M5,GOLD:M15

Requires: Windows, MetaTrader 5 installed & running & logged in, `pip install MetaTrader5`.
"""
import argparse
import json
import os
import sys
import tempfile
from datetime import datetime, timezone, timedelta

try:
    import MetaTrader5 as mt5
except ImportError:
    sys.exit("MetaTrader5 package not found. Run:  pip install -r requirements.txt")

from mt5_aggregate import aggregate_positions, aggregate_balance_ops

SYNC_SCHEMA = 1
HERE = os.path.dirname(os.path.abspath(__file__))

DEFAULTS = {
    "outputDir": os.path.join(os.path.expanduser("~"), "trading-journal-sync"),
    "candleLookbackDays": 30,
    "symbols": [{"symbol": "GOLD", "timeframe": "M5"}],
}


def load_config():
    path = os.path.join(HERE, "config.json")
    cfg = dict(DEFAULTS)
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            cfg.update(json.load(f))
    return cfg


def timeframe_const(tf):
    tfmap = {
        "M1": mt5.TIMEFRAME_M1, "M3": mt5.TIMEFRAME_M3, "M5": mt5.TIMEFRAME_M5,
        "M15": mt5.TIMEFRAME_M15, "M30": mt5.TIMEFRAME_M30, "H1": mt5.TIMEFRAME_H1,
        "H4": mt5.TIMEFRAME_H4, "D1": mt5.TIMEFRAME_D1, "W1": mt5.TIMEFRAME_W1,
        "MN1": mt5.TIMEFRAME_MN1,
    }
    return tfmap.get(tf.upper())


def fetch_candles(symbol, timeframe, since):
    tfc = timeframe_const(timeframe)
    if tfc is None:
        print(f"  ! unknown timeframe {timeframe} for {symbol} — skipped")
        return None
    rates = mt5.copy_rates_range(symbol, tfc, since, datetime.now(timezone.utc))
    if rates is None or len(rates) == 0:
        print(f"  ! no candles for {symbol} {timeframe} (symbol enabled in Market Watch?)")
        return None
    from mt5_aggregate import fmt_time
    bars = [{
        "time": fmt_time(r["time"]),
        "open": float(r["open"]), "high": float(r["high"]),
        "low": float(r["low"]), "close": float(r["close"]),
        "tickVolume": int(r["tick_volume"]),
    } for r in rates]
    return {"symbol": symbol, "timeframe": timeframe.upper(), "bars": bars}


def build_payload(cfg):
    # Deals/orders: pull FULL history (cheap) so positions and the running balance
    # are accurate; only candles are bounded by the lookback (they're the big data).
    epoch_start = datetime(2000, 1, 1, tzinfo=timezone.utc)
    now = datetime.now(timezone.utc)

    deals = [d._asdict() for d in (mt5.history_deals_get(epoch_start, now) or [])]
    orders = [o._asdict() for o in (mt5.history_orders_get(epoch_start, now) or [])]
    positions = aggregate_positions(deals, orders)
    balance_ops = aggregate_balance_ops(deals)

    default_days = int(cfg.get("candleLookbackDays", 30))
    candles = []
    for s in cfg.get("symbols", []):
        # Per-series "lookbackDays" override — fast confirmation TFs (M1/M3)
        # only need a few days, no point hauling 40 days of 1-minute bars.
        days = int(s.get("lookbackDays", default_days))
        since = now - timedelta(days=days)
        print(f"  candles: {s['symbol']} {s['timeframe']} ({days}d) …")
        group = fetch_candles(s["symbol"], s["timeframe"], since)
        if group:
            candles.append(group)

    info = mt5.account_info()
    account = {
        "account": str(info.login) if info else "",
        "company": info.company if info else "",
        "name": info.name if info else "",
    } if info else None

    return {
        "app": "trading-journal",
        "kind": "mt5-sync",
        "schema": SYNC_SCHEMA,
        "generatedAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "account": account,
        "positions": positions,
        "balanceOps": balance_ops,
        "candles": candles,
    }


def write_atomic(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        os.replace(tmp, path)  # atomic on the same volume
    except Exception:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def main():
    ap = argparse.ArgumentParser(description="Sync MT5 history + candles to latest.json")
    ap.add_argument("--out", help="output folder (overrides config outputDir)")
    ap.add_argument("--days", type=int, help="candle lookback in days (overrides config)")
    ap.add_argument("--symbols", help="comma list SYMBOL:TF, e.g. GOLD:M5,GOLD:M15")
    ap.add_argument("--dry-run", action="store_true", help="print a summary, don't write the file")
    args = ap.parse_args()

    cfg = load_config()
    if args.out:
        cfg["outputDir"] = args.out
    if args.days:
        cfg["candleLookbackDays"] = args.days
    if args.symbols:
        cfg["symbols"] = [
            {"symbol": p.split(":")[0], "timeframe": p.split(":")[1]}
            for p in args.symbols.split(",") if ":" in p
        ]

    if not mt5.initialize():
        sys.exit(f"Could not connect to MetaTrader 5 (is the terminal running and logged in?). "
                 f"last_error={mt5.last_error()}")
    try:
        print("Connected to MT5. Building payload…")
        payload = build_payload(cfg)
    finally:
        mt5.shutdown()

    summary = (f"  {len(payload['positions'])} trades · {len(payload['balanceOps'])} balance ops · "
               f"{sum(len(c['bars']) for c in payload['candles'])} candles across "
               f"{len(payload['candles'])} set(s)")
    if args.dry_run:
        print("DRY RUN — not writing.\n" + summary)
        return

    out_path = os.path.join(cfg["outputDir"], "latest.json")
    write_atomic(out_path, payload)
    print(f"Wrote {out_path}\n{summary}")
    print("Now open the app → Settings → Sync from MT5 → point at that folder → Sync now.")


if __name__ == "__main__":
    main()
