"""Tests for the pure MT5 aggregation (no terminal needed).

Run without pytest:   python test_aggregate.py
Or with pytest:       pytest test_aggregate.py
"""
from mt5_aggregate import (
    aggregate_positions, aggregate_balance_ops, fmt_time,
    DEAL_TYPE_BUY, DEAL_TYPE_SELL, DEAL_TYPE_BALANCE,
    DEAL_ENTRY_IN, DEAL_ENTRY_OUT,
)


def deal(ticket, type_, entry, pid, time, price=0.0, volume=0.0, profit=0.0,
         commission=0.0, swap=0.0, fee=0.0, symbol="GOLD", order=0, comment=""):
    return dict(ticket=ticket, type=type_, entry=entry, position_id=pid, time=time,
                price=price, volume=volume, profit=profit, commission=commission,
                swap=swap, fee=fee, symbol=symbol, order=order, comment=comment)


def test_fmt_time_is_utc_wallclock():
    assert fmt_time(0) == "1970.01.01 00:00:00"
    assert fmt_time(1000000000) == "2001.09.09 01:46:40"


def test_round_trip_position():
    deals = [
        deal(101, DEAL_TYPE_BUY, DEAL_ENTRY_IN, 5001, 1000, price=100, volume=0.1, order=9001),
        deal(102, DEAL_TYPE_SELL, DEAL_ENTRY_OUT, 5001, 1300, price=102, volume=0.1,
             profit=20, commission=-1, swap=-0.5, order=9002),
    ]
    orders = [{"ticket": 9001, "sl": 98.0, "tp": 104.0}]
    (p,) = aggregate_positions(deals, orders)
    assert p["ticket"] == "5001"
    assert p["type"] == "buy"
    assert p["openTime"] == fmt_time(1000) and p["closeTime"] == fmt_time(1300)
    assert p["openPrice"] == 100 and p["closePrice"] == 102
    assert p["volume"] == 0.1
    assert p["sl"] == 98.0 and p["tp"] == 104.0
    assert p["profit"] == 20 and p["commission"] == -1 and p["swap"] == -0.5


def test_partial_close_volume_weighted_and_summed():
    deals = [
        deal(201, DEAL_TYPE_BUY, DEAL_ENTRY_IN, 6001, 2000, price=100, volume=0.2, order=9101),
        deal(202, DEAL_TYPE_SELL, DEAL_ENTRY_OUT, 6001, 2100, price=101, volume=0.1, profit=10),
        deal(203, DEAL_TYPE_SELL, DEAL_ENTRY_OUT, 6001, 2200, price=103, volume=0.1, profit=30),
    ]
    orders = [{"ticket": 9101, "sl": 0.0, "tp": 0.0}]  # 0.0 => no stop/target
    (p,) = aggregate_positions(deals, orders)
    assert p["closePrice"] == 102  # (101*.1 + 103*.1)/.2
    assert p["profit"] == 40
    assert p["closeTime"] == fmt_time(2200)
    assert p["sl"] is None and p["tp"] is None


def test_open_position_is_skipped():
    deals = [deal(301, DEAL_TYPE_BUY, DEAL_ENTRY_IN, 7001, 3000, price=100, volume=0.1)]
    assert aggregate_positions(deals, []) == []


def test_balance_ops_running_balance():
    deals = [
        deal(1, DEAL_TYPE_BALANCE, DEAL_ENTRY_IN, 0, 500, profit=100, comment="CD-EC-UPI"),
        deal(101, DEAL_TYPE_BUY, DEAL_ENTRY_IN, 5001, 1000, price=100, volume=0.1),
        deal(102, DEAL_TYPE_SELL, DEAL_ENTRY_OUT, 5001, 1300, price=102, volume=0.1,
             profit=20, commission=-1, swap=-0.5),
        deal(2, DEAL_TYPE_BALANCE, DEAL_ENTRY_IN, 0, 2000, profit=-30, comment="withdrawal"),
    ]
    ops = aggregate_balance_ops(deals)
    assert [o["dealId"] for o in ops] == ["1", "2"]
    assert ops[0]["balance"] == 100 and ops[0]["profit"] == 100
    assert ops[1]["balance"] == 88.5 and ops[1]["profit"] == -30  # 100 + 18.5 - 30


def _run():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  PASS {t.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"  FAIL {t.__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return failed


if __name__ == "__main__":
    import sys
    sys.exit(1 if _run() else 0)
