"""Pure helpers for agent.py (P8.3) — no MetaTrader5 import, so these are
unit-testable anywhere (see test_agent_core.py).

Cursor logic: MT5 times in the payload are fixed-width "YYYY.MM.DD HH:MM:SS"
strings, which sort lexicographically in time order — cursors are therefore
plain string comparisons. Trims are deliberately generous (overlap windows)
because the ingest endpoint upserts idempotently; re-sending a row is free,
missing one is not.
"""
from datetime import datetime, timedelta

TF_MINUTES = {
    "M1": 1, "M3": 3, "M5": 5, "M15": 15, "M30": 30,
    "H1": 60, "H4": 240, "D1": 1440, "W1": 10080, "MN1": 43200,
}

FMT = "%Y.%m.%d %H:%M:%S"

# Default overlap: re-send anything from the last day of trades/balance ops,
# and the last few bars per candle series (the forming bar keeps changing).
POSITION_OVERLAP_MINUTES = 24 * 60
CANDLE_OVERLAP_BARS = 3


def minus_minutes(t, minutes):
    """'YYYY.MM.DD HH:MM:SS' minus N minutes, same format. None-safe."""
    if not t:
        return None
    return (datetime.strptime(t, FMT) - timedelta(minutes=minutes)).strftime(FMT)


def series_key(symbol, timeframe):
    return f"{symbol}_{str(timeframe).upper()}"


def _keep_since(t, threshold):
    # Keep items with no/unparseable time (defensive: better re-sent than lost).
    return not threshold or not t or t >= threshold


def trim_payload(payload, state,
                 position_overlap_minutes=POSITION_OVERLAP_MINUTES,
                 candle_overlap_bars=CANDLE_OVERLAP_BARS):
    """Return a copy of `payload` with only data at/after the cursors in
    `state` (minus overlap). `state` = {"positions": t, "balanceOps": t,
    "series": {key: t}} with missing entries meaning "send everything"."""
    state = state or {}
    pos_cut = minus_minutes(state.get("positions"), position_overlap_minutes)
    bal_cut = minus_minutes(state.get("balanceOps"), position_overlap_minutes)
    series_state = state.get("series") or {}

    out = dict(payload)
    out["positions"] = [p for p in payload.get("positions", [])
                        if _keep_since(p.get("closeTime"), pos_cut)]
    out["balanceOps"] = [b for b in payload.get("balanceOps", [])
                         if _keep_since(b.get("time"), bal_cut)]

    groups = []
    for g in payload.get("candles", []):
        key = series_key(g.get("symbol"), g.get("timeframe"))
        last = series_state.get(key)
        tf_min = TF_MINUTES.get(str(g.get("timeframe", "")).upper(), 1)
        cut = minus_minutes(last, candle_overlap_bars * tf_min)
        bars = [b for b in g.get("bars", []) if _keep_since(b.get("time"), cut)]
        if bars:
            groups.append({**g, "bars": bars})
    out["candles"] = groups
    return out


def advance_state(state, payload):
    """New cursor state = max times seen in the FULL payload (not the trimmed
    one), so a successful push never re-sends more than the overlap."""
    state = dict(state or {})
    series = dict(state.get("series") or {})

    def max_time(items, field, current):
        times = [i.get(field) for i in items if i.get(field)]
        if not times:
            return current
        m = max(times)
        return m if not current or m > current else current

    state["positions"] = max_time(payload.get("positions", []), "closeTime", state.get("positions"))
    state["balanceOps"] = max_time(payload.get("balanceOps", []), "time", state.get("balanceOps"))
    for g in payload.get("candles", []):
        key = series_key(g.get("symbol"), g.get("timeframe"))
        series[key] = max_time(g.get("bars", []), "time", series.get(key))
    state["series"] = series
    return state


def payload_summary(payload):
    bars = sum(len(g.get("bars", [])) for g in payload.get("candles", []))
    return (f"{len(payload.get('positions', []))} trades · "
            f"{len(payload.get('balanceOps', []))} balance ops · "
            f"{bars} candles in {len(payload.get('candles', []))} set(s)")
