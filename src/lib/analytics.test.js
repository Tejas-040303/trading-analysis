import { describe, it, expect } from "vitest";
import {
  computeAnalytics, parseWorkbookRows, parseTags, confluenceOf,
  parseMT5DateTime, numOrNull, cleanSymbol, tradeDate, summarizePrior,
} from "./analytics.js";

// Build an ISO string from LOCAL components (matches how the app stores times).
const iso = (y, mo, d, h, mi, s = 0) => new Date(y, mo - 1, d, h, mi, s).toISOString();

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

// Balance op: { dealId, time, profit, balance, comment }
const bop = (dealId, time, profit, balance, comment) => ({
  dealId: String(dealId), time: iso(...time), profit, balance, comment,
});

describe("computeAnalytics — duration buckets and short/long split", () => {
  const positions = [
    trade(1, [2026, 6, 1, 8, 30, 0], [2026, 6, 1, 8, 30, 30], 50),  // 0.5 min -> <1m
    trade(2, [2026, 6, 1, 9, 0], [2026, 6, 1, 9, 2], -30),          // 2 min   -> 1-3m
    trade(3, [2026, 6, 1, 10, 0], [2026, 6, 1, 10, 5], -20),        // 5 min   -> 3-10m
    trade(4, [2026, 6, 1, 11, 0], [2026, 6, 1, 11, 40], 40),        // 40 min  -> >30m
  ];
  const a = computeAnalytics(positions, []);
  const bucket = (label) => a.durationBuckets.find((b) => b.label === label);

  it("places trades in the right duration buckets", () => {
    expect(bucket("<1m")).toMatchObject({ n: 1, netPl: 50, winRate: 100 });
    expect(bucket("1-3m")).toMatchObject({ n: 1, netPl: -30, winRate: 0 });
    expect(bucket("3-10m")).toMatchObject({ n: 1, netPl: -20, winRate: 0 });
    expect(bucket("10-30m")).toMatchObject({ n: 0, netPl: 0, winRate: 0 });
    expect(bucket(">30m")).toMatchObject({ n: 1, netPl: 40, winRate: 100 });
  });

  it("splits under-3-min vs 3-min-plus", () => {
    expect(a.shortCount).toBe(2);
    expect(a.shortNet).toBe(20);   // 50 - 30
    expect(a.longCount).toBe(2);
    expect(a.longNet).toBe(20);    // -20 + 40
  });
});

describe("computeAnalytics — equity-curve drawdown", () => {
  // Opening balance 100 (from the first balance op); trades replayed in close order:
  // +50 -> 150 (peak), -30 -> 120, -20 -> 100 (trough, dd 50 = 33.3% of 150), +40 -> 140.
  const positions = [
    trade(1, [2026, 6, 1, 8, 30], [2026, 6, 1, 9, 0], 50),
    trade(2, [2026, 6, 1, 9, 30], [2026, 6, 1, 10, 0], -30),
    trade(3, [2026, 6, 1, 10, 30], [2026, 6, 1, 11, 0], -20),
    trade(4, [2026, 6, 1, 11, 30], [2026, 6, 1, 12, 0], 40),
  ];
  const ops = [bop("D1", [2026, 6, 1, 8, 0], 100, 100, "CD-EC-UPI deposit")];
  const a = computeAnalytics(positions, ops);

  it("computes worst peak-to-trough drop in $ and %", () => {
    expect(a.maxDrawdownAmt).toBe(50);
    expect(a.maxDrawdownPct).toBe(33.3);
  });

  it("derives current balance and ROI from deposits", () => {
    expect(a.currentBalance).toBe(140); // 100 + net 40 (all trades closed after the deposit)
    expect(a.depositsTotal).toBe(100);
    expect(a.roiPct).toBe(40);          // net 40 / deposits 100
  });
});

describe("computeAnalytics — balance ledger classification", () => {
  const positions = [trade(1, [2026, 6, 1, 9, 0], [2026, 6, 1, 9, 30], 40)];
  const ops = [
    bop("D1", [2026, 6, 1, 8, 0], 100, 100, "CD-EC-UPI"),         // deposit
    bop("W1", [2026, 6, 2, 8, 0], -20, 80, "withdrawal request"),  // withdrawal
    bop("TO", [2026, 6, 3, 8, 0], -30, 50, "transfer to acc2"),    // transfer_out
    bop("TI", [2026, 6, 4, 8, 0], 10, 60, "transfer from acc2"),   // transfer_in
  ];
  const a = computeAnalytics(positions, ops);

  it("classifies and sums each op kind", () => {
    expect(a.depositsSum).toBe(100);
    expect(a.withdrawalsSum).toBe(-20);
    expect(a.transferOutSum).toBe(-30);
    expect(a.transferInSum).toBe(10);
    expect(a.netCapital).toBe(80);       // deposits + withdrawals
    expect(a.depositsTotal).toBe(80);    // non-transfer profit sum (100 - 20)
  });

  it("orders the ledger newest-first with the right kind tags", () => {
    expect(a.balanceOps.map((o) => o.kind)).toEqual(["transfer_in", "transfer_out", "withdrawal", "deposit"]);
  });
});

describe("computeAnalytics — session buckets (GMT offset)", () => {
  const positions = [
    trade(1, [2026, 6, 1, 3, 0], [2026, 6, 1, 3, 5], 10),   // 03:00 -> Asian
    trade(2, [2026, 6, 1, 10, 0], [2026, 6, 1, 10, 5], 20), // 10:00 -> London
    trade(3, [2026, 6, 1, 15, 0], [2026, 6, 1, 15, 5], -5), // 15:00 -> New York
    trade(4, [2026, 6, 1, 22, 0], [2026, 6, 1, 22, 5], 3),  // 22:00 -> Off-hours
  ];

  it("is null until the broker offset is set", () => {
    expect(computeAnalytics(positions, []).sessionStats).toBe(null);
  });

  it("buckets by GMT hour when the offset is provided", () => {
    const a = computeAnalytics(positions, [], { ...({ overtradeThreshold: 15, tiltStreakMin: 3, revengeWindowMin: 3, swingLookback: 5, seriousStart: "2026-05-28" }), brokerGmtOffsetHours: 0 });
    const s = (name) => a.sessionStats.find((x) => x.session === name);
    expect(s("Asian")).toMatchObject({ trades: 1, profit: 10 });
    expect(s("London")).toMatchObject({ trades: 1, profit: 20 });
    expect(s("New York")).toMatchObject({ trades: 1, profit: -5 });
    expect(s("Off-hours")).toMatchObject({ trades: 1, profit: 3 });
  });
});

describe("computeAnalytics — tilt clusters and revenge re-entries", () => {
  // Three consecutive same-day same-symbol losses, each re-entered ~1 min after the last.
  const positions = [
    trade(1, [2026, 6, 1, 10, 0], [2026, 6, 1, 10, 1], -5),
    trade(2, [2026, 6, 1, 10, 2], [2026, 6, 1, 10, 3], -5),
    trade(3, [2026, 6, 1, 10, 4], [2026, 6, 1, 10, 5], -5),
  ];
  const a = computeAnalytics(positions, []);

  it("emits one tilt cluster of 3 losses", () => {
    expect(a.tiltClusters).toHaveLength(1);
    expect(a.tiltClusters[0]).toMatchObject({ count: 3, pl: -15 });
  });

  it("counts quick same-symbol re-entries after a loss as revenge", () => {
    expect(a.revengeCount).toBe(2);  // trades 2 and 3
    expect(a.revengePl).toBe(-10);
  });
});

describe("computeAnalytics — symbol and day-of-week grouping", () => {
  const positions = [
    trade(1, [2026, 6, 1, 10, 0], [2026, 6, 1, 10, 5], 10, { symbol: "GOLD" }),   // Mon
    trade(2, [2026, 6, 1, 11, 0], [2026, 6, 1, 11, 5], -4, { symbol: "GOLD" }),   // Mon
    trade(3, [2026, 6, 2, 10, 0], [2026, 6, 2, 10, 5], 7, { symbol: "BTCUSD" }),  // Tue
  ];
  const a = computeAnalytics(positions, []);

  it("groups by symbol (sorted by trade count desc)", () => {
    expect(a.symbolStats[0]).toMatchObject({ symbol: "GOLD", n: 2, netPl: 6, winRate: 50 });
    expect(a.symbolStats.find((s) => s.symbol === "BTCUSD")).toMatchObject({ n: 1, netPl: 7, winRate: 100 });
  });

  it("groups by weekday (Mon-first ordering)", () => {
    expect(a.dowStats[0]).toMatchObject({ day: "Mon", trades: 2, profit: 6 });
    expect(a.dowStats[1]).toMatchObject({ day: "Tue", trades: 1, profit: 7 });
  });

  it("builds the time-of-day grid keyed by weekday-hour", () => {
    // 2026-06-01 is a Monday (getDay() === 1), both GOLD trades opened at hour 10/11
    expect(a.todGrid["1-10"]).toMatchObject({ n: 1, wins: 1 });
    expect(a.todGrid["1-11"]).toMatchObject({ n: 1, wins: 0 });
  });
});

describe("parseMT5DateTime", () => {
  it("parses the MT5 'YYYY.MM.DD HH:MM:SS' string into a local Date", () => {
    const d = parseMT5DateTime("2026.06.01 10:05:30");
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()])
      .toEqual([2026, 5, 1, 10, 5, 30]);
  });
  it("parses an Excel serial number from the 1899-12-30 epoch", () => {
    expect(parseMT5DateTime(25569).toISOString()).toBe("1970-01-01T00:00:00.000Z");
    expect(parseMT5DateTime(25570).toISOString()).toBe("1970-01-02T00:00:00.000Z");
  });
  it("returns null for unparseable input", () => {
    expect(parseMT5DateTime(null)).toBe(null);
    expect(parseMT5DateTime("not a date")).toBe(null);
    expect(parseMT5DateTime({})).toBe(null);
  });
});

describe("numOrNull / cleanSymbol / tradeDate", () => {
  it("numOrNull coerces numeric values and nulls the rest", () => {
    expect(numOrNull(5)).toBe(5);
    expect(numOrNull("3.14")).toBe(3.14);
    expect(numOrNull("")).toBe(null);
    expect(numOrNull(null)).toBe(null);
    expect(numOrNull("abc")).toBe(null);
  });
  it("cleanSymbol strips broker # and .i suffixes", () => {
    expect(cleanSymbol("GOLD.i#")).toBe("GOLD");
    expect(cleanSymbol("BTCUSD")).toBe("BTCUSD");
    expect(cleanSymbol(null)).toBe("");
  });
  it("tradeDate buckets by local wall-clock day, zero-padded", () => {
    expect(tradeDate(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
    expect(tradeDate(new Date(2026, 11, 31, 0, 0))).toBe("2026-12-31");
  });
});

describe("parseWorkbookRows — Deals / balance operations", () => {
  it("reads balance-type deals, skips non-balance deals, and stops at 'Balance:'", () => {
    const rows = [
      ["Positions"],
      ["Time", "Position", "Symbol", "Type", "Volume", "Price", "S/L", "T/P", "Time", "Price", "Commission", "Swap", "Profit"],
      ["Orders"],
      ["Deals"],
      ["Time", "Deal", "Symbol", "Type", "Direction", "Volume", "Price", "Order", "Commission", "Fee", "Swap", "Profit", "Balance", "Comment"],
      ["2026.05.01 00:00:00", "5001", "", "balance", "", "", "", "", "", "", "", "100", "100", "CD-EC-UPI deposit"],
      ["2026.05.02 00:00:00", "5002", "GOLD", "buy", "in", "0.1", "100", "9", "0", "0", "0", "5", "105", ""], // not a balance op
      ["Balance:", "", "", "", "", "", "", "", "", "", "", "", "", ""],
      ["2026.05.03 00:00:00", "9999", "", "balance", "", "", "", "", "", "", "", "999", "999", "after Balance: — ignored"],
    ];
    const { balanceOps } = parseWorkbookRows(rows);
    expect(balanceOps).toHaveLength(1);
    expect(balanceOps[0]).toMatchObject({ dealId: "5001", profit: 100, balance: 100, comment: "CD-EC-UPI deposit" });
  });
});

describe("summarizePrior (beginner-era archive)", () => {
  const p = (profit, openTime) => ({ profit, openTime: iso(...openTime) });
  it("summarizes prior trades and capital flows (transfers excluded)", () => {
    const positions = [p(10, [2026, 1, 1, 10, 0]), p(-4, [2026, 1, 3, 10, 0]), p(0, [2026, 1, 2, 10, 0])];
    const ops = [
      { profit: 100, comment: "deposit" },
      { profit: -20, comment: "withdrawal" },
      { profit: -30, comment: "transfer to acc2" }, // excluded from deposits/withdrawals
    ];
    const s = summarizePrior(positions, ops);
    expect(s).toMatchObject({ trades: 3, net: 6, winRate: 33.3, deposits: 100, withdrawals: -20, ops: 3 });
    expect(s.firstDate).toBe(iso(2026, 1, 1, 10, 0));
    expect(s.lastDate).toBe(iso(2026, 1, 3, 10, 0));
  });
  it("returns null when there is nothing prior", () => {
    expect(summarizePrior([], [])).toBe(null);
  });
});

describe("computeAnalytics — edge cases", () => {
  it("returns profitFactor null when there are no losses", () => {
    const a = computeAnalytics([
      trade(1, [2026, 6, 1, 10, 0], [2026, 6, 1, 10, 5], 10),
      trade(2, [2026, 6, 1, 11, 0], [2026, 6, 1, 11, 5], 20),
    ], []);
    expect(a.grossLoss).toBe(0);
    expect(a.profitFactor).toBe(null);
  });
  it("treats a breakeven trade as neither win nor loss and resets streaks", () => {
    const a = computeAnalytics([
      trade(1, [2026, 6, 1, 10, 0], [2026, 6, 1, 10, 5], -5),
      trade(2, [2026, 6, 1, 11, 0], [2026, 6, 1, 11, 5], 0),
      trade(3, [2026, 6, 1, 12, 0], [2026, 6, 1, 12, 5], 10),
    ], []);
    expect(a.winRate).toBe(33.3); // 1 win of 3 (breakeven is not a win)
    expect(a.longestWinStreak).toBe(1);
    expect(a.longestLossStreak).toBe(1);
    expect(a.currentStreak).toEqual({ dir: "win", len: 1 });
  });
  it("leaves currentBalance and roiPct null without balance ops", () => {
    const a = computeAnalytics([trade(1, [2026, 6, 1, 10, 0], [2026, 6, 1, 10, 5], 10)], []);
    expect(a.currentBalance).toBe(null);
    expect(a.roiPct).toBe(null);
  });
  it("flags lot escalation when volume grows mid tilt-streak", () => {
    const a = computeAnalytics([
      trade(1, [2026, 6, 1, 10, 0], [2026, 6, 1, 10, 1], -5, { volume: 0.1 }),
      trade(2, [2026, 6, 1, 10, 2], [2026, 6, 1, 10, 3], -5, { volume: 0.2 }),
      trade(3, [2026, 6, 1, 10, 4], [2026, 6, 1, 10, 5], -5, { volume: 0.3 }),
    ], []);
    expect(a.tiltClusters).toHaveLength(1);
    expect(a.tiltClusters[0]).toMatchObject({ count: 3, lotEscalation: true });
  });
});
