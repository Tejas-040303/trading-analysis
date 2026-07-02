import { useState, useEffect } from "react";
import { C } from "../theme";
import { supabase } from "../lib/supabaseClient";
import { LoginScreen } from "./LoginScreen";

// P8.1 — session boundary around the app: shows LoginScreen until a Supabase
// session exists, then renders children under a slim account strip. Lives
// outside App.jsx so the journal itself stays session-agnostic until the
// P8.2 data layer lands.
export function AuthGate({ children }) {
  const [session, setSession] = useState(undefined); // undefined = still checking

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, next) => setSession(next)
    );
    return () => subscription.unsubscribe();
  }, []);

  if (session === undefined) {
    return (
      <div className="text-sm" style={{ color: C.textFaint, textAlign: "center", paddingTop: "20vh" }}>
        Checking session…
      </div>
    );
  }

  if (!session) return <LoginScreen />;

  return (
    <>
      <div
        className="text-xs flex items-center justify-end gap-2"
        style={{ color: C.textFaint, marginBottom: 8 }}
      >
        <span>{session.user?.email}</span>
        <span aria-hidden="true">·</span>
        <button
          onClick={() => supabase.auth.signOut()}
          style={{ background: "transparent", border: "none", color: C.textMuted, cursor: "pointer", padding: 0, fontSize: 12 }}
        >
          Sign out
        </button>
      </div>
      {children}
    </>
  );
}
