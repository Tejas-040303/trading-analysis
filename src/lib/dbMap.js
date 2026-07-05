// P8.2 — pure translation between the app's in-memory shapes and Postgres rows.
// No I/O here (db.js does that); everything is unit-testable.
//
// ── The timestamp convention (the P8 "timestamp trap") ──
// In memory, the app keeps ISO strings whose BROWSER-LOCAL components equal the
// MT5 server wall-clock — that's what parseMT5DateTime produces and what every
// analytics helper (tradeDate, sessions, heatmaps) assumes. The database instead
// stores the wall-clock digits AS UTC (timestamptz), a browser-independent
// convention the P8.3 agent and edge functions share. These two helpers convert
// at the boundary and are exact inverses in any fixed-offset timezone (IST has
// no DST, so round-trips are lossless for TJ's data).

// App ISO (wall-clock in local components) → DB ISO (wall-clock as UTC).
export function wallIsoToDbIso(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(
    d.getFullYear(), d.getMonth(), d.getDate(),
    d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()
  )).toISOString();
}

// DB ISO (wall-clock as UTC) → app ISO (wall-clock in local components).
export function dbIsoToWallIso(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()
  ).toISOString();
}

// PostgREST returns numeric columns as JSON numbers, but coerce defensively so
// a driver/serializer change can't quietly turn prices into strings.
const num = (v) => (v == null ? null : Number(v));
const numOr0 = (v) => (v == null ? 0 : Number(v));

export function positionToRow(p, userId) {
  return {
    user_id: userId,
    ticket: String(p.ticket),
    open_time: wallIsoToDbIso(p.openTime),
    close_time: wallIsoToDbIso(p.closeTime),
    symbol: p.symbol ?? null,
    type: p.type ?? null,
    volume: p.volume ?? 0,
    open_price: p.openPrice ?? null,
    sl: p.sl ?? null,
    tp: p.tp ?? null,
    close_price: p.closePrice ?? null,
    commission: p.commission ?? 0,
    swap: p.swap ?? 0,
    profit: p.profit ?? 0,
    note: p.note ?? null,
  };
}

export function rowToPosition(r) {
  const p = {
    ticket: r.ticket,
    openTime: dbIsoToWallIso(r.open_time),
    closeTime: dbIsoToWallIso(r.close_time),
    symbol: r.symbol,
    type: r.type,
    volume: numOr0(r.volume),
    openPrice: num(r.open_price),
    sl: num(r.sl),
    tp: num(r.tp),
    closePrice: num(r.close_price),
    commission: numOr0(r.commission),
    swap: numOr0(r.swap),
    profit: numOr0(r.profit),
  };
  if (r.note != null) p.note = r.note;
  return p;
}

export function balanceOpToRow(b, userId) {
  return {
    user_id: userId,
    deal_id: String(b.dealId),
    time: wallIsoToDbIso(b.time),
    profit: b.profit ?? 0,
    balance: b.balance ?? null,
    comment: b.comment || "",
  };
}

export function rowToBalanceOp(r) {
  return {
    dealId: r.deal_id,
    time: dbIsoToWallIso(r.time),
    profit: numOr0(r.profit),
    balance: num(r.balance),
    comment: r.comment || "",
  };
}

export function candleToRow(c, userId, symbol, timeframe) {
  return {
    user_id: userId,
    symbol,
    timeframe,
    time: wallIsoToDbIso(c.time),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    tick_volume: c.tickVolume ?? 0,
  };
}

export function rowToCandle(r) {
  return {
    time: dbIsoToWallIso(r.time),
    open: num(r.open),
    high: num(r.high),
    low: num(r.low),
    close: num(r.close),
    tickVolume: numOr0(r.tick_volume),
  };
}
