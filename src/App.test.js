import { describe, it, expect } from "vitest";
import { computeAnalytics } from "./App.jsx";
import { parseWorkbookRows, parseTags, confluenceOf } from "./lib/analytics.js";

// Build an ISO string from LOCAL components (matches how the app stores times).
const iso = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0).toISOString();

const trade = (ticket, open, close, profit, opts = {}) => ({
  ticket: String(ticket),
  symbol: opts.symbol || "GOLD",
  type: opts.type || "buy",
  openTime: iso(...open),
  closeTime: iso(...close),
  volume: opts.volume ?? 0.1,
  openPrice: opts.openPrice ?? 100,
  sl: opts.sl ?? null,
  tp: null,
  closePrice: opts.closePrice ?? 101,
  commission: 0,
  swap: 0,
  profit,
});

describe("computeAnalytics — headline P/L, streaks, expectancy, monthly", () => {
  // 5 trades, hand-computed expectations. Order by openTime: T1 W, T2 W, T3 L, T4 L, T5 W.
  const positions = [
    trade(1, [2026, 6, 1, 10, 0], [2026, 6, 1, 10, 5], 10),   // +10, 5min  (long)
    trade(2, [2026, 6, 1, 11, 0], [2026, 6, 1, 11, 5], 20),   // +20, 5min  (long)
    trade(3, [2026, 6, 2, 10, 0], [2026, 6, 2, 10, 1], -5),   // -5,  1min  (short)
    trade(4, [2026, 6, 2, 10, 10], [2026, 6, 2, 10, 11], -15),// -15, 1min  (short)
    trade(5, [2026, 7, 1, 9, 0], [2026, 7, 1, 9, 10], 30),    // +30, 10min (long)
  ];
  const a = computeAnalytics(positions, []);

  it("computes win rate, gross/net, profit factor, largest win/loss", () => {
    expect(a.totalTrades).toBe(5);
    expect(a.winRate).toBe(60);
    expect(a.grossProfit).toBe(60);
    expect(a.grossLoss).toBe(-20);
    expect(a.netProfit).toBe(40);
    expect(a.profitFactor).toBe(3);
    expect(a.largestWin).toBe(30);
    expect(a.largestLoss).toBe(-15);
  });

  it("computes expectancy and avg win/loss", () => {
    expect(a.avgWin).toBe(20);
    expect(a.avgLoss).toBe(-10);
    expect(a.expectancy).toBe(8); // 0.6*20 + 0.4*(-10)
  });

  it("computes win/loss streaks and the current run", () => {
    expect(a.longestWinStreak).toBe(2);
    expect(a.longestLossStreak).toBe(2);
    expect(a.currentStreak).toEqual({ dir: "win", len: 1 });
  });

  it("splits the under-3-min vs 3-min-plus buckets", () => {
    expect(a.shortCount).toBe(2);
    expect(a.shortNet).toBe(-20);
    expect(a.longCount).toBe(3);
    expect(a.longNet).toBe(60);
  });

  it("rolls up monthly summaries (newest first)", () => {
    expect(a.monthlyStats.map((m) => m.ym)).toEqual(["2026-07", "2026-06"]);
    const june = a.monthlyStats.find((m) => m.ym === "2026-06");
    expect(june).toMatchObject({ trades: 4, profit: 10, days: 2, winRate: 50 });
    const july = a.monthlyStats.find((m) => m.ym === "2026-07");
    expect(july).toMatchObject({ trades: 1, profit: 30, days: 1, winRate: 100 });
  });

  it("returns null for empty input", () => {
    expect(computeAnalytics([], [])).toBe(null);
  });
});

describe("computeAnalytics — R-multiples (empirical point value)", () => {
  // All GOLD, vol 0.1, engineered so pointValue solves to 100 for every trade.
  const positions = [
    trade("A", [2026, 6, 1, 10, 0], [2026, 6, 1, 10, 9], 20, { openPrice: 100, closePrice: 102, sl: 98 }), // pv=20/(2*.1)=100, risk=2*.1*100=20, r=1
    trade("B", [2026, 6, 1, 11, 0], [2026, 6, 1, 11, 9], 10, { openPrice: 100, closePrice: 101, sl: 99 }), // pv=10/(1*.1)=100, risk=1*.1*100=10, r=1
    trade("C", [2026, 6, 1, 12, 0], [2026, 6, 1, 12, 9], -10, { openPrice: 100, closePrice: 99, sl: 99 }), // pv=-10/(-1*.1)=100, risk=10, r=-1
  ];
  const a = computeAnalytics(positions, []);

  it("derives R per trade and the average", () => {
    expect(a.rCount).toBe(3);
    expect(a.avgR).toBeCloseTo(0.33, 2); // (1 + 1 - 1)/3
    const byTicket = Object.fromEntries(a.tradesList.map((t) => [t.ticket, t.r]));
    expect(byTicket.A).toBe(1);
    expect(byTicket.B).toBe(1);
    expect(byTicket.C).toBe(-1);
  });

  it("leaves R null when there is no stop", () => {
    const noSl = computeAnalytics([trade(9, [2026, 6, 1, 10, 0], [2026, 6, 1, 10, 9], 10, { sl: null })], []);
    expect(noSl.tradesList[0].r).toBe(null);
  });
});

describe("parseWorkbookRows", () => {
  it("parses positions, cleans the symbol, reads meta, and counts skipped rows", () => {
    const rows = [
      ["Name:", "", "", "TJ"],
      ["Account:", "", "", "12345"],
      ["Positions"],
      ["Time", "Position", "Symbol", "Type", "Volume", "Price", "S/L", "T/P", "Time", "Price", "Commission", "Swap", "Profit"],
      ["2026.06.01 10:00:00", "1001", "GOLD.i#", "buy", "0.10", "100", "99", "102", "2026.06.01 10:05:00", "101", "0", "0", "10"],
      ["bad-date", "1002", "GOLD", "buy", "0.10", "100", "", "", "2026.06.01 11:00:00", "101", "0", "0", "5"], // unparseable open => skipped
      ["Orders"],
    ];
    const { positions, meta, skipped } = parseWorkbookRows(rows);
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ ticket: "1001", symbol: "GOLD", type: "buy", volume: 0.1, profit: 10 });
    expect(skipped).toBe(1);
    expect(meta).toMatchObject({ name: "TJ", account: "12345" });
  });
});

describe("parseTags", () => {
  it("extracts, lowercases, and dedupes hashtags", () => {
    expect(parseTags("entered on #FOMO, then #scalp #fomo")).toEqual(["#fomo", "#scalp"]);
  });
  it("returns [] when there are no tags", () => {
    expect(parseTags("just a plain note")).toEqual([]);
    expect(parseTags("")).toEqual([]);
    expect(parseTags(null)).toEqual([]);
  });
});

describe("confluenceOf", () => {
  it("counts only supportive verdicts and excludes S6; ignores 'insufficient'", () => {
    const v = {
      s1: { verdict: "aligned" },     // hit
      s2: { verdict: "at-ob" },       // hit
      s3: { verdict: "no-fvg" },      // scored, not a hit
      s4: { verdict: "swept" },       // hit
      s5: { verdict: "outside-va" },  // scored, not a hit
      s6: { session: "London" },      // excluded from confluence
    };
    const c = confluenceOf(v);
    expect(c.score).toBe(3);
    expect(c.hits).toEqual(["S1", "S2", "S4"]);
    expect(c.scored).toBe(5);
  });

  it("does not score strategies with no usable verdict", () => {
    const v = { s1: { verdict: "insufficient" }, s2: null, s3: { verdict: "at-fvg" } };
    const c = confluenceOf(v);
    expect(c.score).toBe(1);
    expect(c.hits).toEqual(["S3"]);
    expect(c.scored).toBe(1); // only s3 was usable
  });
});
