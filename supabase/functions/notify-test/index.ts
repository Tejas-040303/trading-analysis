// P8.4a — "Send test message" for the Telegram settings. Runs with
// verify_jwt=true: only a signed-in app user can call it, and it acts only on
// that caller. Body may carry { token, chatId } (unsaved draft values from the
// Settings form); otherwise the user's saved settings are used.
import { createClient } from "npm:@supabase/supabase-js@2";

// Called from the browser (supabase.functions.invoke), so CORS headers are
// required on every response and the OPTIONS preflight must succeed.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const authHeader = req.headers.get("Authorization") || "";
  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return json(401, { error: "Not signed in" });

  let body: Record<string, string> = {};
  try {
    body = await req.json();
  } catch { /* empty body is fine */ }

  let token = body.token || "";
  let chatId = body.chatId || "";
  if (!token || !chatId) {
    // RLS scopes this select to the caller.
    const { data: row } = await userClient.from("settings").select("data").maybeSingle();
    const s = (row?.data || {}) as Record<string, string>;
    token = token || s.telegramBotToken || "";
    chatId = chatId || s.telegramChatId || "";
  }
  if (!token || !chatId) return json(400, { error: "Set the bot token and chat id first." });

  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: "✅ Trading journal test — Telegram alerts are wired up." }),
  });
  const tg = await resp.json().catch(() => ({}));
  if (!resp.ok || !tg.ok) {
    return json(400, { error: `Telegram said: ${tg.description || resp.status}` });
  }
  return json(200, { ok: true });
});
