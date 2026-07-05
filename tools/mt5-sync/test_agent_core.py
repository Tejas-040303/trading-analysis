"""Unit tests for agent_core.py (pure — no MetaTrader5 needed).
Run:  python test_agent_core.py
"""
import unittest

from agent_core import (
    trim_payload, advance_state, minus_minutes, series_key, payload_summary,
)


def make_payload():
    return {
        "schema": 1,
        "positions": [
            {"ticket": "1", "closeTime": "2026.07.01 10:00:00"},
            {"ticket": "2", "closeTime": "2026.07.04 15:30:00"},
            {"ticket": "3", "closeTime": "2026.07.05 09:00:00"},
        ],
        "balanceOps": [
            {"dealId": "b1", "time": "2026.06.01 00:00:00"},
            {"dealId": "b2", "time": "2026.07.05 08:00:00"},
        ],
        "candles": [
            {"symbol": "GOLD", "timeframe": "M5", "bars": [
                {"time": "2026.07.05 09:50:00"},
                {"time": "2026.07.05 09:55:00"},
                {"time": "2026.07.05 10:00:00"},
            ]},
            {"symbol": "GOLD", "timeframe": "H1", "bars": [
                {"time": "2026.07.05 08:00:00"},
                {"time": "2026.07.05 09:00:00"},
            ]},
        ],
    }


class TestMinusMinutes(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(minus_minutes("2026.07.05 10:00:00", 15), "2026.07.05 09:45:00")

    def test_crosses_midnight_and_month(self):
        self.assertEqual(minus_minutes("2026.07.01 00:05:00", 10), "2026.06.30 23:55:00")

    def test_none(self):
        self.assertIsNone(minus_minutes(None, 5))


class TestTrimPayload(unittest.TestCase):
    def test_empty_state_sends_everything(self):
        p = make_payload()
        t = trim_payload(p, {})
        self.assertEqual(len(t["positions"]), 3)
        self.assertEqual(len(t["balanceOps"]), 2)
        self.assertEqual(sum(len(g["bars"]) for g in t["candles"]), 5)

    def test_cursors_trim_with_overlap(self):
        p = make_payload()
        state = {
            "positions": "2026.07.05 09:00:00",   # cut = minus 1 day → keeps t2, t3
            "balanceOps": "2026.07.05 08:00:00",  # keeps only b2
            "series": {
                "GOLD_M5": "2026.07.05 10:00:00",  # cut = -15 min → 09:50 onward: all 3
                "GOLD_H1": "2026.07.05 09:00:00",  # cut = -180 min → both bars
            },
        }
        t = trim_payload(p, state)
        self.assertEqual([x["ticket"] for x in t["positions"]], ["2", "3"])
        self.assertEqual([x["dealId"] for x in t["balanceOps"]], ["b2"])
        self.assertEqual(sum(len(g["bars"]) for g in t["candles"]), 5)

    def test_far_future_cursor_drops_empty_groups(self):
        p = make_payload()
        state = {
            "positions": "2026.08.01 00:00:00",
            "balanceOps": "2026.08.01 00:00:00",
            "series": {"GOLD_M5": "2026.08.01 00:00:00", "GOLD_H1": "2026.08.01 00:00:00"},
        }
        t = trim_payload(p, state)
        self.assertEqual(t["positions"], [])
        self.assertEqual(t["balanceOps"], [])
        self.assertEqual(t["candles"], [])  # empty groups removed entirely

    def test_missing_times_are_kept(self):
        p = {"positions": [{"ticket": "x"}], "balanceOps": [], "candles": []}
        t = trim_payload(p, {"positions": "2026.08.01 00:00:00"})
        self.assertEqual(len(t["positions"]), 1)

    def test_original_payload_untouched(self):
        p = make_payload()
        trim_payload(p, {"positions": "2026.08.01 00:00:00"})
        self.assertEqual(len(p["positions"]), 3)


class TestAdvanceState(unittest.TestCase):
    def test_from_empty(self):
        s = advance_state({}, make_payload())
        self.assertEqual(s["positions"], "2026.07.05 09:00:00")
        self.assertEqual(s["balanceOps"], "2026.07.05 08:00:00")
        self.assertEqual(s["series"]["GOLD_M5"], "2026.07.05 10:00:00")
        self.assertEqual(s["series"]["GOLD_H1"], "2026.07.05 09:00:00")

    def test_never_moves_backwards(self):
        old = {"positions": "2027.01.01 00:00:00", "series": {"GOLD_M5": "2027.01.01 00:00:00"}}
        s = advance_state(old, make_payload())
        self.assertEqual(s["positions"], "2027.01.01 00:00:00")
        self.assertEqual(s["series"]["GOLD_M5"], "2027.01.01 00:00:00")

    def test_empty_payload_keeps_state(self):
        old = {"positions": "2026.07.05 09:00:00", "series": {}}
        s = advance_state(old, {"positions": [], "balanceOps": [], "candles": []})
        self.assertEqual(s["positions"], "2026.07.05 09:00:00")


class TestMisc(unittest.TestCase):
    def test_series_key_uppercases_tf(self):
        self.assertEqual(series_key("GOLD", "m5"), "GOLD_M5")

    def test_summary(self):
        self.assertIn("3 trades", payload_summary(make_payload()))


if __name__ == "__main__":
    unittest.main(verbosity=2)
