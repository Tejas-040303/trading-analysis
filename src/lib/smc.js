// SMC/ICT structure detection engine — causal forward pass only.
// Bar i only sees bars ≤ i. No repainting, no look-ahead.
//
// Strategy checks built here:
//   S1: Market Structure Bias (BOS/CHoCH)
//   S2: Order Block Confluence
//   S3: Fair Value Gap Confluence
//   S4: Liquidity Sweep
//   S5: Volume Profile (Fixed Range, tick-volume approximation)
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
  if (!candles.length || !swings.length) return sweeps;

  // A sweep only happens at swing levels the bar's wick actually pierced, so
  // instead of re-scanning every confirmed swing at every bar (O(n·S), ≈ O(n²)),
  // index swing prices once and binary-search just the levels inside each bar's
  // wick range. `ord` = the swing's position in the (confirmedAt, index)-sorted
  // input, so within a bar we emit matches in that same order — the output array
  // stays byte-identical to the old linear scan (computeS4Verdict depends on it).
  const lows = [];
  const highs = [];
  swings.forEach((sw, ord) => {
    (sw.type === "low" ? lows : highs).push({ sw, ord });
  });
  lows.sort((a, b) => a.sw.price - b.sw.price);
  highs.sort((a, b) => a.sw.price - b.sw.price);

  const firstGT = (arr, x) => { // first index with price strictly > x
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].sw.price > x) hi = m; else lo = m + 1; }
    return lo;
  };
  const firstGE = (arr, x) => { // first index with price >= x
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].sw.price >= x) hi = m; else lo = m + 1; }
    return lo;
  };

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const matches = [];

    // Bullish: wick dips below a swing low (price > c.low) but closes above it (price < c.close).
    if (c.close > c.low) {
      for (let j = firstGT(lows, c.low), end = firstGE(lows, c.close); j < end; j++) {
        if (lows[j].sw.confirmedAt <= i) matches.push({ ord: lows[j].ord, type: "bullish", sw: lows[j].sw });
      }
    }
    // Bearish: wick pierces above a swing high (price < c.high) but closes below it (price > c.close).
    if (c.high > c.close) {
      for (let j = firstGT(highs, c.close), end = firstGE(highs, c.high); j < end; j++) {
        if (highs[j].sw.confirmedAt <= i) matches.push({ ord: highs[j].ord, type: "bearish", sw: highs[j].sw });
      }
    }

    if (matches.length > 1) matches.sort((a, b) => a.ord - b.ord);
    for (const m of matches) {
      sweeps.push(m.type === "bullish"
        ? { type: "bullish", barIndex: i, swingIndex: m.sw.index, swingPrice: m.sw.price, wickDepth: m.sw.price - c.low }
        : { type: "bearish", barIndex: i, swingIndex: m.sw.index, swingPrice: m.sw.price, wickDepth: c.high - m.sw.price });
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

// ── S5: Volume Profile (Fixed Range) ─────────────────────────────────────
// Approximates a volume profile from tick volume by distributing each
// candle's tick volume evenly across its high-low range into price bins.
// Produces POC (Point of Control — highest volume price), VAH/VAL
// (Value Area High/Low — 70% of volume concentrated here).
//
// Note: MT5 tick volume is a proxy, not real exchange volume. This is the
// standard approximation but should not be over-trusted.

export function buildVolumeProfile(candles, startIdx, endIdx, numBins = 100) {
  if (startIdx >= endIdx || endIdx > candles.length) return null;

  let minPrice = Infinity, maxPrice = -Infinity;
  for (let i = startIdx; i < endIdx; i++) {
    if (candles[i].low < minPrice) minPrice = candles[i].low;
    if (candles[i].high > maxPrice) maxPrice = candles[i].high;
  }
  if (maxPrice <= minPrice) return null;

  const binSize = (maxPrice - minPrice) / numBins;
  const bins = new Float64Array(numBins);

  for (let i = startIdx; i < endIdx; i++) {
    const c = candles[i];
    const vol = c.tickVolume || 1;
    const cRange = c.high - c.low;
    if (cRange <= 0) {
      const bin = Math.min(numBins - 1, Math.floor((c.close - minPrice) / binSize));
      bins[bin] += vol;
      continue;
    }
    const lo = Math.max(0, Math.floor((c.low - minPrice) / binSize));
    const hi = Math.min(numBins - 1, Math.floor((c.high - minPrice) / binSize));
    const perBin = vol / (hi - lo + 1);
    for (let b = lo; b <= hi; b++) bins[b] += perBin;
  }

  // POC = bin with highest volume
  let pocBin = 0;
  for (let b = 1; b < numBins; b++) {
    if (bins[b] > bins[pocBin]) pocBin = b;
  }
  const poc = minPrice + (pocBin + 0.5) * binSize;

  // Value Area: expand from POC until 70% of total volume
  const totalVol = bins.reduce((s, v) => s + v, 0);
  const vaTarget = totalVol * 0.7;
  let vaVol = bins[pocBin];
  let vaLo = pocBin, vaHi = pocBin;
  while (vaVol < vaTarget && (vaLo > 0 || vaHi < numBins - 1)) {
    const addLo = vaLo > 0 ? bins[vaLo - 1] : 0;
    const addHi = vaHi < numBins - 1 ? bins[vaHi + 1] : 0;
    if (addLo >= addHi && vaLo > 0) { vaLo--; vaVol += bins[vaLo]; }
    else if (vaHi < numBins - 1) { vaHi++; vaVol += bins[vaHi]; }
    else { vaLo--; vaVol += bins[vaLo]; }
  }
  const vah = minPrice + (vaHi + 1) * binSize;
  const val = minPrice + vaLo * binSize;

  return { poc, vah, val, minPrice, maxPrice, binSize, bins };
}

export function computeS5Verdict(candles, trade, lookback) {
  const barIdx = findBarAtTime(candles, trade.openTime);
  if (barIdx < 0) return null;

  // Use last 200 bars (or available) as the profile range — a session-scale window
  const profileBars = 200;
  const startIdx = Math.max(0, barIdx - profileBars);
  if (barIdx - startIdx < 30) {
    return { verdict: "insufficient", detail: "Not enough bars to build a volume profile.", zone: null };
  }

  const profile = buildVolumeProfile(candles, startIdx, barIdx + 1);
  if (!profile) {
    return { verdict: "insufficient", detail: "Could not compute volume profile.", zone: null };
  }

  const entryPrice = typeof trade.openPrice === "number" ? trade.openPrice : parseFloat(trade.openPrice);
  if (!Number.isFinite(entryPrice)) {
    return { verdict: "insufficient", detail: "No entry price available.", zone: null };
  }

  const { poc, vah, val } = profile;
  const tolerance = (vah - val) * 0.05;

  if (entryPrice >= val - tolerance && entryPrice <= vah + tolerance) {
    const nearPoc = Math.abs(entryPrice - poc) <= tolerance * 2;
    if (nearPoc) {
      return {
        verdict: "at-poc",
        detail: `Entry near POC (${poc.toFixed(2)}) — the highest-volume price level. This is a high-liquidity zone.`,
        zone: "poc",
        poc, vah, val,
      };
    }
    return {
      verdict: "in-va",
      detail: `Entry inside the Value Area (${val.toFixed(2)}–${vah.toFixed(2)}, POC ${poc.toFixed(2)}). Price is in the high-volume zone.`,
      zone: "value-area",
      poc, vah, val,
    };
  }

  const above = entryPrice > vah;
  return {
    verdict: "outside-va",
    detail: `Entry ${above ? "above" : "below"} the Value Area (${val.toFixed(2)}–${vah.toFixed(2)}, POC ${poc.toFixed(2)}). Low-volume zone — price may move quickly here.`,
    zone: above ? "above-va" : "below-va",
    poc, vah, val,
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
  // Candles are stored time-sorted ascending (mergeCandles sorts on insert), so
  // binary-search the rightmost bar with time <= t instead of scanning linearly.
  // This runs once per trade per strategy, so O(log n) vs O(n) is a real win on
  // large candle sets. Returns -1 if every bar is after t (same as the old scan).
  let lo = 0, hi = candles.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (new Date(candles[mid].time).getTime() <= t) { best = mid; lo = mid + 1; }
    else { hi = mid - 1; }
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
  const result = { s1: null, s2: null, s3: null, s4: null, s5: null, s6: null };

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
    // S5: Volume Profile (doesn't need precomputed state — builds its own window)
    result.s5 = computeS5Verdict(candles, trade, lookback);
  }

  // S6: Session Context
  if (settings.brokerGmtOffsetHours != null) {
    const session = sessionAtTime(trade.openTime, settings.brokerGmtOffsetHours);
    result.s6 = { session };
  }

  return result;
}

// Active (unfilled) FVGs in a direction at a given bar — causal, mirrors activeOBsAtBar.
export function activeFVGsAtBar(fvgs, barIndex, direction) {
  return fvgs.filter(
    (f) =>
      f.direction === direction &&
      f.formIndex <= barIndex &&
      (f.filledAt === null || f.filledAt > barIndex)
  );
}

// ── Setup scan (P4) ──────────────────────────────────────────────────────
// Walks EVERY bar (causally) and emits the discrete SMC setups the rules find —
// not just the bars you traded. This is what lets us compare setups you TOOK
// against setups you SKIPPED. A setup fires when, in the prevailing structure
// direction, price is sitting in an order block or FVG zone with enough
// confluence. Each setup carries a forward max-favourable/adverse excursion
// (in R, vs a recent-swing stop) as a *hypothetical* outcome — NOT a backtest of
// your real exits, just "how far did price travel after this setup."
export function scanSetups(candles, smcState, opts = {}) {
  if (!candles || !smcState) return [];
  const { structure, orderBlocks, fvgs, sweeps } = smcState;
  const lookback = opts.swingLookback || 5;
  const minScore = opts.minScore || 3;      // of 4 possible (S1 bias + S2 OB + S3 FVG + S4 sweep)
  const cooldown = opts.cooldown || 12;     // bars to suppress repeat setups in the same direction
  const fwd = opts.forwardBars || 24;       // bars over which to measure the hypothetical outcome
  const sweepWindow = 10;

  const setups = [];
  const lastEmit = { bullish: -Infinity, bearish: -Infinity };

  for (let i = lookback * 2; i < candles.length; i++) {
    const { bias } = biasAtBar(structure, i);
    if (!bias) continue;
    const dir = bias;
    if (i - lastEmit[dir] < cooldown) continue;

    const entry = candles[i].close;

    // Require a zone to enter at — an active OB or FVG in the bias direction touching price.
    const atOB = activeOBsAtBar(orderBlocks, i, dir).some((ob) => entry >= ob.low && entry <= ob.high);
    const atFVG = activeFVGsAtBar(fvgs, i, dir).some((f) => entry >= f.low && entry <= f.high);
    if (!atOB && !atFVG) continue;

    const swept = sweeps.some((s) => s.type === dir && s.barIndex <= i && s.barIndex >= i - sweepWindow);

    const hits = ["S1"];
    if (atOB) hits.push("S2");
    if (atFVG) hits.push("S3");
    if (swept) hits.push("S4");
    const score = hits.length; // max 4
    if (score < minScore) continue;

    // Protective stop = recent swing extreme over the last lookback*2 bars.
    const from = Math.max(0, i - lookback * 2);
    let stop;
    if (dir === "bullish") {
      let lo = Infinity;
      for (let j = from; j <= i; j++) lo = Math.min(lo, candles[j].low);
      stop = lo;
    } else {
      let hi = -Infinity;
      for (let j = from; j <= i; j++) hi = Math.max(hi, candles[j].high);
      stop = hi;
    }
    const risk = Math.abs(entry - stop);

    // Forward excursion over the next `fwd` bars (hypothetical, not your real exit).
    const end = Math.min(candles.length - 1, i + fwd);
    let mfe = 0, mae = 0;
    for (let j = i + 1; j <= end; j++) {
      if (dir === "bullish") {
        mfe = Math.max(mfe, candles[j].high - entry);
        mae = Math.max(mae, entry - candles[j].low);
      } else {
        mfe = Math.max(mfe, entry - candles[j].low);
        mae = Math.max(mae, candles[j].high - entry);
      }
    }
    const mfeR = risk > 0 && Number.isFinite(mfe / risk) ? mfe / risk : null;
    const maeR = risk > 0 && Number.isFinite(mae / risk) ? mae / risk : null;

    setups.push({
      barIndex: i,
      time: candles[i].time,
      direction: dir,
      side: dir === "bullish" ? "buy" : "sell",
      entry,
      score,
      hits,
      atOB, atFVG, swept,
      risk: risk > 0 ? risk : null,
      mfeR,
      maeR,
    });
    lastEmit[dir] = i;
  }
  return setups;
}
