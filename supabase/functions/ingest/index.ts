// P8.3 — ingest: the endpoint tools/mt5-sync/agent.py pushes to.
//
// Auth: `x-agent-key` header, SHA-256-hashed and looked up in agent_keys
// (keys are 256-bit random values generated in the app's Settings, so a plain
// unsalted hash is fine — this is a token lookup, not password storage).
// The function runs with the service role; every row it writes carries the
// user_id owning the presented key, so RLS isolation is preserved by
// construction.
//
// Body: the P7 `latest.json` contract (schema 1) — positions/balanceOps carry
// MT5 wall-clock strings ("YYYY.MM.DD HH:MM:SS", server time recovered as
// UTC-of-epoch by the helper's fmt_time). We parse them AS UTC, which is
// exactly the DB's wall-clock-as-UTC timestamp convention (see src/lib/dbMap.js).
// Symbol parity with the web upload path: same cleanSymbol as
// src/lib/analytics.js.
//
// Positions are upserted WITHOUT the note column so an agent push can never
// clobber a note written in the app.
import { createClient } from "npm:@supabase/supabase-js@2";

const SYNC_SCHEMA = 1;
const CHUNK = 500;

const cleanSymbol = (s: unknown) => String(s || "").replace("#", "").replace(".i", "");

const MT5_RE = /^(\d{4})\.(\d{2})\.(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;
function mt5ToDbIso(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v);
  const m = MT5_RE.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  const d = new Date(s); // defensive: accept ISO if the contract ever carries it
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const num = (v: unknown) => (v == null || v === "" ? null : Number(v));
const numOr0 = (v: unknown) => num(v) ?? 0;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function upsertChunked(
  admin: ReturnType<typeof createClient>,
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string,
) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await admin.from(table).upsert(rows.slice(i, i + CHUNK), { onConflict });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const key = req.headers.get("x-agent-key");
  if (!key) return json(401, { error: "Missing x-agent-key header" });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const keyHash = await sha256Hex(key);
  const { data: keyRow, error: keyErr } = await admin
    .from("agent_keys")
    .select("id, user_id")
    .eq("key_hash", keyHash)
    .maybeSingle();
  if (keyErr) return json(500, { error: `key lookup: ${keyErr.message}` });
  if (!keyRow) return json(401, { error: "Unknown agent key" });
  const userId = keyRow.user_id as string;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Body must be JSON" });
  }
  if (body.schema !== SYNC_SCHEMA) {
    return json(400, { error: `Unsupported schema ${body.schema} (want ${SYNC_SCHEMA})` });
  }

  const counts = { positions: 0, balanceOps: 0, candleSets: 0, candles: 0 };
  try {
    const positions = Array.isArray(body.positions) ? body.positions as Record<string, unknown>[] : [];
    if (positions.length) {
      await upsertChunked(admin, "positions", positions.map((p) => ({
        user_id: userId,
        ticket: String(p.ticket),
        open_time: mt5ToDbIso(p.openTime),
        close_time: mt5ToDbIso(p.closeTime),
        symbol: cleanSymbol(p.symbol),
        type: p.type ?? null,
        volume: numOr0(p.volume),
        open_price: num(p.openPrice),
        sl: num(p.sl),
        tp: num(p.tp),
        close_price: num(p.closePrice),
        commission: numOr0(p.commission),
        swap: numOr0(p.swap),
        profit: numOr0(p.profit),
        // no `note` — agent pushes must never overwrite app-written notes
      })), "user_id,ticket");
      counts.positions = positions.length;
    }

    const balanceOps = Array.isArray(body.balanceOps) ? body.balanceOps as Record<string, unknown>[] : [];
    if (balanceOps.length) {
      await upsertChunked(admin, "balance_ops", balanceOps.map((b) => ({
        user_id: userId,
        deal_id: String(b.dealId),
        time: mt5ToDbIso(b.time),
        profit: numOr0(b.profit),
        balance: num(b.balance),
        comment: String(b.comment || ""),
      })), "user_id,deal_id");
      counts.balanceOps = balanceOps.length;
    }

    const groups = Array.isArray(body.candles) ? body.candles as Record<string, unknown>[] : [];
    for (const g of groups) {
      const symbol = cleanSymbol(g.symbol);
      const timeframe = String(g.timeframe || "").toUpperCase();
      const bars = Array.isArray(g.bars) ? g.bars as Record<string, unknown>[] : [];
      if (!symbol || !timeframe || !bars.length) continue;
      const rows = bars
        .map((c) => ({
          user_id: userId,
          symbol,
          timeframe,
          time: mt5ToDbIso(c.time),
          open: num(c.open),
          high: num(c.high),
          low: num(c.low),
          close: num(c.close),
          tick_volume: numOr0(c.tickVolume),
        }))
        .filter((r) => r.time && [r.open, r.high, r.low, r.close].every((x) => x != null && Number.isFinite(x as number)));
      if (!rows.length) continue;
      await upsertChunked(admin, "candles", rows, "user_id,symbol,timeframe,time");
      counts.candleSets++;
      counts.candles += rows.length;
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

  // Heartbeat — Settings shows "agent last seen …" off this.
  await admin.from("agent_keys").update({ last_seen: new Date().toISOString() }).eq("id", keyRow.id);

  // P8.4 will trigger the signal engine here for the affected symbol/TF pairs.
  return json(200, { ok: true, ...counts });
});
