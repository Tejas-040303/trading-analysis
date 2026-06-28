import { describe, it, expect } from "vitest";
import {
  detectSwings, detectStructure, biasAtBar,
  detectFVGs, activeFVGsAtBar, detectLiquiditySweeps,
  detectOrderBlocks, activeOBsAtBar,
  computeS1Verdict, sessionAtTime,
  precomputeSmcState, scanSetups, findBarAtTime,
} from "./smc.js";

// Build a candle from O/H/L/C (time/volume don't matter for geometry tests).
const k = (open, high, low, close, tickVolume = 100) => ({
  time: new Date(2026, 0, 1, 0, 0, 0).toISOString(), open, high, low, close, tickVolume,
});

describe("detectSwings", () => {
  it("finds a single swing high at the peak, confirmed `lookback` bars later", () => {
    // tent shape on highs; lows mirror so they never form a trough
    const highs = [1, 2, 3, 4, 5, 4, 3, 2, 1];
    const candles = highs.map((h) => k(h, h, h, h));
    const swings = detectSwings(candles, 2);
    const highsFound = swings.filter((s) => s.type === "high");
    expect(highsFound).toHaveLength(1);
    expect(highsFound[0]).toMatchObject({ index: 4, price: 5, confirmedAt: 6 });
  });

  it("finds a single swing low at the trough", () => {
    const lows = [5, 4, 3, 2, 1, 2, 3, 4, 5];
    const candles = lows.map((l) => k(l, l, l, l));
    const swings = detectSwings(candles, 2);
    const lowsFound = swings.filter((s) => s.type === "low");
    expect(lowsFound).toHaveLength(1);
    expect(lowsFound[0]).toMatchObject({ index: 4, price: 1, confirmedAt: 6 });
  });
});

describe("detectStructure + biasAtBar", () => {
  // detectStructure only reads the swings array (not candles), so we can feed
  // hand-built swings for a fully deterministic structure sequence.
  const swings = [
    { type: "high", index: 2, price: 10, confirmedAt: 4 },
    { type: "high", index: 6, price: 12, confirmedAt: 8 },  // 12 > 10 -> bullish BOS
    { type: "low", index: 10, price: 5, confirmedAt: 12 },
    { type: "low", index: 14, price: 3, confirmedAt: 16 },  // 3 < 5 while bullish -> bearish CHoCH
  ];

  it("emits a bullish BOS then a bearish CHoCH", () => {
    const events = detectStructure([], swings);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "BOS", direction: "bullish", confirmedAt: 8 });
    expect(events[1]).toMatchObject({ type: "CHoCH", direction: "bearish", confirmedAt: 16 });
  });

  it("biasAtBar is causal — only events confirmed at/before the bar count", () => {
    const events = detectStructure([], swings);
    expect(biasAtBar(events, 7).bias).toBe(null);      // before the BOS confirms
    expect(biasAtBar(events, 8).bias).toBe("bullish"); // BOS just confirmed
    expect(biasAtBar(events, 15).bias).toBe("bullish");// before the CHoCH confirms
    expect(biasAtBar(events, 16).bias).toBe("bearish");// CHoCH confirmed
  });
});

describe("detectFVGs", () => {
  it("detects a bullish gap, records the zone, and marks it filled", () => {
    const candles = [
      k(9, 10, 9, 10),    // c1 — high 10
      k(11, 12, 11, 12),  // c2
      k(13, 15, 13, 15),  // c3 — low 13 > c1.high 10 => bullish FVG (zone 10..13)
      k(11, 11, 9, 9),    // low 9 <= 10 => fills the gap
    ];
    const fvgs = detectFVGs(candles);
    expect(fvgs).toHaveLength(1);
    expect(fvgs[0]).toMatchObject({ direction: "bullish", low: 10, high: 13, formIndex: 2, filledAt: 3 });
  });

  it("activeFVGsAtBar excludes an FVG once it's filled (causal)", () => {
    const candles = [
      k(9, 10, 9, 10), k(11, 12, 11, 12), k(13, 15, 13, 15), k(11, 11, 9, 9),
    ];
    const fvgs = detectFVGs(candles);
    expect(activeFVGsAtBar(fvgs, 2, "bullish")).toHaveLength(1); // active at formation
    expect(activeFVGsAtBar(fvgs, 3, "bullish")).toHaveLength(0); // filled at bar 3
  });
});

describe("detectLiquiditySweeps", () => {
  it("flags a bullish sweep: wick pierces below a swing low but closes above it", () => {
    const swings = [{ type: "low", index: 3, price: 100, confirmedAt: 5 }];
    const candles = [];
    for (let i = 0; i < 6; i++) candles.push(k(101, 102, 100.5, 101)); // benign
    candles.push(k(101, 102, 98, 101)); // index 6: low 98 < 100, close 101 > 100 => sweep
    const sweeps = detectLiquiditySweeps(candles, swings);
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0]).toMatchObject({ type: "bullish", barIndex: 6, swingPrice: 100 });
    expect(sweeps[0].wickDepth).toBeCloseTo(2, 5);
  });
});

describe("detectOrderBlocks + activeOBsAtBar", () => {
  it("finds the last bearish candle before a bullish BOS and mitigates it when price closes below", () => {
    // index 3 is the bearish OB; bullish impulse; BOS swingIndex 5; later close below OB.low mitigates
    const candles = [
      k(10, 11, 9, 10),   // 0
      k(10, 11, 9, 10),   // 1
      k(10, 11, 9, 10),   // 2
      k(10, 10.5, 8, 8.5),// 3 bearish (close<open) -> the OB, low 8
      k(8.5, 12, 8.5, 11),// 4 bullish impulse
      k(11, 14, 11, 13),  // 5 BOS swing high
      k(13, 13.5, 12, 12.5),
      k(12.5, 13, 7, 7.5),// 7 closes 7.5 < OB.low(8) -> mitigates
    ];
    const events = [{ type: "BOS", direction: "bullish", confirmedAt: 6, swingIndex: 5, price: 14 }];
    const obs = detectOrderBlocks(candles, events);
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ direction: "bullish", formIndex: 3, low: 8, mitigatedAt: 7 });
    // active before mitigation, inactive after
    expect(activeOBsAtBar(obs, 6, "bullish")).toHaveLength(1);
    expect(activeOBsAtBar(obs, 7, "bullish")).toHaveLength(0);
  });
});

describe("computeS1Verdict", () => {
  it("returns 'insufficient' when there aren't enough bars before entry", () => {
    const candles = [k(1, 1, 1, 1), k(1, 1, 1, 1)];
    const v = computeS1Verdict(candles, { openTime: candles[1].time, type: "buy" }, 5);
    expect(v.verdict).toBe("insufficient");
  });

  it("returns 'no-structure' on flat candles (no swings -> no bias)", () => {
    const candles = Array.from({ length: 30 }, () => k(100, 100, 100, 100));
    const v = computeS1Verdict(candles, { openTime: candles[29].time, type: "buy" }, 5);
    expect(v.verdict).toBe("no-structure");
  });
});

describe("sessionAtTime", () => {
  it("buckets by GMT hour using the broker offset", () => {
    const at10local = new Date(2026, 0, 1, 10, 0, 0); // local hour 10
    expect(sessionAtTime(at10local, 0)).toBe("London");  // 10 GMT
    expect(sessionAtTime(at10local, 3)).toBe("Asian");   // 10-3 = 7 GMT
    expect(sessionAtTime(at10local, -5)).toBe("New York");// 15 GMT
  });
  it("returns null when no offset is configured", () => {
    expect(sessionAtTime(new Date(), null)).toBe(null);
  });
});

describe("findBarAtTime", () => {
  // Distinct ascending timestamps (5 min apart) — the production case where the
  // binary search must return the rightmost bar with time <= the query.
  const base = Date.parse("2026-01-01T00:00:00Z");
  const candles = Array.from({ length: 10 }, (_, i) => ({
    ...k(1, 1, 1, 1),
    time: new Date(base + i * 300000).toISOString(),
  }));
  const at = (i, offsetMs = 0) => new Date(base + i * 300000 + offsetMs).toISOString();

  it("returns -1 when the query is before the first bar", () => {
    expect(findBarAtTime(candles, at(0, -1))).toBe(-1);
  });
  it("returns the exact bar when the query equals a bar time", () => {
    expect(findBarAtTime(candles, at(4))).toBe(4);
  });
  it("returns the earlier bar when the query falls between two bars", () => {
    expect(findBarAtTime(candles, at(4, 60000))).toBe(4);
  });
  it("returns the last bar when the query is after the final bar", () => {
    expect(findBarAtTime(candles, at(9, 999999))).toBe(9);
  });
  it("returns -1 for an empty candle array", () => {
    expect(findBarAtTime([], at(0))).toBe(-1);
  });
});

describe("scanSetups invariants", () => {
  // Deterministic oscillating series -> repeated structure flips, OBs/FVGs/sweeps.
  function series(n) {
    const candles = [];
    let price = 100;
    for (let i = 0; i < n; i++) {
      const drift = Math.sin(i * 0.02) * 0.8;
      const noise = Math.sin(i * 0.7) * 0.9 + Math.cos(i * 0.31) * 0.6;
      const o = price, c = price + drift + noise;
      const h = Math.max(o, c) + Math.abs(noise) * 0.7 + 0.3;
      const l = Math.min(o, c) - Math.abs(noise) * 0.7 - 0.3;
      candles.push(k(o, h, l, c));
      price = c;
    }
    return candles;
  }

  it("emits setups that respect threshold, cooldown, and have finite R, no look-ahead crashes", () => {
    const candles = series(1000);
    const smc = precomputeSmcState(candles, 5);
    const setups = scanSetups(candles, smc, { swingLookback: 5, minScore: 3, cooldown: 12 });
    expect(setups.length).toBeGreaterThan(0);

    // every setup meets the minimum confluence
    expect(setups.every((s) => s.score >= 3)).toBe(true);
    // R values are either null or finite (never NaN/Infinity)
    expect(setups.every((s) => s.mfeR == null || Number.isFinite(s.mfeR))).toBe(true);
    expect(setups.every((s) => s.maeR == null || Number.isFinite(s.maeR))).toBe(true);
    // bar indices are within range
    expect(setups.every((s) => s.barIndex >= 0 && s.barIndex < candles.length)).toBe(true);
    // cooldown respected per direction
    for (const dir of ["bullish", "bearish"]) {
      const idx = setups.filter((s) => s.direction === dir).map((s) => s.barIndex);
      for (let i = 1; i < idx.length; i++) expect(idx[i] - idx[i - 1]).toBeGreaterThanOrEqual(12);
    }
  });
});
