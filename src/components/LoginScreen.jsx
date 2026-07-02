import { useState } from "react";
import { LogIn, UserPlus } from "lucide-react";
import { C } from "../theme";
import { supabase } from "../lib/supabaseClient";

// P8.1 — email/password gate in front of the journal. Sign-up exists for the
// first-run account creation (single-user app today); Supabase sends a
// confirmation email before the account can sign in.
export function LoginScreen() {
  const [mode, setMode] = useState("signin"); // signin | signup
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const fieldStyle = {
    background: C.panelAlt,
    border: `0.5px solid ${C.border}`,
    color: C.text,
    borderRadius: 8,
    padding: "8px 10px",
    fontSize: 14,
    width: "100%",
    fontFamily: "'JetBrains Mono', monospace",
  };

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setNotice("");
    setBusy(true);
    try {
      if (mode === "signin") {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) setError(err.message);
        // success: AuthGate's onAuthStateChange swaps this screen out
      } else {
        const { data, error: err } = await supabase.auth.signUp({ email, password });
        if (err) {
          setError(err.message);
        } else if (!data.session) {
          setNotice("Account created — check your email for the confirmation link, then sign in.");
          setMode("signin");
        }
      }
    } catch (err) {
      setError(err?.message || "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", justifyContent: "center", paddingTop: "14vh" }}>
      <form
        onSubmit={submit}
        className="rounded-2xl"
        style={{ background: C.panel, border: `0.5px solid ${C.border}`, width: "100%", maxWidth: 380, padding: 24 }}
      >
        <div style={{ color: C.text, fontWeight: 600, fontSize: 20, fontFamily: "'Space Grotesk', sans-serif" }}>
          Trading Journal
        </div>
        <div className="text-sm mb-5" style={{ color: C.textMuted, marginTop: 4 }}>
          {mode === "signin" ? "Sign in to your journal." : "Create your account."}
        </div>

        <label className="text-sm block mb-1" style={{ color: C.text }} htmlFor="login-email">Email</label>
        <input
          id="login-email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ ...fieldStyle, marginBottom: 14 }}
        />

        <label className="text-sm block mb-1" style={{ color: C.text }} htmlFor="login-password">Password</label>
        <input
          id="login-password"
          type="password"
          required
          minLength={8}
          autoComplete={mode === "signin" ? "current-password" : "new-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ ...fieldStyle, marginBottom: 18 }}
        />

        {error && (
          <div className="text-sm mb-3" role="alert" style={{ color: C.rose }}>{error}</div>
        )}
        {notice && (
          <div className="text-sm mb-3" role="status" style={{ color: C.emerald }}>{notice}</div>
        )}

        <button
          type="submit"
          disabled={busy}
          style={{
            background: C.amber,
            color: "#2A1A02",
            border: "none",
            borderRadius: 8,
            padding: "8px 14px",
            fontSize: 14,
            fontWeight: 600,
            cursor: busy ? "wait" : "pointer",
            width: "100%",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            opacity: busy ? 0.7 : 1,
          }}
        >
          {mode === "signin" ? <LogIn size={16} /> : <UserPlus size={16} />}
          {busy ? "Working…" : mode === "signin" ? "Sign in" : "Create account"}
        </button>

        <button
          type="button"
          onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setError(""); setNotice(""); }}
          className="text-sm"
          style={{ background: "transparent", border: "none", color: C.textMuted, cursor: "pointer", marginTop: 14, padding: 0 }}
        >
          {mode === "signin" ? "First time here? Create an account" : "Already have an account? Sign in"}
        </button>
      </form>
    </div>
  );
}
