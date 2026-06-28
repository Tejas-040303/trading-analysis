// MT5 CSV candle data parser (spec §5).
//
// MT5 exports chart data as tab-separated CSV:
//   <DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>
//   2026.05.01\t01:00:00\t4625.63\t4636.17\t4625.50\t4628.66\t757\t0\t24
//
// Filename convention: SYMBOL__TIMEFRAME_START_END.csv
// e.g. GOLD_i__M5_202605010100_202606191950.csv

const cleanSymbol = (s) => String(s || "").replace("#", "").replace(".i", "").replace("_i", "");

// Returns { candles, skipped } — `skipped` counts data lines that looked like
// candle rows but were malformed (bad delimiter, unreadable date, non-numeric
// OHLC), so the upload UI can tell the user how many rows were dropped. Header
// lines are not counted as skipped.
export function parseCandleCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { candles: [], skipped: 0 };

  const candles = [];
  let skipped = 0;
  for (const line of lines) {
    if (line.startsWith("<") || line.toLowerCase().startsWith("date")) continue;

    const parts = line.split("\t");
    if (parts.length < 7) { skipped++; continue; }

    const [dateStr, timeStr, openStr, highStr, lowStr, closeStr, tickVolStr] = parts;

    const dm = dateStr.match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
    if (!dm) { skipped++; continue; }
    const tm = timeStr.match(/^(\d{2}):(\d{2}):(\d{2})$/);
    if (!tm) { skipped++; continue; }

    const [y, mo, d] = dm.slice(1).map(Number);
    const [h, mi, s] = tm.slice(1).map(Number);
    const time = new Date(y, mo - 1, d, h, mi, s);

    const open = parseFloat(openStr);
    const high = parseFloat(highStr);
    const low = parseFloat(lowStr);
    const close = parseFloat(closeStr);
    const tickVolume = parseInt(tickVolStr, 10) || 0;

    if ([open, high, low, close].some(Number.isNaN)) { skipped++; continue; }

    candles.push({
      time: time.toISOString(),
      open,
      high,
      low,
      close,
      tickVolume,
    });
  }

  return { candles, skipped };
}

export function inferSymbolTimeframe(filename) {
  // MT5 default: GOLD_i__M5_202605010100_202606191950.csv
  const name = filename.replace(/\.csv$/i, "");

  // Try standard MT5 pattern: SYMBOL__TIMEFRAME_START_END
  const m = name.match(/^(.+?)__?(M\d+|H\d+|D1|W1|MN1)_/i);
  if (m) {
    return {
      symbol: cleanSymbol(m[1]),
      timeframe: m[2].toUpperCase(),
    };
  }

  // Fallback: try to find a timeframe anywhere in the name
  const tf = name.match(/\b(M1|M5|M15|M30|H1|H4|D1|W1|MN1)\b/i);
  const parts = name.split(/[_\s-]+/);
  const sym = parts[0] ? cleanSymbol(parts[0]) : null;

  return {
    symbol: sym || null,
    timeframe: tf ? tf[1].toUpperCase() : null,
  };
}

export function mergeCandles(existing, incoming) {
  const map = new Map();
  (existing || []).forEach((c) => map.set(c.time, c));
  incoming.forEach((c) => map.set(c.time, c));
  return Array.from(map.values()).sort(
    (a, b) => new Date(a.time) - new Date(b.time)
  );
}

export function candleStorageKey(symbol, timeframe) {
  return `tj_candles_${symbol}_${timeframe}`;
}
