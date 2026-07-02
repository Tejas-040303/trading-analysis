"""Pure aggregation logic for the MT5 sync helper — no MetaTrader5 import, so it's
unit-testable without a terminal.

It turns MT5 *deals* (the individual fills MT5 records) into the app's *positions*
(round-trip trades) and *balance operations*, matching the shapes the manual .xlsx
upload produces. Two parity properties with the app's existing ingestion:

  1. ID parity  — a position's id == the MT5 position_id, a balance op's id == the
     balance deal ticket, so a sync and a manual upload of the same period merge
     (dedupe) instead of duplicating.
  2. Time parity — timestamps are emitted as MT5 server wall-clock
     "YYYY.MM.DD HH:MM:SS" strings (see fmt_time), which the app parses with the
     same parseMT5DateTime the .xlsx path uses, so day/session bucketing matches.

Deals/orders are passed in as plain dicts (from MetaTrader5 namedtuple._asdict()).
"""
from datetime import datetime, timezone

# ── MT5 enum values (documented constants so tests need no MetaTrader5) ──
DEAL_TYPE_BUY = 0
DEAL_TYPE_SELL = 1
DEAL_TYPE_BALANCE = 2
DEAL_ENTRY_IN = 0
DEAL_ENTRY_OUT = 1
DEAL_ENTRY_INOUT = 2
DEAL_ENTRY_OUT_BY = 3


def fmt_time(epoch):
    """MT5 timestamps are server-time stored as if UTC; reading them back in UTC
    recovers the server wall-clock — exactly what the .xlsx report shows and what
    the app buckets by. Returns 'YYYY.MM.DD HH:MM:SS'."""
    return datetime.fromtimestamp(int(epoch), tz=timezone.utc).strftime("%Y.%m.%d %H:%M:%S")


def _none_if_zero(v):
    # MT5 uses 0.0 to mean "no stop / no target"; the app wants null there.
    return v if v else None


def aggregate_positions(deals, orders):
    """Group trade deals by position_id into closed round-trip positions.

    Still-open positions (an entry with no exit) are skipped — the journal is about
    closed trades. sl/tp come from the entry order (0.0 -> None)."""
    orders_by_ticket = {o.get("ticket"): o for o in orders}

    groups = {}
    for d in deals:
        if d.get("type") not in (DEAL_TYPE_BUY, DEAL_TYPE_SELL):
            continue  # balance / credit / charge deals aren't trades
        pid = d.get("position_id")
        if not pid:
            continue
        groups.setdefault(pid, []).append(d)

    positions = []
    for pid, ds in groups.items():
        ds.sort(key=lambda x: (x["time"], x["ticket"]))
        entries = [d for d in ds if d.get("entry") == DEAL_ENTRY_IN]
        outs = [d for d in ds if d.get("entry") in (DEAL_ENTRY_OUT, DEAL_ENTRY_OUT_BY)]
        if not entries or not outs:
            continue  # open or malformed

        entry = entries[0]
        evol = sum(e["volume"] for e in entries) or entry["volume"]
        open_price = (sum(e["price"] * e["volume"] for e in entries) / evol) if evol else entry["price"]
        ovol = sum(o["volume"] for o in outs)
        close_price = (sum(o["price"] * o["volume"] for o in outs) / ovol) if ovol else outs[-1]["price"]

        # Profit excludes commission/swap (separate columns, like the .xlsx report);
        # fee is folded into commission.
        profit = sum(d.get("profit", 0.0) for d in ds)
        commission = sum(d.get("commission", 0.0) + d.get("fee", 0.0) for d in ds)
        swap = sum(d.get("swap", 0.0) for d in ds)

        entry_order = orders_by_ticket.get(entry.get("order"))
        sl = _none_if_zero(entry_order.get("sl")) if entry_order else None
        tp = _none_if_zero(entry_order.get("tp")) if entry_order else None

        positions.append({
            "ticket": str(pid),
            "openTime": fmt_time(entry["time"]),
            "closeTime": fmt_time(outs[-1]["time"]),
            "symbol": entry.get("symbol", ""),
            "type": "buy" if entry.get("type") == DEAL_TYPE_BUY else "sell",
            "volume": evol,
            "openPrice": open_price,
            "sl": sl,
            "tp": tp,
            "closePrice": close_price,
            "commission": commission,
            "swap": swap,
            "profit": profit,
        })

    positions.sort(key=lambda p: p["openTime"])
    return positions


def aggregate_balance_ops(deals):
    """Balance-type deals (deposits/withdrawals/transfers) with the running account
    balance after each. Running balance = cumulative (profit+commission+swap+fee)
    over ALL deals in chronological order, so pass the full deal history."""
    ds = sorted(deals, key=lambda x: (x["time"], x["ticket"]))
    running = 0.0
    ops = []
    for d in ds:
        running += d.get("profit", 0.0) + d.get("commission", 0.0) + d.get("swap", 0.0) + d.get("fee", 0.0)
        if d.get("type") == DEAL_TYPE_BALANCE:
            ops.append({
                "dealId": str(d["ticket"]),
                "time": fmt_time(d["time"]),
                "profit": d.get("profit", 0.0),
                "balance": round(running, 2),
                "comment": d.get("comment", "") or "",
            })
    return ops
