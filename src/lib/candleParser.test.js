import { describe, it, expect } from "vitest";
import { parseCandleCSV, inferSymbolTimeframe, mergeCandles, candleStorageKey } from "./candleParser.js";

// MT5 candle CSV is tab-separated: DATE TIME OPEN HIGH LOW CLOSE TICKVOL VOL SPREAD
const row = (d, t, o, h, l, c, tv = 100) => [d, t, o, h, l, c, tv, 0, 10].join("\t");

describe("parseCandleCSV", () => {
  it("parses well-formed rows and skips the header without counting it", () => {
    const csv = [
      "<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>",
      row("2026.05.01", "01:00:00", "4625.63", "4636.17", "4625.50", "4628.66", 757),
      row("2026.05.01", "01:05:00", "4628.66", "4630.00", "4620.00", "4622.10", 640),
    ].join("\n");
    const { candles, skipped } = parseCandleCSV(csv);
    expect(candles).toHaveLength(2);
    expect(skipped).toBe(0);
    expect(candles[0]).toMatchObject({ open: 4625.63, high: 4636.17, low: 4625.5, close: 4628.66, tickVolume: 757 });
    // time is stored as the UTC ISO of the LOCAL wall-clock (same convention as
    // trade timestamps), so assert the round-trip through local components —
    // timezone-independent, and the invariant the app actually relies on.
    const back = new Date(candles[0].time);
    expect([back.getFullYear(), back.getMonth(), back.getDate(), back.getHours(), back.getMinutes()]).toEqual([2026, 4, 1, 1, 0]);
  });

  it("counts malformed data rows as skipped, not as candles", () => {
    const csv = [
      row("2026.05.01", "01:00:00", "100", "101", "99", "100.5"),
      "2026.05.01\t01:05:00\tonly\tfour", // too few columns
      row("not-a-date", "01:10:00", "100", "101", "99", "100"), // bad date
      row("2026.05.01", "bad-time", "100", "101", "99", "100"), // bad time
      row("2026.05.01", "01:15:00", "x", "101", "99", "100"), // non-numeric OHLC
    ].join("\n");
    const { candles, skipped } = parseCandleCSV(csv);
    expect(candles).toHaveLength(1);
    expect(skipped).toBe(4);
  });

  it("returns empty result for blank input", () => {
    expect(parseCandleCSV("")).toEqual({ candles: [], skipped: 0 });
  });
});

describe("mergeCandles", () => {
  it("dedupes by timestamp (later upload wins) and sorts ascending", () => {
    const a = [
      { time: "2026-05-01T01:05:00.000Z", close: 1 },
      { time: "2026-05-01T01:00:00.000Z", close: 2 },
    ];
    const b = [
      { time: "2026-05-01T01:05:00.000Z", close: 99 }, // overrides a's 01:05 close
      { time: "2026-05-01T01:10:00.000Z", close: 3 },
    ];
    const merged = mergeCandles(a, b);
    expect(merged.map((c) => c.time)).toEqual([
      "2026-05-01T01:00:00.000Z",
      "2026-05-01T01:05:00.000Z",
      "2026-05-01T01:10:00.000Z",
    ]);
    expect(merged.find((c) => c.time === "2026-05-01T01:05:00.000Z").close).toBe(99);
  });

  it("handles a null/undefined existing array", () => {
    const incoming = [{ time: "2026-05-01T01:00:00.000Z", close: 1 }];
    expect(mergeCandles(null, incoming)).toHaveLength(1);
    expect(mergeCandles(undefined, incoming)).toHaveLength(1);
  });
});

describe("inferSymbolTimeframe", () => {
  it("parses the MT5 default export filename", () => {
    expect(inferSymbolTimeframe("GOLD_i__M5_202605010100_202606191950.csv")).toEqual({ symbol: "GOLD", timeframe: "M5" });
  });

  it("finds a timeframe token when the name is non-standard", () => {
    const r = inferSymbolTimeframe("BTCUSD M15 export.csv");
    expect(r.symbol).toBe("BTCUSD");
    expect(r.timeframe).toBe("M15");
  });
});

describe("candleStorageKey", () => {
  it("builds the tj_candles_<SYMBOL>_<TF> key", () => {
    expect(candleStorageKey("GOLD", "M5")).toBe("tj_candles_GOLD_M5");
  });
});
