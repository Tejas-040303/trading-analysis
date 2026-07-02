// Phase 7 — ingestion for the local MT5 sync helper (tools/mt5-sync/sync.py).
//
// The helper attaches to a running MetaTrader 5 terminal and writes a structured
// `latest.json`; this module parses it and merges it into the same shapes the
// manual .xlsx / .csv upload path produces, so ALL downstream analytics work
// unchanged. Two parity properties make a sync and a manual upload agree instead
// of duplicating:
//
//   1. ID parity — positions are keyed by the MT5 position_id (`ticket`) and
//      balance ops by the deal ticket (`dealId`), exactly like parseWorkbookRows.
//   2. Timestamp parity — the helper emits MT5-style "YYYY.MM.DD HH:MM:SS"
//      strings and we parse them with the SAME parseMT5DateTime the .xlsx path
//      uses, so trades bucket to the identical day/session.
//
// Pure & framework-free (no DOM, no storage). The caller (App.jsx) is responsible
// for reading existing state, persisting the returned values, and reloading.
import { parseMT5DateTime, numOrNull, cleanSymbol } from "./analytics.js";
import { mergeCandles, candleStorageKey } from "./candleParser.js";

// Bump when the on-disk `latest.json` contract changes in a breaking way.
export const SYNC_SCHEMA = 1;

// Convert an MT5 "YYYY.MM.DD HH:MM:SS" string (or Excel serial) to the app's
// stored ISO via the shared parser — the crux of timestamp parity. Falls back to
// a plain Date for defensive robustness if an ISO string ever slips through.
function toIso(value) {
  if (value == null) return null;
  const mt5 = parseMT5DateTime(value);
  if (mt5) return mt5.toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Map a sync-payload position to the exact shape parseWorkbookRows emits (same
// cleanSymbol, same numOrNull coercion, same defaults).
function mapPosition(p) {
  return {
    ticket: String(p.ticket),
    openTime: toIso(p.openTime),
    closeTime: toIso(p.closeTime),
    symbol: cleanSymbol(p.symbol),
    type: p.type,
    volume: numOrNull(p.volume) ?? 0,
    openPrice: numOrNull(p.openPrice),
    sl: numOrNull(p.sl),
    tp: numOrNull(p.tp),
    closePrice: numOrNull(p.closePrice),
    commission: numOrNull(p.commission) ?? 0,
    swap: numOrNull(p.swap) ?? 0,
    profit: numOrNull(p.profit) ?? 0,
  };
}

function mapBalanceOp(b) {
  return {
    dealId: String(b.dealId),
    time: toIso(b.time),
    profit: numOrNull(b.profit) ?? 0,
    balance: numOrNull(b.balance),
    comment: b.comment || "",
  };
}

function mapCandle(b) {
  return {
    time: toIso(b.time),
    open: numOrNull(b.open),
    high: numOrNull(b.high),
    low: numOrNull(b.low),
    close: numOrNull(b.close),
    tickVolume: numOrNull(b.tickVolume) ?? 0,
  };
}

// Validate and normalize a raw `latest.json` (string or object). Throws Error
// with a user-facing message the Settings UI can surface directly.
export function parseSyncPayload(input) {
  let data = input;
  if (typeof input === "string") {
    try {
      data = JSON.parse(input);
    } catch {
      throw new Error("That file isn't valid JSON — is it the MT5 sync export?");
    }
  }
  if (!data || typeof data !== "object") {
    throw new Error("Empty or unreadable sync file.");
  }
  if (data.kind !== "mt5-sync") {
    throw new Error("Not an MT5 sync file (expected kind \"mt5-sync\").");
  }
  if (data.schema != null && Number(data.schema) > SYNC_SCHEMA) {
    throw new Error(`This sync file is schema ${data.schema}, newer than this app supports (${SYNC_SCHEMA}). Update the app.`);
  }
  return {
    kind: data.kind,
    schema: data.schema == null ? 1 : Number(data.schema),
    generatedAt: data.generatedAt || null,
    account: data.account && typeof data.account === "object" ? data.account : null,
    positions: Array.isArray(data.positions) ? data.positions : [],
    balanceOps: Array.isArray(data.balanceOps) ? data.balanceOps : [],
    candles: Array.isArray(data.candles) ? data.candles : [],
  };
}

// Merge a parsed sync payload into existing state. Pure: returns the values to
// persist; does not touch storage.
//
// existing = {
//   positions:   tj_positions array,
//   balanceOps:  tj_balance_ops array,
//   candleIndex: tj_candle_index object,
//   accountMeta: tj_account_meta object|null,
//   getCandles:  (symbol, timeframe) => existing candle array | null,
// }
//
// Returns { positions, balanceOps, candleUpdates, candleIndex, accountMeta, stats }
// where candleUpdates = [{ key, symbol, timeframe, candles }] to storage.set each.
export function mergeSync(existing, payload) {
  const ex = existing || {};
  let skipped = 0;

  // ── Positions (dedupe by ticket, incoming wins, PRESERVE user notes) ──
  const posMap = new Map((ex.positions || []).map((p) => [p.ticket, p]));
  let positionsIncoming = 0;
  for (const raw of payload.positions || []) {
    const mapped = mapPosition(raw);
    if (!mapped.ticket || !mapped.openTime || !mapped.closeTime) { skipped++; continue; }
    positionsIncoming++;
    const prev = posMap.get(mapped.ticket);
    // A sync must never clobber a note the user typed on a trade it re-imports.
    if (prev && prev.note) mapped.note = prev.note;
    posMap.set(mapped.ticket, mapped);
  }
  const positions = Array.from(posMap.values());

  // ── Balance ops (dedupe by dealId) ──
  const balMap = new Map((ex.balanceOps || []).map((b) => [b.dealId, b]));
  for (const raw of payload.balanceOps || []) {
    const mapped = mapBalanceOp(raw);
    if (!mapped.dealId || !mapped.time) { skipped++; continue; }
    balMap.set(mapped.dealId, mapped);
  }
  const balanceOps = Array.from(balMap.values());

  // ── Candles (per symbol/timeframe, reuse mergeCandles + storage key) ──
  const candleIndex = { ...(ex.candleIndex || {}) };
  const candleUpdates = [];
  const getCandles = typeof ex.getCandles === "function" ? ex.getCandles : () => null;
  for (const group of payload.candles || []) {
    const symbol = cleanSymbol(group && group.symbol);
    const timeframe = String((group && group.timeframe) || "").toUpperCase();
    if (!symbol || !timeframe) continue;
    const incoming = (group.bars || [])
      .map(mapCandle)
      .filter((c) => c.time && [c.open, c.high, c.low, c.close].every(Number.isFinite));
    if (!incoming.length) continue;
    const merged = mergeCandles(getCandles(symbol, timeframe) || [], incoming);
    candleUpdates.push({ key: candleStorageKey(symbol, timeframe), symbol, timeframe, candles: merged });
    candleIndex[`${symbol}_${timeframe}`] = { symbol, timeframe, count: merged.length };
  }

  // ── Account meta (only override when the payload actually carries an account) ──
  const accountMeta =
    payload.account && payload.account.account
      ? { name: payload.account.name, account: payload.account.account, company: payload.account.company }
      : ex.accountMeta || null;

  return {
    positions,
    balanceOps,
    candleUpdates,
    candleIndex,
    accountMeta,
    stats: {
      positions: positions.length,
      positionsIncoming,
      balanceOps: balanceOps.length,
      candleGroups: candleUpdates.length,
      skipped,
    },
  };
}
