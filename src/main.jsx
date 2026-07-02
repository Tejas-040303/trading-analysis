import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import { AuthGate } from "./components/AuthGate.jsx";
import "./index.css";

// Dump every tj_* localStorage key to a downloadable JSON file. Mirrors the
// in-app exportData() so a user can recover their journal even if the app
// itself has crashed and the normal UI is unreachable.
function downloadBackup() {
  try {
    const keys = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("tj_")) keys[k] = localStorage.getItem(k);
    }
    const payload = { app: "trading-journal", exportedAt: new Date().toISOString(), keys };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const el = document.createElement("a");
    el.href = url;
    el.download = `trading-journal-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(el);
    el.click();
    document.body.removeChild(el);
    URL.revokeObjectURL(url);
  } catch (e) {
    /* nothing more we can do */
  }
}

// Catches render-time crashes (e.g. a malformed upload producing bad data) so
// the user sees a recovery screen with a working backup button instead of a
// blank white page that strands months of journal history.
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("App crashed:", error, info);
  }
  render() {
    if (this.state.error) {
      const C = { panel: "#0B121C", border: "#1C2A3A", text: "#E6EDF5", muted: "#8B9AAE", faint: "#5B6B80", amber: "#FBB94B" };
      return (
        <div className="rounded-2xl p-6 md:p-8" style={{ background: C.panel, border: `0.5px solid ${C.border}`, color: C.text }}>
          <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, fontSize: 20, marginBottom: 8 }}>
            Something broke rendering your data
          </div>
          <div className="text-sm" style={{ color: C.muted, marginBottom: 16, lineHeight: 1.6 }}>
            The app hit an unexpected error. Your saved data is still in this browser. Export a backup
            first (so you never lose it), then reload. If reloading keeps crashing, restore the backup
            on a fresh load or reset the data.
          </div>
          <div className="flex gap-2" style={{ flexWrap: "wrap" }}>
            <button
              onClick={downloadBackup}
              className="text-sm px-3 py-1.5 rounded-lg"
              style={{ background: C.amber, color: "#2A1A02", fontWeight: 500, border: "none", cursor: "pointer" }}
            >
              Export backup
            </button>
            <button
              onClick={() => window.location.reload()}
              className="text-sm px-3 py-1.5 rounded-lg"
              style={{ background: "transparent", color: C.muted, border: `0.5px solid ${C.border}`, cursor: "pointer" }}
            >
              Reload
            </button>
          </div>
          <div className="text-xs" style={{ color: C.faint, marginTop: 16, fontFamily: "monospace", whiteSpace: "pre-wrap" }}>
            {String(this.state.error && this.state.error.message ? this.state.error.message : this.state.error)}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <div className="min-h-screen p-4 sm:p-6" style={{ background: "#04070D" }}>
      <div className="mx-auto" style={{ maxWidth: 1100 }}>
        <ErrorBoundary>
          <AuthGate>
            <App />
          </AuthGate>
        </ErrorBoundary>
      </div>
    </div>
  </React.StrictMode>
);
