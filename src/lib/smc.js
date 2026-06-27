// SMC/ICT structure detection engine — causal forward pass only.
// Bar i only sees bars ≤ i. No repainting, no look-ahead.
//
// Strategy checks built here:
//   S1: Market Structure Bias (BOS/CHoCH)
//   S2: Order Block Confluence     (future)
//   S3: Fair Value Gap Confluence   (future)
//   S4: Liquidity Sweep             (future)
//   S5: Volume Profile              (future)
//   S6: Session Context             (no candles needed — lives here for verdict composition)

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
// Assembles individual strategy results into a single verdict object per trade.
// Additional strategies (S2–S5) will be added here as they're built.

export function computeTradeVerdicts(candles, trade, settings = {}) {
  const lookback = settings.swingLookback || 5;
  const result = { s1: null, s6: null };

  // S1: Market Structure
  if (candles && candles.length > 0) {
    result.s1 = computeS1Verdict(candles, trade, lookback);
  }

  // S6: Session Context
  if (settings.brokerGmtOffsetHours != null) {
    const session = sessionAtTime(trade.openTime, settings.brokerGmtOffsetHours);
    result.s6 = { session };
  }

  return result;
}
