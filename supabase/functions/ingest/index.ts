// P8.3/P8.4 — ingest: the endpoint tools/mt5-sync/agent.py pushes to, now with
// the Liquidity Sweep signal engine (pilot strategy) running inline after the
// data lands.
//
// Auth: `x-agent-key` header, SHA-256-hashed and looked up in agent_keys.
// The function runs with the service role; every row it writes carries the
// key's user_id, so RLS isolation is preserved by construction.
//
// Body: the P7 `latest.json` contract (schema 1). MT5 wall-clock strings are
// parsed AS UTC — the DB's timestamp convention (src/lib/dbMap.js). Positions
// are upserted WITHOUT the note column so agent pushes can't clobber notes.
//
// Signal engine (P8.4a): pure logic lives in sweepSignal.js/smc.js — verbatim
// copies of src/lib (npm run sync:functions). Two-stage lifecycle:
// forming (heads-up Telegram) → confirmed (full plan) | invalidated.
import { createClient } from "npm:@supabase/supabase-js@2";
import { runSweepEngine, SWEEP_TFS, CONFIRM_TFS } from "./sweepSignal.js";

const SYNC_SCHEMA = 1;
const CHUNK = 500;
const BOT_NAME = "Liquidity Sweep";

const cleanSymbol = (s: unknown) => String(s || "").replace("#", "").replace(".i", "");

const MT5_RE = /^(\d{4})\.(\d{2})\.(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;
function mt5ToDbIso(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v);
  const m = MT5_RE.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const num = (v: unknown) => (v == null || v === "" ? null : Number(v));
const numOr0 = (v: unknown) => num(v) ?? 0;
const isoNorm = (t: unknown) => new Date(String(t)).toISOString();

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function upsertChunked(admin: ReturnType<typeof createClient>, table: string, rows: Record<string, unknown>[], onConflict: string, ignoreDuplicates = false) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await admin.from(table).upsert(rows.slice(i, i + CHUNK), { onConflict, ignoreDuplicates });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

async function sendTelegram(token: string, chatId: string, text: string) {
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (_e) {
    // Telegram being down must never fail an ingest — signals are stored regardless.
  }
}

const fmtDir = (d: string) => (d === "bullish" ? "LONG" : "SHORT");

function formingMsg(sym: string, sig: { timeframe: string; direction: string; sweptLevel: number }) {
  const side = sig.direction === "bullish" ? "below" : "above";
  return `⚡ ${sym} ${sig.timeframe} — liquidity swept ${side} ${sig.sweptLevel} · watching for ${fmtDir(sig.direction)} confirmation (M1/M3 engulf)`;
}

function confirmedMsg(sym: string, tf: string, direction: string, plan: Record<string, number | boolean>, confTf: string) {
  const warn = plan.slWarning ? ` ⚠️ SL ${plan.slPips} pips — exceeds your 60 cap` : "";
  return [
    `✅ ${sym} ${tf} sweep CONFIRMED — ${fmtDir(direction)} (${confTf} engulf)`,
    `Entry ~${plan.entry} · SL ${plan.sl} (${plan.slPips} pips)${warn}`,
    `Plan: 1:1 ${plan.tp1} → break-even · 1:1.5 ${plan.tp15} → trail +0.3R · 1:2 ${plan.tp2} → trail +1R`,
    `Runner: trail 50 pips · max TP ${plan.maxTp}`,
  ].join("\n");
}

// Load one candle series (already engine-shaped, times normalized, ascending).
async function loadSeries(admin: ReturnType<typeof createClient>, userId: string, symbol: string, timeframe: string, sinceIso: string | null, cap = 3000) {
  let q = admin.from("candles")
    .select("time, open, high, low, close")
    .eq("user_id", userId).eq("symbol", symbol).eq("timeframe", timeframe)
    .order("time", { ascending: false }).limit(cap);
  if (sinceIso) q = q.gte("time", sinceIso);
  const { data, error } = await q;
  if (error) throw new Error(`candles ${symbol} ${timeframe}: ${error.message}`);
  return (data || []).reverse().map((r) => ({
    time: isoNorm(r.time), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
  }));
}

async function runEngineForSymbol(admin: ReturnType<typeof createClient>, userId: string, symbol: string, telegram: { token: string; chatId: string }) {
  // One bot row per user for the pilot strategy; respect its enabled flag.
  const { data: bot, error: botErr } = await admin.from("bots")
    .upsert({ user_id: userId, name: BOT_NAME }, { onConflict: "user_id,name" })
    .select("id, enabled").single();
  if (botErr) throw new Error(`bots: ${botErr.message}`);
  if (!bot.enabled) return { created: 0, confirmed: 0, invalidated: 0 };

  const { data: sigRows, error: sigErr } = await admin.from("signals")
    .select("id, timeframe, direction, bar_time, status, levels")
    .eq("user_id", userId).eq("bot_id", bot.id).eq("symbol", symbol).eq("kind", "sweep")
    .order("bar_time", { ascending: false }).limit(300);
  if (sigErr) throw new Error(`signals: ${sigErr.message}`);

  const existingKeys = new Set((sigRows || []).map((r) => `${r.timeframe}|${r.direction}|${isoNorm(r.bar_time)}`));
  const openSignals = (sigRows || [])
    .filter((r) => r.status === "forming")
    .map((r) => ({
      id: r.id, timeframe: r.timeframe, direction: r.direction,
      barTime: isoNorm(r.bar_time),
      sweptLevel: Number((r.levels as Record<string, unknown>)?.sweptLevel),
      sweepExtreme: Number((r.levels as Record<string, unknown>)?.sweepExtreme),
    }));

  // Confirmation series must reach back to the oldest forming signal.
  const oldestForming = openSignals.length ? openSignals.map((s) => s.barTime).sort()[0] : null;

  const sweepSeries: Record<string, unknown[]> = {};
  for (const tf of SWEEP_TFS) sweepSeries[tf] = await loadSeries(admin, userId, symbol, tf, null, 300);
  const confirmSeries: Record<string, unknown[]> = {};
  for (const tf of CONFIRM_TFS) confirmSeries[tf] = await loadSeries(admin, userId, symbol, tf, oldestForming, 3000);

  const out = runSweepEngine({ sweepSeries, confirmSeries, openSignals, existingKeys, opts: {} });

  // create → forming rows (+heads-up). ignoreDuplicates: a concurrent run must not double-ping.
  for (const seed of out.create) {
    const { data: ins, error } = await admin.from("signals").upsert({
      user_id: userId, bot_id: bot.id, symbol, timeframe: seed.timeframe,
      kind: "sweep", direction: seed.direction, bar_time: seed.barTime,
      status: "forming",
      levels: { sweptLevel: seed.sweptLevel, sweepExtreme: seed.sweepExtreme },
    }, { onConflict: "bot_id,symbol,timeframe,kind,direction,bar_time", ignoreDuplicates: true }).select("id");
    if (error) throw new Error(`signals insert: ${error.message}`);
    if (ins && ins.length) await sendTelegram(telegram.token, telegram.chatId, formingMsg(symbol, seed));
  }

  for (const { signal, confirmation, plan } of out.confirm) {
    const { error } = await admin.from("signals").update({
      status: "confirmed",
      confirmed_at: new Date().toISOString(),
      levels: {
        sweptLevel: signal.sweptLevel, sweepExtreme: signal.sweepExtreme,
        ...plan, confirmedBy: confirmation.timeframe, confirmedBarTime: confirmation.time,
      },
    }).eq("id", signal.id);
    if (error) throw new Error(`signals confirm: ${error.message}`);
    await sendTelegram(telegram.token, telegram.chatId, confirmedMsg(symbol, signal.timeframe, signal.direction, plan, confirmation.timeframe));
  }

  for (const signal of out.invalidate) {
    const { error } = await admin.from("signals").update({ status: "invalidated" }).eq("id", signal.id);
    if (error) throw new Error(`signals invalidate: ${error.message}`);
    await sendTelegram(telegram.token, telegram.chatId,
      `❌ ${symbol} ${signal.timeframe} sweep at ${signal.sweptLevel} invalidated — level re-broken before confirmation`);
  }

  return { created: out.create.length, confirmed: out.confirm.length, invalidated: out.invalidate.length };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const key = req.headers.get("x-agent-key");
  if (!key) return json(401, { error: "Missing x-agent-key header" });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const keyHash = await sha256Hex(key);
  const { data: keyRow, error: keyErr } = await admin.from("agent_keys")
    .select("id, user_id").eq("key_hash", keyHash).maybeSingle();
  if (keyErr) return json(500, { error: `key lookup: ${keyErr.message}` });
  if (!keyRow) return json(401, { error: "Unknown agent key" });
  const userId = keyRow.user_id as string;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Body must be JSON" });
  }
  if (body.schema !== SYNC_SCHEMA) return json(400, { error: `Unsupported schema ${body.schema} (want ${SYNC_SCHEMA})` });

  const counts = { positions: 0, balanceOps: 0, candleSets: 0, candles: 0 };
  const pushedSymbols = new Set<string>();
  try {
    const positions = Array.isArray(body.positions) ? body.positions as Record<string, unknown>[] : [];
    if (positions.length) {
      await upsertChunked(admin, "positions", positions.map((p) => ({
        user_id: userId, ticket: String(p.ticket),
        open_time: mt5ToDbIso(p.openTime), close_time: mt5ToDbIso(p.closeTime),
        symbol: cleanSymbol(p.symbol), type: p.type ?? null,
        volume: numOr0(p.volume), open_price: num(p.openPrice),
        sl: num(p.sl), tp: num(p.tp), close_price: num(p.closePrice),
        commission: numOr0(p.commission), swap: numOr0(p.swap), profit: numOr0(p.profit),
      })), "user_id,ticket");
      counts.positions = positions.length;
    }

    const balanceOps = Array.isArray(body.balanceOps) ? body.balanceOps as Record<string, unknown>[] : [];
    if (balanceOps.length) {
      await upsertChunked(admin, "balance_ops", balanceOps.map((b) => ({
        user_id: userId, deal_id: String(b.dealId), time: mt5ToDbIso(b.time),
        profit: numOr0(b.profit), balance: num(b.balance), comment: String(b.comment || ""),
      })), "user_id,deal_id");
      counts.balanceOps = balanceOps.length;
    }

    const groups = Array.isArray(body.candles) ? body.candles as Record<string, unknown>[] : [];
    for (const g of groups) {
      const symbol = cleanSymbol(g.symbol);
      const timeframe = String(g.timeframe || "").toUpperCase();
      const bars = Array.isArray(g.bars) ? g.bars as Record<string, unknown>[] : [];
      if (!symbol || !timeframe || !bars.length) continue;
      const rows = bars.map((c) => ({
        user_id: userId, symbol, timeframe, time: mt5ToDbIso(c.time),
        open: num(c.open), high: num(c.high), low: num(c.low), close: num(c.close),
        tick_volume: numOr0(c.tickVolume),
      })).filter((r) => r.time && [r.open, r.high, r.low, r.close].every((x) => x != null && Number.isFinite(x as number)));
      if (!rows.length) continue;
      await upsertChunked(admin, "candles", rows, "user_id,symbol,timeframe,time");
      counts.candleSets++;
      counts.candles += rows.length;
      pushedSymbols.add(symbol);
    }

    const account = body.account as Record<string, unknown> | null;
    const metaRow: Record<string, unknown> = { user_id: userId, updated_at: new Date().toISOString() };
    if (account && (account.account || account.name || account.company)) {
      metaRow.name = account.name ?? null;
      metaRow.account = account.account ?? null;
      metaRow.company = account.company ?? null;
    }
    {
      const { error } = await admin.from("account_meta").upsert(metaRow, { onConflict: "user_id" });
      if (error) throw new Error(`account_meta: ${error.message}`);
    }
  } catch (e) {
    return json(500, { error: (e as Error).message });
  }

  // Heartbeat before the engine: data landed even if signal work fails below.
  await admin.from("agent_keys").update({ last_seen: new Date().toISOString() }).eq("id", keyRow.id);

  // ── P8.4a: run the sweep engine for every symbol that got fresh candles ──
  const signals = { created: 0, confirmed: 0, invalidated: 0, error: null as string | null };
  try {
    const { data: settingsRow } = await admin.from("settings").select("data").eq("user_id", userId).maybeSingle();
    const s = (settingsRow?.data || {}) as Record<string, string>;
    const telegram = { token: s.telegramBotToken || "", chatId: s.telegramChatId || "" };
    for (const symbol of pushedSymbols) {
      const r = await runEngineForSymbol(admin, userId, symbol, telegram);
      signals.created += r.created;
      signals.confirmed += r.confirmed;
      signals.invalidated += r.invalidated;
    }
  } catch (e) {
    signals.error = (e as Error).message; // engine failure must not fail the ingest
  }

  return json(200, { ok: true, ...counts, signals });
});
