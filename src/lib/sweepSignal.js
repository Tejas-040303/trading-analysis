// P8.4a — pure logic for the Liquidity Sweep pilot strategy (bot #1).
// Spec agreed with TJ 2026-07-06:
//   detect:   on M15/M30/H1/H4, a wick takes prior swing liquidity and the
//             candle closes back inside (existing smc.js detector) → "forming"
//   confirm:  an engulfing candle on M1 OR M3 (whichever prints first) in the
//             reversal direction → "confirmed", entry = engulf close
//   invalid:  a candle on the sweep's TF CLOSES beyond the swept level again
//             before confirmation ("until the level re-breaks")
//   plan:     SL at the sweep wick extreme (warn if > 60 pips, still sent);
//             ladder 1:1 → BE, 1:1.5 → trail +0.3R, 1:2 → trail +1R,
//             runner max 300 pips; GOLD pip = $0.10.
//
// Pure module: no I/O, shared verbatim with the ingest edge function via
// `npm run sync:functions`. All candle times must be strict Date.toISOString()
// strings (the caller normalizes) so plain string comparison orders them.
import { detectSwings, detectLiquiditySweeps } from "./sweeps.js";

export const SWEEP_DEFAULTS = {
  pip: 0.1,          // GOLD: 1 pip = $0.10 of price
  slWarnPips: 60,    // TJ's cap — beyond this the alert carries a ⚠️, not a skip
  maxTpPips: 300,
  swingLookback: 5,
  trailPips: 50,     // runner trail (used by trade tracking in P8.4b)
};

export const SWEEP_TFS = ["M15", "M30", "H1", "H4"];
export const CONFIRM_TFS = ["M1", "M3"];

export function addMinutesIso(iso, minutes) {
  return new Date(Date.parse(iso) + minutes * 60000).toISOString();
}

// The freshest bar time across all series ≈ "now" on the MT5 server clock.
// Derived from the data itself so the engine never needs a wall clock (the
// DB stores server wall-clock as UTC, which is offset from true UTC).
export function serverNowFromSeries(seriesList) {
  let max = null;
  for (const candles of seriesList) {
    const last = candles && candles.length ? candles[candles.length - 1].time : null;
    if (last && (!max || last > max)) max = last;
  }
  return max;
}

// Drop the still-forming final bar: a bar is closed once serverNow has moved
// past barTime + timeframe.
export function closedBars(candles, tfMinutes, serverNow) {
  if (!candles || !candles.length || !serverNow) return candles || [];
  const last = candles[candles.length - 1];
  return addMinutesIso(last.time, tfMinutes) <= serverNow ? candles : candles.slice(0, -1);
}

// New sweep seeds on the most recent `recentBars` CLOSED bars of one series.
// direction follows smc.js: "bullish" = liquidity grabbed below → expect up.
export function findNewSweeps(candles, timeframe, opts = {}) {
  const lookback = opts.swingLookback || SWEEP_DEFAULTS.swingLookback;
  const recentBars = opts.recentBars || 3;
  if (!candles || candles.length < lookback * 2 + 2) return [];
  const swings = detectSwings(candles, lookback);
  const sweeps = detectLiquiditySweeps(candles, swings);
  const cutoffIndex = candles.length - recentBars;
  return sweeps
    .filter((s) => s.barIndex >= cutoffIndex)
    .map((s) => {
      const bar = candles[s.barIndex];
      return {
        timeframe,
        direction: s.type, // "bullish" | "bearish"
        barTime: bar.time,
        sweptLevel: s.swingPrice,
        sweepExtreme: s.type === "bullish" ? bar.low : bar.high,
      };
    });
}

// First engulfing candle in `direction` strictly after `sinceTime`, scanning
// any number of confirmation series (M1, M3, …); earliest wins.
export function detectConfirmation(seriesByTf, direction, sinceTime) {
  let best = null;
  for (const [timeframe, candles] of Object.entries(seriesByTf)) {
    if (!candles) continue;
    for (let i = 1; i < candles.length; i++) {
      const prev = candles[i - 1];
      const cur = candles[i];
      if (cur.time <= sinceTime) continue;
      const engulf =
        direction === "bullish"
          ? prev.close < prev.open && cur.close > cur.open &&
            cur.close >= prev.open && cur.open <= prev.close
          : prev.close > prev.open && cur.close < cur.open &&
            cur.close <= prev.open && cur.open >= prev.close;
      if (engulf && (!best || cur.time < best.time)) {
        best = { time: cur.time, close: cur.close, timeframe };
        break; // earliest in this series found; try the next series
      }
    }
  }
  return best;
}

// Invalidation: a close beyond the swept level in the sweep's own direction
// of origin (bullish sweep = swept a low → a later CLOSE below that low kills
// the reversal idea).
export function levelRebroken(candles, direction, sweptLevel, sinceTime) {
  for (const c of candles || []) {
    if (c.time <= sinceTime) continue;
    if (direction === "bullish" ? c.close < sweptLevel : c.close > sweptLevel) return true;
  }
  return false;
}

const r2 = (x) => Math.round(x * 100) / 100;

// TJ's management ladder, computed off the actual entry/SL distance (R).
export function buildPlan(direction, entry, sweepExtreme, opts = {}) {
  const pip = opts.pip || SWEEP_DEFAULTS.pip;
  const slWarnPips = opts.slWarnPips || SWEEP_DEFAULTS.slWarnPips;
  const maxTpPips = opts.maxTpPips || SWEEP_DEFAULTS.maxTpPips;
  const up = direction === "bullish" ? 1 : -1;
  const sl = sweepExtreme;
  const r = Math.abs(entry - sl);
  if (!(r > 0)) return null; // degenerate: entry at/inside the wick extreme
  const slPips = r / pip;
  const cap = maxTpPips * pip;
  return {
    entry: r2(entry),
    sl: r2(sl),
    r: r2(r),
    slPips: Math.round(slPips),
    slWarning: slPips > slWarnPips,
    tp1: r2(entry + up * Math.min(r, cap)),
    tp15: r2(entry + up * Math.min(1.5 * r, cap)),
    tp2: r2(entry + up * Math.min(2 * r, cap)),
    maxTp: r2(entry + up * cap),
  };
}

// One engine pass. Inputs:
//   sweepSeries: { M15: [...], M30: [...], H1: [...], H4: [...] }  (closed-bar
//     trimming is done here), confirmSeries: { M1: [...], M3: [...] },
//   openSignals: rows currently 'forming' — [{ id, timeframe, direction,
//     barTime, sweptLevel, sweepExtreme }], existingKeys: Set of
//     `${timeframe}|${direction}|${barTime}` already stored (any status).
// Returns actions for the caller to persist/notify:
//   { create: [seed…], confirm: [{ signal, confirmation, plan }…],
//     invalidate: [signal…] }
export function runSweepEngine({ sweepSeries, confirmSeries, openSignals = [], existingKeys = new Set(), opts = {} }) {
  const tfMinutes = { M1: 1, M3: 3, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240 };
  const allSeries = [...Object.values(sweepSeries || {}), ...Object.values(confirmSeries || {})];
  const serverNow = serverNowFromSeries(allSeries);

  const closedSweep = {};
  for (const [tf, candles] of Object.entries(sweepSeries || {})) {
    closedSweep[tf] = closedBars(candles, tfMinutes[tf] || 60, serverNow);
  }
  const closedConfirm = {};
  for (const [tf, candles] of Object.entries(confirmSeries || {})) {
    closedConfirm[tf] = closedBars(candles, tfMinutes[tf] || 1, serverNow);
  }

  const create = [];
  for (const tf of Object.keys(closedSweep)) {
    for (const seed of findNewSweeps(closedSweep[tf], tf, opts)) {
      const key = `${seed.timeframe}|${seed.direction}|${seed.barTime}`;
      if (!existingKeys.has(key)) create.push(seed);
    }
  }

  const confirm = [];
  const invalidate = [];
  for (const sig of openSignals) {
    const own = closedSweep[sig.timeframe] || [];
    if (levelRebroken(own, sig.direction, sig.sweptLevel, sig.barTime)) {
      invalidate.push(sig);
      continue;
    }
    const confirmation = detectConfirmation(closedConfirm, sig.direction, sig.barTime);
    if (confirmation) {
      const plan = buildPlan(sig.direction, confirmation.close, sig.sweepExtreme, opts);
      if (plan) confirm.push({ signal: sig, confirmation, plan });
      else invalidate.push(sig); // entry landed at/beyond the wick — no valid R
    }
  }
  return { create, confirm, invalidate, serverNow };
}
