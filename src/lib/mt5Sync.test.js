import { describe, it, expect } from "vitest";
import { parseSyncPayload, mergeSync, SYNC_SCHEMA } from "./mt5Sync.js";
import { parseWorkbookRows } from "./analytics.js";

// ISO built from LOCAL components — matches how the app stores MT5 wall-clock times.
const iso = (y, mo, d, h, mi, s = 0) => new Date(y, mo - 1, d, h, mi, s).toISOString();

// A minimal valid payload with overridable sections.
const payload = (over = {}) => ({
  kind: "mt5-sync",
  schema: 1,
  positions: [],
  balanceOps: [],
  candles: [],
  ...over,
});

const syncPos = (over = {}) => ({
  ticket: "1001",
  openTime: "2026.06.01 10:00:00",
  closeTime: "2026.06.01 10:05:00",
  symbol: "GOLD",
  type: "buy",
  volume: "0.10",
  openPrice: "100",
  sl: "99",
  tp: "102",
  closePrice: "101",
  commission: "0",
  swap: "0",
  profit: "10",
  ...over,
});

describe("parseSyncPayload", () => {
  it("normalizes a valid payload and defaults missing sections to []", () => {
    const p = parseSyncPayload({ kind: "mt5-sync" });
    expect(p).toMatchObject({ kind: "mt5-sync", schema: 1, positions: [], balanceOps: [], candles: [] });
  });
  it("parses a JSON string", () => {
    const p = parseSyncPayload(JSON.stringify(payload({ generatedAt: "2026-06-29T00:00:00Z" })));
    expect(p.generatedAt).toBe("2026-06-29T00:00:00Z");
  });
  it("rejects non-JSON, wrong kind, and a newer schema", () => {
    expect(() => parseSyncPayload("{not json")).toThrow(/JSON/i);
    expect(() => parseSyncPayload({ kind: "backup" })).toThrow(/mt5-sync/);
    expect(() => parseSyncPayload({ kind: "mt5-sync", schema: SYNC_SCHEMA + 1 })).toThrow(/newer/i);
  });
});

describe("mergeSync — positions", () => {
  it("dedupes by ticket (incoming wins) and keeps existing-only trades", () => {
    const existing = { positions: [
      { ticket: "1001", symbol: "GOLD", profit: 5 },
      { ticket: "1003", symbol: "GOLD", profit: 7 },
    ] };
    const r = mergeSync(existing, payload({ positions: [syncPos({ ticket: "1001", profit: "10" }), syncPos({ ticket: "1002" })] }));
    const byTicket = Object.fromEntries(r.positions.map((p) => [p.ticket, p]));
    expect(Object.keys(byTicket).sort()).toEqual(["1001", "1002", "1003"]);
    expect(byTicket["1001"].profit).toBe(10); // incoming overwrote
    expect(byTicket["1003"].profit).toBe(7);  // existing-only preserved
  });

  it("preserves a user note when a sync re-imports the same ticket", () => {
    const existing = { positions: [{ ticket: "1001", symbol: "GOLD", profit: 5, note: "#fomo revenge" }] };
    const r = mergeSync(existing, payload({ positions: [syncPos({ ticket: "1001" })] }));
    expect(r.positions[0].note).toBe("#fomo revenge");
  });

  it("skips positions with an unparseable time and counts them", () => {
    const r = mergeSync({}, payload({ positions: [syncPos(), syncPos({ ticket: "bad", openTime: "garbage" })] }));
    expect(r.positions).toHaveLength(1);
    expect(r.stats.skipped).toBe(1);
  });
});

describe("mergeSync — balance ops", () => {
  it("dedupes by dealId (incoming wins)", () => {
    const existing = { balanceOps: [{ dealId: "D1", time: iso(2026, 5, 1, 0, 0), profit: 100, balance: 100, comment: "old" }] };
    const r = mergeSync(existing, payload({ balanceOps: [
      { dealId: "D1", time: "2026.05.01 00:00:00", profit: 100, balance: 100, comment: "new" },
      { dealId: "D2", time: "2026.05.02 00:00:00", profit: -20, balance: 80, comment: "withdrawal" },
    ] }));
    const byId = Object.fromEntries(r.balanceOps.map((b) => [b.dealId, b]));
    expect(Object.keys(byId).sort()).toEqual(["D1", "D2"]);
    expect(byId["D1"].comment).toBe("new");
    expect(byId["D2"]).toMatchObject({ profit: -20, balance: 80 });
  });
});

describe("mergeSync — candles", () => {
  it("merges per symbol/timeframe (incoming wins on dup time), sorts, and rebuilds the index", () => {
    const existing = {
      getCandles: (sym, tf) => (sym === "GOLD" && tf === "M5"
        ? [{ time: iso(2026, 5, 1, 1, 0), open: 1, high: 1, low: 1, close: 1, tickVolume: 1 }]
        : null),
    };
    const r = mergeSync(existing, payload({ candles: [{
      symbol: "GOLD", timeframe: "M5", bars: [
        { time: "2026.05.01 01:00:00", open: 9, high: 9, low: 9, close: 9, tickVolume: 99 }, // overrides existing 01:00
        { time: "2026.05.01 01:05:00", open: 2, high: 3, low: 1, close: 2, tickVolume: 50 },
      ],
    }] }));
    expect(r.candleUpdates).toHaveLength(1);
    const u = r.candleUpdates[0];
    expect(u.key).toBe("tj_candles_GOLD_M5");
    expect(u.candles.map((c) => c.time)).toEqual([iso(2026, 5, 1, 1, 0), iso(2026, 5, 1, 1, 5)]); // sorted, deduped
    expect(u.candles[0].close).toBe(9); // incoming won on the dup timestamp
    expect(r.candleIndex["GOLD_M5"]).toEqual({ symbol: "GOLD", timeframe: "M5", count: 2 });
  });

  it("drops malformed bars (non-numeric OHLC)", () => {
    const r = mergeSync({}, payload({ candles: [{ symbol: "GOLD", timeframe: "M5", bars: [
      { time: "2026.05.01 01:00:00", open: "x", high: 1, low: 1, close: 1 },
      { time: "2026.05.01 01:05:00", open: 2, high: 3, low: 1, close: 2 },
    ] }] }));
    expect(r.candleUpdates[0].candles).toHaveLength(1);
  });
});

describe("mergeSync — account meta", () => {
  it("adopts the payload account, else keeps existing", () => {
    expect(mergeSync({ accountMeta: { account: "old" } }, payload()).accountMeta).toEqual({ account: "old" });
    const r = mergeSync({}, payload({ account: { account: "12345", company: "XM", name: "TJ" } }));
    expect(r.accountMeta).toEqual({ account: "12345", company: "XM", name: "TJ" });
  });
});

describe("parity — a sync position equals the .xlsx-parsed position", () => {
  it("produces the identical stored shape as parseWorkbookRows", () => {
    const rows = [
      ["Name:", "", "", "TJ"],
      ["Account:", "", "", "12345"],
      ["Positions"],
      ["Time", "Position", "Symbol", "Type", "Volume", "Price", "S/L", "T/P", "Time", "Price", "Commission", "Swap", "Profit"],
      ["2026.06.01 10:00:00", "1001", "GOLD.i#", "buy", "0.10", "100", "99", "102", "2026.06.01 10:05:00", "101", "0", "0", "10"],
      ["Orders"],
    ];
    const fromXml = parseWorkbookRows(rows).positions[0];
    const fromSync = mergeSync({}, payload({ positions: [syncPos({ symbol: "GOLD.i#" })] })).positions[0];
    expect(fromSync).toEqual(fromXml);
  });
});
