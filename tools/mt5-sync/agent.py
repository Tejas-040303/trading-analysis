"""MT5 -> cloud journal agent (P8.3).

Runs next to your logged-in MetaTrader 5 terminal and pushes trades, balance
ops and candles to the journal's `ingest` endpoint on an interval, so the web
app (and, from P8.4, the signal engine) always has fresh data. Read-only
against MT5 — no credentials anywhere; the only secret is the agent key you
generate in the app's Settings.

Also keeps writing `latest.json` each cycle, so the P7 folder-sync/Import
fallback keeps working if you're offline.

Setup (once):
    1. App -> Settings -> Signals agent -> Generate agent key
    2. Copy config.example.json to config.json; set "agentKey" and "ingestUrl"
    3. python agent.py            # loop (default every 60 s)
       python agent.py --once     # single push, then exit
       python agent.py --dry-run  # show what would be pushed, send nothing
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

try:
    import MetaTrader5 as mt5
except ImportError:
    sys.exit("MetaTrader5 package not found. Run:  pip install -r requirements.txt")

from sync import load_config, build_payload, write_atomic
from agent_core import trim_payload, advance_state, payload_summary

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_PATH = os.path.join(HERE, "agent_state.json")


def load_state():
    if os.path.exists(STATE_PATH):
        try:
            with open(STATE_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            print("  ! agent_state.json unreadable — starting from a full push")
    return {}


def save_state(state):
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)


def post_payload(url, agent_key, payload, timeout=120):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json", "x-agent-key": agent_key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read().decode("utf-8")).get("error", "")
        except Exception:
            detail = ""
        return e.code, {"error": detail or str(e)}
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
        return 0, {"error": str(e)}


def ensure_connected():
    # initialize() is idempotent-ish: cheap if already attached, reattaches if
    # the terminal restarted since the last cycle.
    if mt5.initialize():
        return True
    print(f"  ! cannot attach to MT5 (terminal running & logged in?) last_error={mt5.last_error()}")
    return False


def run_cycle(cfg, state, dry_run):
    payload = build_payload(cfg)

    # Keep the P7 folder-sync fallback alive: latest.json always holds the
    # full picture, regardless of what the push trims or whether it succeeds.
    if not dry_run:
        write_atomic(os.path.join(cfg["outputDir"], "latest.json"), payload)

    trimmed = trim_payload(payload, state)
    print(f"  full: {payload_summary(payload)}")
    print(f"  push: {payload_summary(trimmed)}")

    if dry_run:
        return state, True

    status, resp = post_payload(cfg["ingestUrl"], cfg["agentKey"], trimmed)
    if status == 200:
        print(f"  pushed ✓ {resp}")
        state = advance_state(state, payload)
        save_state(state)
        return state, True
    print(f"  ! push failed (HTTP {status}): {resp.get('error', resp)} — will retry next cycle")
    return state, False


def main():
    ap = argparse.ArgumentParser(description="Push MT5 history + candles to the cloud journal on an interval")
    ap.add_argument("--once", action="store_true", help="one push, then exit")
    ap.add_argument("--dry-run", action="store_true", help="build + trim, print summary, send nothing")
    ap.add_argument("--interval", type=int, help="seconds between pushes (overrides config agentIntervalSeconds)")
    args = ap.parse_args()

    cfg = load_config()
    interval = args.interval or int(cfg.get("agentIntervalSeconds", 60))
    if not args.dry_run and (not cfg.get("ingestUrl") or not cfg.get("agentKey")):
        sys.exit("config.json needs \"ingestUrl\" and \"agentKey\" — generate the key in the app: "
                 "Settings -> Signals agent -> Generate agent key (see config.example.json).")

    state = load_state()
    print(f"Agent starting — interval {interval}s, state cursors: "
          f"{'yes' if state else 'none (first run = full push)'}. Ctrl+C to stop.")
    try:
        while True:
            started = time.time()
            if ensure_connected():
                try:
                    state, _ok = run_cycle(cfg, state, args.dry_run)
                except Exception as e:  # keep the loop alive on any cycle error
                    print(f"  ! cycle error: {e}")
            if args.once or args.dry_run:
                break
            time.sleep(max(5, interval - (time.time() - started)))
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        mt5.shutdown()


if __name__ == "__main__":
    main()
