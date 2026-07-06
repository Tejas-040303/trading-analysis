import { describe, it, expect } from "vitest";
import {
  addMinutesIso, serverNowFromSeries, closedBars,
  findNewSweeps, detectConfirmation, levelRebroken, buildPlan, runSweepEngine,
} from "./sweepSignal.js";

// 15-minute grid starting 2026-07-06T10:00Z (times only need to be ordered
// toISOString strings for the engine).
const iso15 = (i) => new Date(Date.UTC(2026, 6, 6, 10, i * 15)).toISOString();
const isoMin = (m) => new Date(Date.UTC(2026, 6, 6, 10, m)).toISOString();
const bar = (time, open, high, low, close) => ({ time, open, high, low, close, tickVolume: 1 });

// A clean V with a confirmed swing low at 100 (index 3, lookback 2), then a
// bullish sweep at index 8: wick to 99.5 below the swing, close back at 100.9.
function sweepSeries15() {
  return [
    bar(iso15(0), 102.0, 103.0, 101.9, 102.5),
    bar(iso15(1), 102.5, 102.6, 101.4, 101.5),
    bar(iso15(2), 101.5, 101.6, 100.9, 101.0),
    bar(iso15(3), 101.0, 101.1, 100.0, 100.5), // swing low 100.0
    bar(iso15(4), 100.5, 101.2, 100.4, 101.0),
    bar(iso15(5), 101.0, 101.7, 100.9, 101.5),
    bar(iso15(6), 101.5, 102.1, 101.4, 102.0),
    bar(iso15(7), 102.0, 102.1, 101.5, 101.8),
    bar(iso15(8), 101.8, 101.9, 99.5, 100.9),  // sweep: wick 99.5 < 100, close 100.9 > 100
    bar(iso15(9), 100.9, 101.3, 100.6, 101.1),
    bar(iso15(10), 101.1, 101.4, 100.8, 101.2),
  ];
}

describe("time helpers", () => {
  it("addMinutesIso adds minutes", () => {
    expect(addMinutesIso(iso15(0), 15)).toBe(iso15(1));
  });
  it("serverNowFromSeries takes the freshest last bar", () => {
    expect(serverNowFromSeries([sweepSeries15(), [bar(isoMin(200), 1, 1, 1, 1)]])).toBe(isoMin(200));
  });
  it("closedBars drops a still-forming final bar and keeps a closed one", () => {
    const s = sweepSeries15();
    // serverNow just 1 min after the last bar opened → forming → dropped
    expect(closedBars(s, 15, addMinutesIso(iso15(10), 1))).toHaveLength(10);
    // serverNow at bar close → closed → kept
    expect(closedBars(s, 15, addMinutesIso(iso15(10), 15))).toHaveLength(11);
  });
});

describe("findNewSweeps", () => {
  it("finds the bullish sweep with level and wick extreme", () => {
    const seeds = findNewSweeps(sweepSeries15(), "M15", { swingLookback: 2, recentBars: 3 });
    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toMatchObject({
      timeframe: "M15",
      direction: "bullish",
      barTime: iso15(8),
      sweptLevel: 100.0,
      sweepExtreme: 99.5,
    });
  });
  it("ignores sweeps outside the recent-bars window", () => {
    const seeds = findNewSweeps(sweepSeries15(), "M15", { swingLookback: 2, recentBars: 2 });
    expect(seeds).toHaveLength(0); // sweep is at index 8 of 11 → older than last 2 bars
  });
});

describe("detectConfirmation", () => {
  const since = iso15(8);
  it("finds a bullish engulf after the sweep and reports its TF", () => {
    const m1 = [
      bar(isoMin(121), 100.9, 101.0, 100.6, 100.7), // bearish
      bar(isoMin(122), 100.65, 101.2, 100.6, 101.1), // engulfs it, bullish
    ];
    const hit = detectConfirmation({ M1: m1, M3: [] }, "bullish", since);
    expect(hit).toMatchObject({ time: isoMin(122), close: 101.1, timeframe: "M1" });
  });
  it("returns null when nothing engulfs or it's before the sweep", () => {
    const m1 = [
      bar(isoMin(121), 100.9, 101.0, 100.6, 100.7),
      bar(isoMin(122), 100.7, 100.8, 100.4, 100.5), // still bearish
    ];
    expect(detectConfirmation({ M1: m1 }, "bullish", since)).toBeNull();
    const early = [
      bar(isoMin(1), 100.9, 101.0, 100.6, 100.7),
      bar(isoMin(2), 100.65, 101.2, 100.6, 101.1),
    ];
    expect(detectConfirmation({ M1: early }, "bullish", since)).toBeNull();
  });
  it("takes the earliest across M1 and M3", () => {
    const m1 = [bar(isoMin(130), 101.0, 101.1, 100.7, 100.8), bar(isoMin(131), 100.75, 101.3, 100.7, 101.2)];
    const m3 = [bar(isoMin(123), 101.0, 101.1, 100.7, 100.8), bar(isoMin(126), 100.75, 101.3, 100.7, 101.2)];
    const hit = detectConfirmation({ M1: m1, M3: m3 }, "bullish", since);
    expect(hit.timeframe).toBe("M3");
    expect(hit.time).toBe(isoMin(126));
  });
});

describe("levelRebroken", () => {
  it("bullish sweep dies when a later bar closes below the swept low", () => {
    const after = [bar(iso15(9), 100.4, 100.5, 99.4, 99.8)];
    expect(levelRebroken(after, "bullish", 100.0, iso15(8))).toBe(true);
  });
  it("wick below without a close below does not invalidate", () => {
    const after = [bar(iso15(9), 100.4, 100.6, 99.7, 100.3)];
    expect(levelRebroken(after, "bullish", 100.0, iso15(8))).toBe(false);
  });
  it("bearish mirror: close above the swept high invalidates", () => {
    const after = [bar(iso15(9), 103.0, 103.6, 102.9, 103.5)];
    expect(levelRebroken(after, "bearish", 103.2, iso15(8))).toBe(true);
  });
});

describe("buildPlan", () => {
  it("computes TJ's ladder for a long", () => {
    const p = buildPlan("bullish", 101.1, 99.5, {});
    expect(p).toMatchObject({ entry: 101.1, sl: 99.5, slPips: 16, slWarning: false });
    expect(p.tp1).toBe(102.7);   // +1R
    expect(p.tp15).toBe(103.5);  // +1.5R
    expect(p.tp2).toBe(104.3);   // +2R
    expect(p.maxTp).toBe(131.1); // +300 pips
  });
  it("flags (not skips) an SL wider than 60 pips", () => {
    const p = buildPlan("bullish", 106.0, 99.5, {});
    expect(p.slPips).toBe(65);
    expect(p.slWarning).toBe(true);
  });
  it("mirror math for a short and caps the ladder at max TP", () => {
    const p = buildPlan("bearish", 100.0, 120.0, {}); // r = 20.0 = 200 pips
    expect(p.sl).toBe(120.0);
    expect(p.tp1).toBe(80.0);
    expect(p.tp15).toBe(70.0);  // 1.5R = 300 pips = exactly the cap
    expect(p.tp2).toBe(70.0);   // 2R would exceed the 300-pip cap → clamped
    expect(p.maxTp).toBe(70.0);
  });
  it("rejects a degenerate entry at the wick", () => {
    expect(buildPlan("bullish", 99.5, 99.5, {})).toBeNull();
  });
});

describe("runSweepEngine", () => {
  const farFuture = [bar(isoMin(600), 101, 101, 101, 101)]; // pushes serverNow forward
  it("creates a seed for a fresh sweep and dedupes existing ones", () => {
    const out = runSweepEngine({
      sweepSeries: { M15: sweepSeries15() },
      confirmSeries: { M1: farFuture },
      opts: { swingLookback: 2, recentBars: 3 },
    });
    expect(out.create).toHaveLength(1);
    expect(out.create[0].barTime).toBe(iso15(8));

    const key = `M15|bullish|${iso15(8)}`;
    const deduped = runSweepEngine({
      sweepSeries: { M15: sweepSeries15() },
      confirmSeries: { M1: farFuture },
      existingKeys: new Set([key]),
      opts: { swingLookback: 2, recentBars: 3 },
    });
    expect(deduped.create).toHaveLength(0);
  });
  it("confirms a forming signal via M1 engulf with a full plan", () => {
    // Sweep bar OPENS at iso15(8) = 12:00 and closes 12:15 — the engulf must
    // print after the CLOSE to count (12:16/12:17 here).
    const m1 = [
      bar(isoMin(136), 100.9, 101.0, 100.6, 100.7),
      bar(isoMin(137), 100.65, 101.2, 100.6, 101.1),
      ...farFuture,
    ];
    const sig = { id: "s1", timeframe: "M15", direction: "bullish", barTime: iso15(8), sweptLevel: 100.0, sweepExtreme: 99.5 };
    const out = runSweepEngine({
      sweepSeries: { M15: sweepSeries15() },
      confirmSeries: { M1: m1 },
      openSignals: [sig],
      existingKeys: new Set([`M15|bullish|${iso15(8)}`]),
      opts: { swingLookback: 2, recentBars: 3 },
    });
    expect(out.confirm).toHaveLength(1);
    expect(out.confirm[0].confirmation.timeframe).toBe("M1");
    expect(out.confirm[0].plan.entry).toBe(101.1);
    expect(out.invalidate).toHaveLength(0);
  });
  it("ignores an engulf that printed before the sweep bar closed", () => {
    // Engulf at 12:01–12:02, inside the sweep bar's own 12:00–12:15 window —
    // exactly the stale-entry bug seen live on 2026-07-06: must NOT confirm.
    const m1 = [
      bar(isoMin(121), 100.9, 101.0, 100.6, 100.7),
      bar(isoMin(122), 100.65, 101.2, 100.6, 101.1),
      ...farFuture,
    ];
    const sig = { id: "s1", timeframe: "M15", direction: "bullish", barTime: iso15(8), sweptLevel: 100.0, sweepExtreme: 99.5 };
    const out = runSweepEngine({
      sweepSeries: { M15: sweepSeries15() },
      confirmSeries: { M1: m1 },
      openSignals: [sig],
      existingKeys: new Set([`M15|bullish|${iso15(8)}`]),
      opts: { swingLookback: 2, recentBars: 3 },
    });
    expect(out.confirm).toHaveLength(0);
    expect(out.invalidate).toHaveLength(0); // still forming, waiting for a real confirmation
  });
  it("invalidates a forming signal when the level re-breaks", () => {
    const series = [...sweepSeries15(), bar(iso15(11), 100.4, 100.5, 99.3, 99.7)];
    const sig = { id: "s1", timeframe: "M15", direction: "bullish", barTime: iso15(8), sweptLevel: 100.0, sweepExtreme: 99.5 };
    const out = runSweepEngine({
      sweepSeries: { M15: series },
      confirmSeries: { M1: farFuture },
      openSignals: [sig],
      existingKeys: new Set([`M15|bullish|${iso15(8)}`]),
      opts: { swingLookback: 2, recentBars: 3 },
    });
    expect(out.invalidate.map((s) => s.id)).toEqual(["s1"]);
    expect(out.confirm).toHaveLength(0);
  });
});
