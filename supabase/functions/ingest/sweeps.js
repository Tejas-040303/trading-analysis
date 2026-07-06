// Swing + liquidity-sweep detection — extracted verbatim from smc.js (P8.4a)
// so the ingest edge function can bundle just these ~120 lines instead of the
// whole SMC engine. smc.js re-exports both, so every existing import/test is
// unchanged. Causal forward pass only: bar i only sees bars ≤ i.

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
