// P8.2 — the cloud data layer: everything App.jsx reads/writes now lives in
// Supabase Postgres (RLS-scoped to the signed-in user). Pure shape/timestamp
// translation lives in dbMap.js; this module is only I/O.
//
// Conventions:
//  - Reads paginate at PAGE rows (PostgREST caps responses at 1000).
//  - Writes chunk at CHUNK rows per upsert and are idempotent (PK/unique
//    constraints match the app's merge keys: ticket, dealId, candle time).
//  - `lastUpdated` (header "updated …" stamp) rides on account_meta.updated_at
//    as a true instant — it is NOT an MT5 wall-clock, so no conversion.
import { supabase } from "./supabaseClient";
import { storage } from "./storage";
import {
  positionToRow, rowToPosition,
  balanceOpToRow, rowToBalanceOp,
  candleToRow, rowToCandle,
} from "./dbMap";

const PAGE = 1000;
const CHUNK = 500;

async function uid() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw new Error(error.message);
  if (!data.session) throw new Error("Not signed in.");
  return data.session.user.id;
}

function fail(context, error) {
  throw new Error(`${context}: ${error.message || error}`);
}

async function fetchAllRows(table, orderCols) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from(table).select("*").range(from, from + PAGE - 1);
    for (const col of orderCols) q = q.order(col, { ascending: true });
    const { data, error } = await q;
    if (error) fail(`Loading ${table}`, error);
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

async function upsertChunked(table, rows, onConflict) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase
      .from(table)
      .upsert(rows.slice(i, i + CHUNK), { onConflict });
    if (error) fail(`Saving ${table}`, error);
  }
}

// ── Load everything the app needs at startup ──
// Candles come back as one map keyed like the old localStorage index
// ("SYMBOL_TF"), so the analytics memos keep reading synchronously from state.
export async function fetchAll() {
  await uid(); // fast-fail with a clear message when signed out
  const [posRows, balRows, metaRows, settingsRows, candleRows] = await Promise.all([
    fetchAllRows("positions", ["open_time"]),
    fetchAllRows("balance_ops", ["time"]),
    fetchAllRows("account_meta", ["user_id"]),
    fetchAllRows("settings", ["user_id"]),
    fetchAllRows("candles", ["symbol", "timeframe", "time"]),
  ]);

  const candles = {};
  const candleIndex = {};
  for (const r of candleRows) {
    const key = `${r.symbol}_${r.timeframe}`;
    if (!candles[key]) {
      candles[key] = [];
      candleIndex[key] = { symbol: r.symbol, timeframe: r.timeframe, count: 0 };
    }
    candles[key].push(rowToCandle(r));
    candleIndex[key].count++;
  }

  const metaRow = metaRows[0] || null;
  const hasMeta = metaRow && (metaRow.name || metaRow.account || metaRow.company);
  return {
    positions: posRows.map(rowToPosition),
    balanceOps: balRows.map(rowToBalanceOp),
    accountMeta: hasMeta
      ? { name: metaRow.name, account: metaRow.account, company: metaRow.company }
      : null,
    lastUpdated: metaRow ? metaRow.updated_at : null,
    settings: settingsRows[0] ? settingsRows[0].data : {},
    candles,
    candleIndex,
  };
}

export async function upsertPositions(positions) {
  const userId = await uid();
  await upsertChunked("positions", positions.map((p) => positionToRow(p, userId)), "user_id,ticket");
}

export async function upsertBalanceOps(balanceOps) {
  const userId = await uid();
  await upsertChunked("balance_ops", balanceOps.map((b) => balanceOpToRow(b, userId)), "user_id,deal_id");
}

// Upsert meta and/or bump the "updated …" stamp. Passing meta=null touches
// only updated_at (PostgREST leaves columns absent from the payload untouched
// on conflict-update, so existing name/account/company survive).
export async function saveAccountMeta(meta, lastUpdated) {
  const userId = await uid();
  const row = { user_id: userId, updated_at: lastUpdated || new Date().toISOString() };
  if (meta) {
    row.name = meta.name ?? null;
    row.account = meta.account ?? null;
    row.company = meta.company ?? null;
  }
  const { error } = await supabase.from("account_meta").upsert(row, { onConflict: "user_id" });
  if (error) fail("Saving account info", error);
}

export async function saveSettings(settings) {
  const userId = await uid();
  const { error } = await supabase
    .from("settings")
    .upsert({ user_id: userId, data: settings, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (error) fail("Saving settings", error);
}

export async function upsertCandles(symbol, timeframe, candles) {
  const userId = await uid();
  await upsertChunked(
    "candles",
    candles.map((c) => candleToRow(c, userId, symbol, timeframe)),
    "user_id,symbol,timeframe,time"
  );
}

export async function updatePositionNote(ticket, note) {
  const userId = await uid();
  const { error } = await supabase
    .from("positions")
    .update({ note: note || null })
    .eq("user_id", userId)
    .eq("ticket", String(ticket));
  if (error) fail("Saving note", error);
}

// Clears journal + candle data (settings survive, like the old Reset).
export async function deleteAllData() {
  const userId = await uid();
  for (const table of ["positions", "balance_ops", "candles", "account_meta"]) {
    const { error } = await supabase.from(table).delete().eq("user_id", userId);
    if (error) fail(`Clearing ${table}`, error);
  }
}

// ── Backup import & one-time localStorage migration ──
// Both feed the same push path: a `tj_*` keys object (the JSON-backup format)
// is parsed and upserted. Values may be raw objects or JSON strings — the
// backup format historically stored localStorage's strings verbatim.
function parseKeyValue(v) {
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return null; }
}

export async function pushKeysObject(keys) {
  const stats = { positions: 0, balanceOps: 0, candleSets: 0, candlesTotal: 0 };
  const positions = parseKeyValue(keys.tj_positions) || [];
  const balanceOps = parseKeyValue(keys.tj_balance_ops) || [];
  const meta = parseKeyValue(keys.tj_account_meta) || null;
  const settings = parseKeyValue(keys.tj_settings) || null;
  const lastUpdated = parseKeyValue(keys.tj_last_updated) || null;

  if (positions.length) await upsertPositions(positions);
  if (balanceOps.length) await upsertBalanceOps(balanceOps);
  if (meta || positions.length) await saveAccountMeta(meta, lastUpdated || undefined);
  if (settings) await saveSettings(settings);
  stats.positions = positions.length;
  stats.balanceOps = balanceOps.length;

  for (const [k, v] of Object.entries(keys)) {
    if (!k.startsWith("tj_candles_")) continue;
    const candles = parseKeyValue(v);
    if (!Array.isArray(candles) || !candles.length) continue;
    // Key format: tj_candles_<SYMBOL>_<TF> — timeframe is the last segment.
    const rest = k.slice("tj_candles_".length);
    const cut = rest.lastIndexOf("_");
    if (cut <= 0) continue;
    await upsertCandles(rest.slice(0, cut), rest.slice(cut + 1), candles);
    stats.candleSets++;
    stats.candlesTotal += candles.length;
  }
  return stats;
}

// What's still sitting in this browser's localStorage (pre-P8.2 data)?
export function localDataSummary() {
  const positions = storage.get("tj_positions") || [];
  const index = storage.get("tj_candle_index") || {};
  const candleSets = Object.keys(index).length;
  if (!positions.length && !candleSets) return null;
  return { positions: positions.length, candleSets };
}

// One-time move: read every tj_* key, push to Postgres, verify the DB holds at
// least as many rows as we pushed, and only then clear localStorage.
export async function migrateLocalToCloud() {
  const keys = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("tj_")) keys[k] = localStorage.getItem(k);
  }
  const stats = await pushKeysObject(keys);

  const countOf = async (table) => {
    const { count, error } = await supabase.from(table).select("*", { count: "exact", head: true });
    if (error) fail(`Verifying ${table}`, error);
    return count || 0;
  };
  const [posCount, balCount, candleCount] = await Promise.all([
    countOf("positions"), countOf("balance_ops"), countOf("candles"),
  ]);
  if (posCount < stats.positions || balCount < stats.balanceOps || candleCount < stats.candlesTotal) {
    throw new Error(
      `Verification failed — cloud row counts (${posCount}/${balCount}/${candleCount}) are lower than what was pushed. Local data was NOT cleared.`
    );
  }

  Object.keys(keys).forEach((k) => storage.remove(k));
  return { ...stats, verified: { posCount, balCount, candleCount } };
}
