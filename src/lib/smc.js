// SMC/ICT structure detection engine — causal forward pass only.
// Bar i only sees bars ≤ i. No repainting, no look-ahead.
//
// Strategy checks built here:
//   S1: Market Structure Bias (BOS/CHoCH)
//   S2: Order Block Confluence
//   S3: Fair Value Gap Confluence
//   S4: Liquidity Sweep
//   S5: Volume Profile              (future)
//   S6: Session Context             (no candles needed)

// ── Swing detection ─────────────────────────────────────────────────────
// Fractal pivot: a swing high at bar i is confirmed when we've seen `lookback`
// bars on each side with lower highs. Same logic inverted for swing lows.
// Confirmation happens at bar i + lookback (the bar that completes the right side).

export function detectSwings(candles, lookback = 5) {
  const swings = []; // { type: "high"|"low", index, price, confirmedAt }

  for (let i = lookback; i < candles.length - lookback; i++) {
    const confirmAt = i + lookback;
    if (confirmAt >= candles.length) break;

    // Swing high check
    let isHigh = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j].high >= candles[i].high || candles[i + j].high >= candles[i].high) {
        isHigh = false;
        break;
      }
    }
    if (isHigh) {
      swings.push({ type: "high", index: i, price: candles[i].high, confirmedAt: confirmAt });
    }

    // Swing low check
    let isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j].low <= candles[i].low || candles[i + j].low <= candles[i].low) {
        isLow = false;
        break;
      }
    }
    if (isLow) {
      swings.push({ type: "low", index: i, price: candles[i].low, confirmedAt: confirmAt });
    }
  }

  return swings.sort((a, b) => a.confirmedAt - b.confirmedAt || a.index - b.index);
}

// ── S1: Market Structure — BOS / CHoCH ──────────────────────────────────
// Walk confirmed swings in order. Track the last confirmed swing high and low.
// A Break of Structure (BOS) occurs when price breaks past the last swing
// in the direction of the current trend (continuation).
// A Change of Character (CHoCH) occurs when price breaks past the last swing
// AGAINST the current trend (reversal signal).
//
// Returns an array of structure events, each tagged with the bar index where
// the break was confirmed, so we can query "what was the bias at bar N?"

export function detectStructure(candles, swings) {
  const events = []; // { type: "BOS"|"CHoCH", direction: "bullish"|"bearish", confirmedAt, swingIndex, price }
  let bias = null; // "bullish" | "bearish" | null
  let lastSwingHigh = null; // { price, index, confirmedAt }
  let lastSwingLow = null;

  for (const sw of swings) {
    if (sw.type === "high") {
      // Check if price broke above the previous swing high
      if (lastSwingHigh && sw.price > lastSwingHigh.price) {
        if (bias === "bullish" || bias === null) {
          events.push({
            type: "BOS",
            direction: "bullish",
            confirmedAt: sw.confirmedAt,
            swingIndex: sw.index,
            price: sw.price,
          });
          bias = "bullish";
        } else {
          events.push({
            type: "CHoCH",
            direction: "bullish",
            confirmedAt: sw.confirmedAt,
            swingIndex: sw.index,
            price: sw.price,
          });
          bias = "bullish";
        }
      }
      lastSwingHigh = { price: sw.price, index: sw.index, confirmedAt: sw.confirmedAt };
    }

    if (sw.type === "low") {
      // Check if price broke below the previous swing low
      if (lastSwingLow && sw.price < lastSwingLow.price) {
        if (bias === "bearish" || bias === null) {
          events.push({
            type: "BOS",
            direction: "bearish",
            confirmedAt: sw.confirmedAt,
            swingIndex: sw.index,
            price: sw.price,
          });
          bias = "bearish";
        } else {
          events.push({
            type: "CHoCH",
            direction: "bearish",
            confirmedAt: sw.confirmedAt,
            swingIndex: sw.index,
            price: sw.price,
          });
          bias = "bearish";
        }
      }
      lastSwingLow = { price: sw.price, index: sw.index, confirmedAt: sw.confirmedAt };
    }
  }

  return events;
}

// Query the active bias at a given bar index (causal — only uses events
// confirmed at or before that bar).
export function biasAtBar(structureEvents, barIndex) {
  let bias = null;
  let lastEvent = null;
  for (const ev of structureEvents) {
    if (ev.confirmedAt > barIndex) break;
    bias = ev.direction;
    lastEvent = ev;
  }
  return { bias, lastEvent };
}

// ── S2: Order Block detection ────────────────────────────────────────────
// An Order Block is the last opposing-color candle immediately before the
// impulsive move that produced a BOS/CHoCH. For a bullish BOS, the OB is the
// last bearish candle in the base before the rally; for bearish, the last
// bullish candle before the drop.
//
// An OB stays "active" until price trades fully through it (mitigated).
// Mitigation = a candle's body closes past the OB zone in the opposing direction.

function isBearishCandle(c) { return c.close < c.open; }
function isBullishCandle(c) { return c.close > c.open; }

export function detectOrderBlocks(candles, structureEvents) {
  const obs = []; // { direction, high, low, formIndex, confirmedAt, mitigatedAt }

  for (const ev of structureEvents) {
    const bosIdx = ev.swingIndex;
    if (bosIdx < 1) continue;

    if (ev.direction === "bullish") {
      // Find last bearish candle before the impulsive move
      for (let i = bosIdx - 1; i >= Math.max(0, bosIdx - 10); i--) {
        if (isBearishCandle(candles[i])) {
          obs.push({
            direction: "bullish",
            high: candles[i].high,
            low: candles[i].low,
            formIndex: i,
            confirmedAt: ev.confirmedAt,
            mitigatedAt: null,
          });
          break;
        }
      }
    } else {
      // Find last bullish candle before the impulsive move
      for (let i = bosIdx - 1; i >= Math.max(0, bosIdx - 10); i--) {
        if (isBullishCandle(candles[i])) {
          obs.push({
            direction: "bearish",
            high: candles[i].high,
            low: candles[i].low,
            formIndex: i,
            confirmedAt: ev.confirmedAt,
            mitigatedAt: null,
          });
          break;
        }
      }
    }
  }

  // Walk candles forward to mark mitigated OBs (causal: only check bars after confirmation)
  for (const ob of obs) {
    for (let i = ob.confirmedAt + 1; i < candles.length; i++) {
      if (ob.direction === "bullish" && candles[i].close < ob.low) {
        ob.mitigatedAt = i;
        break;
      }
      if (ob.direction === "bearish" && candles[i].close > ob.high) {
        ob.mitigatedAt = i;
        break;
      }
    }
  }

  return obs;
}

// Query active OBs at a given bar index in a given direction
export function activeOBsAtBar(orderBlocks, barIndex, direction) {
  return orderBlocks.filter((ob) =>
    ob.direction === direction &&
    ob.confirmedAt <= barIndex &&
    (ob.mitigatedAt === null || ob.mitigatedAt > barIndex)
  );
}

export function computeS2Verdict(candles, trade, structureEvents, orderBlocks, lookback) {
  const barIdx = findBarAtTime(candles, trade.openTime);
  if (barIdx < 0) return null;
  if (candles.slice(0, barIdx + 1).length < lookback * 2 + 1) {
    return { verdict: "insufficient", detail: "Not enough candle data for OB detection.", atOB: false };
  }

  const tradeDir = trade.type === "buy" ? "bullish" : "bearish";
  const entryPrice = typeof trade.openPrice === "number" ? trade.openPrice : parseFloat(trade.openPrice);
  if (!Number.isFinite(entryPrice)) {
    return { verdict: "insufficient", detail: "No entry price available.", atOB: false };
  }

  const activeOBs = activeOBsAtBar(orderBlocks, barIdx, tradeDir);

  if (activeOBs.length === 0) {
    return { verdict: "no-ob", detail: `No active ${tradeDir} order block at entry.`, atOB: false };
  }

  // Check if entry price is within or touching any active OB zone
  const touching = activeOBs.filter((ob) => entryPrice >= ob.low && entryPrice <= ob.high);

  if (touching.length > 0) {
    const ob = touching[0];
    const barsAgo = barIdx - ob.formIndex;
    return {
      verdict: "at-ob",
      detail: `Entry at an active ${tradeDir} order block (formed ${barsAgo} bars ago, zone ${ob.low.toFixed(2)}–${ob.high.toFixed(2)}).`,
      atOB: true,
      obZone: { high: ob.high, low: ob.low },
    };
  }

  // Find nearest OB for context
  const nearest = activeOBs.reduce((best, ob) => {
    const dist = tradeDir === "bullish"
      ? entryPrice - ob.high  // how far above the OB
      : ob.low - entryPrice;  // how far below the OB
    return (best === null || Math.abs(dist) < Math.abs(best.dist)) ? { ob, dist } : best;
  }, null);

  const distStr = nearest ? Math.abs(nearest.dist).toFixed(2) : "?";
  return {
    verdict: "near-ob",
    detail: `${activeOBs.length} active ${tradeDir} OB(s) nearby but entry was ${distStr} away from the nearest zone.`,
    atOB: false,
    nearestDist: nearest ? nearest.dist : null,
  };
}

// ── S3: Fair Value Gap detection ─────────────────────────────────────────
// A Fair Value Gap is a 3-candle imbalance where candle 1's wick doesn't
// overlap candle 3's wick, leaving a gap that price may return to fill.
//
// Bullish FVG: candle1.high < candle3.low (gap between candle 1 top and candle 3 bottom)
// Bearish FVG: candle1.low > candle3.high (gap between candle 3 top and candle 1 bottom)
//
// Size relative to a local ATR classifies: Strong (>1.5x ATR), Regular, Weak (<0.3x ATR)
// An FVG is "filled" when price trades through it.

export function detectFVGs(candles, atrPeriod = 14) {
  const fvgs = []; // { direction, high, low, formIndex, filledAt, strength }

  for (let i = 2; i < candles.length; i++) {
    const c1 = candles[i - 2];
    const c2 = candles[i - 1];
    const c3 = candles[i];

    // Bullish FVG: gap up — candle 1 high is below candle 3 low
    if (c1.high < c3.low) {
      const gapSize = c3.low - c1.high;
      const atr = localATR(candles, i, atrPeriod);
      fvgs.push({
        direction: "bullish",
        high: c3.low,   // top of the gap
        low: c1.high,   // bottom of the gap
        formIndex: i,
        filledAt: null,
        gapSize,
        strength: atr > 0 ? (gapSize > atr * 1.5 ? "strong" : gapSize < atr * 0.3 ? "weak" : "regular") : "regular",
      });
    }

    // Bearish FVG: gap down — candle 1 low is above candle 3 high
    if (c1.low > c3.high) {
      const gapSize = c1.low - c3.high;
      const atr = localATR(candles, i, atrPeriod);
      fvgs.push({
        direction: "bearish",
        high: c1.low,   // top of the gap
        low: c3.high,   // bottom of the gap
        formIndex: i,
        filledAt: null,
        gapSize,
        strength: atr > 0 ? (gapSize > atr * 1.5 ? "strong" : gapSize < atr * 0.3 ? "weak" : "regular") : "regular",
      });
    }
  }

  // Mark filled FVGs
  for (const fvg of fvgs) {
    for (let i = fvg.formIndex + 1; i < candles.length; i++) {
      if (fvg.direction === "bullish" && candles[i].low <= fvg.low) {
        fvg.filledAt = i;
        break;
      }
      if (fvg.direction === "bearish" && candles[i].high >= fvg.high) {
        fvg.filledAt = i;
        break;
      }
    }
  }

  return fvgs;
}

function localATR(candles, endIndex, period) {
  const start = Math.max(0, endIndex - period);
  let sum = 0, count = 0;
  for (let i = start; i <= endIndex && i < candles.length; i++) {
    sum += candles[i].high - candles[i].low;
    count++;
  }
  return count > 0 ? sum / count : 0;
}

export function computeS3Verdict(candles, trade, fvgs, lookback) {
  const barIdx = findBarAtTime(candles, trade.openTime);
  if (barIdx < 0) return null;
  if (candles.slice(0, barIdx + 1).length < lookback * 2 + 1) {
    return { verdict: "insufficient", detail: "Not enough candle data for FVG detection.", atFVG: false };
  }

  const tradeDir = trade.type === "buy" ? "bullish" : "bearish";
  const entryPrice = typeof trade.openPrice === "number" ? trade.openPrice : parseFloat(trade.openPrice);
  if (!Number.isFinite(entryPrice)) {
    return { verdict: "insufficient", detail: "No entry price available.", atFVG: false };
  }

  // Active FVGs: formed before entry, not yet filled at entry
  const active = fvgs.filter((f) =>
    f.direction === tradeDir &&
    f.formIndex <= barIdx &&
    (f.filledAt === null || f.filledAt > barIdx)
  );

  if (active.length === 0) {
    return { verdict: "no-fvg", detail: `No active ${tradeDir} FVG at entry.`, atFVG: false };
  }

  // Check if entry price is inside any active FVG
  const inside = active.filter((f) => entryPrice >= f.low && entryPrice <= f.high);

  if (inside.length > 0) {
    const best = inside.reduce((a, b) => (a.strength === "strong" ? a : b.strength === "strong" ? b : a));
    const barsAgo = barIdx - best.formIndex;
    return {
      verdict: "at-fvg",
      detail: `Entry inside a ${best.strength} ${tradeDir} FVG (formed ${barsAgo} bars ago, gap ${best.low.toFixed(2)}–${best.high.toFixed(2)}).`,
      atFVG: true,
      strength: best.strength,
      fvgZone: { high: best.high, low: best.low },
    };
  }

  return {
    verdict: "near-fvg",
    detail: `${active.length} active ${tradeDir} FVG(s) exist but entry price was outside them.`,
    atFVG: false,
  };
}

// ── S4: Liquidity Sweep detection ────────────────────────────────────────
// A liquidity sweep occurs when a candle's wick pierces a prior swing point
// but the body closes back inside it — a "stop hunt" that grabs liquidity
// sitting at the swing level before reversing.
//
// Bullish sweep: wick below a swing low, close above it → buyers grabbed stops
// Bearish sweep: wick above a swing high, close below it → sellers grabbed stops

export function detectLiquiditySweeps(candles, swings) {
  const sweeps = []; // { type: "bullish"|"bearish", barIndex, swingPrice, wickDepth }

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    // Check confirmed swings visible at bar i
    for (const sw of swings) {
      if (sw.confirmedAt > i) break;

      // Bullish sweep: wick dips below a swing low but closes above it
      if (sw.type === "low" && c.low < sw.price && c.close > sw.price) {
        sweeps.push({
          type: "bullish",
          barIndex: i,
          swingIndex: sw.index,
          swingPrice: sw.price,
          wickDepth: sw.price - c.low,
        });
      }

      // Bearish sweep: wick pierces above a swing high but closes below it
      if (sw.type === "high" && c.high > sw.price && c.close < sw.price) {
        sweeps.push({
          type: "bearish",
          barIndex: i,
          swingIndex: sw.index,
          swingPrice: sw.price,
          wickDepth: c.high - sw.price,
        });
      }
    }
  }

  return sweeps;
}

export function computeS4Verdict(candles, trade, sweeps, lookback) {
  const barIdx = findBarAtTime(candles, trade.openTime);
  if (barIdx < 0) return null;
  if (candles.slice(0, barIdx + 1).length < lookback * 2 + 1) {
    return { verdict: "insufficient", detail: "Not enough candle data for sweep detection.", swept: false };
  }

  const tradeDir = trade.type === "buy" ? "bullish" : "bearish";
  // Look for sweeps in the trade direction within the last N bars before entry
  const sweepWindow = 10;
  const recent = sweeps.filter((s) =>
    s.type === tradeDir &&
    s.barIndex <= barIdx &&
    s.barIndex >= barIdx - sweepWindow
  );

  if (recent.length === 0) {
    return {
      verdict: "no-sweep",
      detail: `No ${tradeDir} liquidity sweep in the ${sweepWindow} bars before entry.`,
      swept: false,
    };
  }

  const best = recent[recent.length - 1];
  const barsAgo = barIdx - best.barIndex;
  return {
    verdict: "swept",
    detail: `${tradeDir === "bullish" ? "Bullish" : "Bearish"} liquidity sweep ${barsAgo} bar${barsAgo !== 1 ? "s" : ""} before entry — wick grabbed below ${best.swingPrice.toFixed(2)} (depth: ${best.wickDepth.toFixed(2)}).`,
    swept: true,
    sweepBar: best.barIndex,
    swingPrice: best.swingPrice,
    barsAgo,
  };
}

// ── S6: Session Context ─────────────────────────────────────────────────
// Which trading session was the trade opened in? Uses broker GMT offset.
// No candles needed — just the trade's open time.

const SESSIONS = [
  { name: "Asian", lo: 0, hi: 8 },
  { name: "London", lo: 8, hi: 13 },
  { name: "New York", lo: 13, hi: 21 },
  { name: "Off-hours", lo: 21, hi: 24 },
];

export function sessionAtTime(openTime, brokerGmtOffsetHours) {
  if (brokerGmtOffsetHours == null) return null;
  const d = new Date(openTime);
  let gmtHour = (d.getHours() - brokerGmtOffsetHours) % 24;
  if (gmtHour < 0) gmtHour += 24;
  for (const s of SESSIONS) {
    if (gmtHour >= s.lo && gmtHour < s.hi) return s.name;
  }
  return "Off-hours";
}

// ── Trade verdict (S1 only for now) ─────────────────────────────────────
// Given candles for a symbol+timeframe and a trade, find the bar at entry time,
// replay structure up to that bar, and judge whether the trade aligned with
// the prevailing market structure.

export function findBarAtTime(candles, tradeOpenTime) {
  const t = new Date(tradeOpenTime).getTime();
  let best = -1;
  for (let i = 0; i < candles.length; i++) {
    const ct = new Date(candles[i].time).getTime();
    if (ct <= t) best = i;
    else break;
  }
  return best;
}

export function computeS1Verdict(candles, trade, lookback = 5) {
  const barIdx = findBarAtTime(candles, trade.openTime);
  if (barIdx < 0) return null;

  // Only use candles up to and including the entry bar (causal)
  const slice = candles.slice(0, barIdx + 1);
  if (slice.length < lookback * 2 + 1) {
    return { verdict: "insufficient", detail: "Not enough candle data before this trade for swing detection.", bias: null, aligned: null };
  }

  const swings = detectSwings(slice, lookback);
  const structure = detectStructure(slice, swings);
  const { bias, lastEvent } = biasAtBar(structure, barIdx);

  if (!bias) {
    return { verdict: "no-structure", detail: "No confirmed market structure (BOS/CHoCH) established before entry.", bias: null, aligned: null };
  }

  const tradeDir = trade.type === "buy" ? "bullish" : "bearish";
  const aligned = tradeDir === bias;

  let detail;
  if (aligned) {
    detail = `Aligned with active ${bias} ${lastEvent.type} — trade direction matches the prevailing structure.`;
  } else {
    detail = `Counter-trend: entered ${tradeDir} against active ${bias} ${lastEvent.type} — no structural support for this direction.`;
  }

  return { verdict: aligned ? "aligned" : "counter", detail, bias, aligned };
}

// ── Composite verdict builder ───────────────────────────────────────────
// Precomputes swings, structure, and OBs once per symbol, then evaluates
// each trade against the shared state. Call precomputeSmcState once per
// candle array, then computeTradeVerdicts per trade.

export function precomputeSmcState(candles, lookback = 5) {
  if (!candles || candles.length < lookback * 2 + 1) return null;
  const swings = detectSwings(candles, lookback);
  const structure = detectStructure(candles, swings);
  const orderBlocks = detectOrderBlocks(candles, structure);
  const fvgs = detectFVGs(candles);
  const sweeps = detectLiquiditySweeps(candles, swings);
  return { swings, structure, orderBlocks, fvgs, sweeps };
}

export function computeTradeVerdicts(candles, trade, settings = {}, smcState = null) {
  const lookback = settings.swingLookback || 5;
  const result = { s1: null, s2: null, s3: null, s4: null, s6: null };

  if (candles && candles.length > 0) {
    // S1: Market Structure
    result.s1 = computeS1Verdict(candles, trade, lookback);

    if (smcState) {
      // S2: Order Block Confluence
      result.s2 = computeS2Verdict(candles, trade, smcState.structure, smcState.orderBlocks, lookback);
      // S3: Fair Value Gap Confluence
      result.s3 = computeS3Verdict(candles, trade, smcState.fvgs, lookback);
      // S4: Liquidity Sweep
      result.s4 = computeS4Verdict(candles, trade, smcState.sweeps, lookback);
    }
  }

  // S6: Session Context
  if (settings.brokerGmtOffsetHours != null) {
    const session = sessionAtTime(trade.openTime, settings.brokerGmtOffsetHours);
    result.s6 = { session };
  }

  return result;
}
