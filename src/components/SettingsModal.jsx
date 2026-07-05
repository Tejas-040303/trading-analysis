import { useState, useEffect, useRef } from "react";
import { Download, Upload, X, FolderOpen, RefreshCw, KeyRound, Trash2 } from "lucide-react";
import { C } from "../theme";
import { DEFAULT_SETTINGS } from "../lib/analytics";
import { isFsSyncSupported, pickSyncFolder, getSavedFolder, readLatest } from "../lib/fsSync";
import { createAgentKey, listAgentKeys, deleteAgentKey } from "../lib/db";
import { SUPABASE_URL } from "../lib/supabaseClient";

// "3 min ago" formatting for the agent heartbeat.
function agoLabel(iso) {
  if (!iso) return "never";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

export function SettingsModal({ settings, onSave, onClose, onExport, onImportClick, onMt5Sync }) {
  const [draft, setDraft] = useState(settings);
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const dialogRef = useRef(null);

  // ── MT5 "Sync folder" (File System Access API; Chrome/Edge only) ──
  const fsSupported = isFsSyncSupported();
  const [folder, setFolder] = useState(null);          // FileSystemDirectoryHandle
  const [folderName, setFolderName] = useState("");
  const [sync, setSync] = useState({ status: "idle" }); // idle | busy | done | error

  useEffect(() => {
    if (!fsSupported) return;
    getSavedFolder()
      .then((h) => { if (h) { setFolder(h); setFolderName(h.name || "sync folder"); } })
      .catch(() => {});
  }, [fsSupported]);

  const chooseFolder = async () => {
    try {
      const h = await pickSyncFolder();
      setFolder(h);
      setFolderName(h.name || "sync folder");
      setSync({ status: "idle" });
    } catch (e) {
      if (e && e.name === "AbortError") return; // user cancelled the picker
      setSync({ status: "error", message: e?.message || "Could not open that folder." });
    }
  };

  const syncNow = async () => {
    setSync({ status: "busy" });
    try {
      const text = await readLatest(folder);
      const stats = await onMt5Sync(text);
      setSync({ status: "done", stats });
    } catch (e) {
      setSync({ status: "error", message: e?.message || "Sync failed." });
    }
  };

  // ── Signals agent keys (P8.3) ──
  const [agentKeys, setAgentKeys] = useState(null);   // null = loading
  const [freshKey, setFreshKey] = useState(null);     // plaintext, shown once after generation
  const [agentErr, setAgentErr] = useState("");
  const ingestUrl = `${SUPABASE_URL}/functions/v1/ingest`;

  const refreshAgentKeys = () => {
    listAgentKeys().then(setAgentKeys).catch((e) => { setAgentKeys([]); setAgentErr(e.message); });
  };
  useEffect(refreshAgentKeys, []);

  const generateKey = async () => {
    setAgentErr("");
    try {
      const created = await createAgentKey(`Agent key ${new Date().toISOString().slice(0, 10)}`);
      setFreshKey(created.key);
      refreshAgentKeys();
    } catch (e) {
      setAgentErr(e.message);
    }
  };

  const revokeKey = async (id) => {
    setAgentErr("");
    try {
      await deleteAgentKey(id);
      refreshAgentKeys();
    } catch (e) {
      setAgentErr(e.message);
    }
  };

  const lastSeen = agentKeys && agentKeys.length
    ? agentKeys.reduce((max, k) => (k.last_seen && (!max || k.last_seen > max) ? k.last_seen : max), null)
    : null;
  const agentLive = lastSeen && Date.now() - new Date(lastSeen).getTime() < 5 * 60 * 1000;

  // Modal a11y: focus the dialog on open, trap Tab within it, close on Escape,
  // and restore focus to the triggering control when it unmounts.
  useEffect(() => {
    const prevActive = document.activeElement;
    dialogRef.current?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const f = dialogRef.current.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (prevActive instanceof HTMLElement) prevActive.focus();
    };
  }, [onClose]);
  const fieldStyle = {
    background: C.panelAlt,
    border: `0.5px solid ${C.border}`,
    color: C.text,
    borderRadius: 8,
    padding: "6px 10px",
    fontSize: 14,
    width: "100%",
    fontFamily: "'JetBrains Mono', monospace",
  };
  const btn = (bg, color, border) => ({
    background: bg,
    color,
    border: border || "none",
    borderRadius: 8,
    padding: "6px 12px",
    fontSize: 14,
    fontWeight: 500,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
  });
  const numRow = (k, label, hint) => (
    <div className="mb-4">
      <div className="text-sm mb-1" style={{ color: C.text }}>{label}</div>
      {hint && <div className="text-xs mb-1.5" style={{ color: C.textFaint }}>{hint}</div>}
      <input
        type="number"
        value={draft[k] ?? ""}
        onChange={(e) => set(k, e.target.value === "" ? "" : Number(e.target.value))}
        style={fieldStyle}
      />
    </div>
  );
  const save = () => {
    const num = (v, d) => (v === "" || v == null || Number.isNaN(Number(v)) ? d : Number(v));
    onSave({
      seriousStart: draft.seriousStart || DEFAULT_SETTINGS.seriousStart,
      overtradeThreshold: num(draft.overtradeThreshold, DEFAULT_SETTINGS.overtradeThreshold),
      tiltStreakMin: num(draft.tiltStreakMin, DEFAULT_SETTINGS.tiltStreakMin),
      revengeWindowMin: num(draft.revengeWindowMin, DEFAULT_SETTINGS.revengeWindowMin),
      brokerGmtOffsetHours:
        draft.brokerGmtOffsetHours === "" || draft.brokerGmtOffsetHours == null
          ? null
          : Number(draft.brokerGmtOffsetHours),
      swingLookback: num(draft.swingLookback, DEFAULT_SETTINGS.swingLookback),
    });
  };
  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(2,4,8,0.7)", zIndex: 50, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 16, overflowY: "auto" }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="rounded-2xl"
        style={{ background: C.panel, border: `0.5px solid ${C.border}`, width: "100%", maxWidth: 460, marginTop: 32, marginBottom: 32, padding: 20 }}
      >
        <div className="flex items-center justify-between mb-4">
          <span id="settings-title" style={{ color: C.text, fontWeight: 600, fontSize: 17, fontFamily: "'Space Grotesk', sans-serif" }}>Settings</span>
          <button onClick={onClose} aria-label="Close settings" style={{ background: "transparent", border: "none", color: C.textMuted, cursor: "pointer" }} title="Close"><X size={18} /></button>
        </div>

        <div className="mb-4">
          <div className="text-sm mb-1" style={{ color: C.text }}>Serious-trading start date</div>
          <div className="text-xs mb-1.5" style={{ color: C.textFaint }}>Trades before this are archived as your beginner era and excluded from the stats.</div>
          <input type="date" value={draft.seriousStart || ""} onChange={(e) => set("seriousStart", e.target.value)} style={fieldStyle} />
        </div>

        {numRow("overtradeThreshold", "Overtrade threshold", 'Trades in a day at or above this flag the day as "Busy".')}
        {numRow("tiltStreakMin", "Tilt streak", "Consecutive losing trades that count as a tilt cluster.")}
        {numRow("revengeWindowMin", "Revenge window (minutes)", "A same-symbol re-entry within this many minutes of a loss is flagged as revenge.")}
        {numRow("brokerGmtOffsetHours", "Broker GMT offset (hours)", "Your MT5 server's offset from GMT. Used for session bucketing (Asian/London/NY); leave blank if unsure.")}

        <div className="mt-2 pt-4 mb-4" style={{ borderTop: `0.5px solid ${C.border}` }}>
          <div className="text-sm mb-2" style={{ color: C.text, fontWeight: 500 }}>Strategy overlay</div>
        </div>
        {numRow("swingLookback", "Swing lookback (bars)", "Fractal pivot lookback for SMC swing detection. Default 5 — higher values detect larger swings, lower values are more sensitive.")}

        <div className="mt-2 pt-4" style={{ borderTop: `0.5px solid ${C.border}` }}>
          <div className="text-sm mb-1" style={{ color: C.text }}>Backup</div>
          <div className="text-xs mb-2" style={{ color: C.textFaint }}>Your journal lives in your cloud account (private, tied to your login) and is available from any browser you sign in on. JSON backups remain as an offline safety copy — export one now and then, or import one to restore/merge.</div>
          <div className="flex gap-2">
            <button onClick={onExport} style={btn(C.panelAlt, C.text, `0.5px solid ${C.border}`)}><Download size={14} /> Export JSON</button>
            <button onClick={onImportClick} style={btn(C.panelAlt, C.text, `0.5px solid ${C.border}`)}><Upload size={14} /> Import JSON</button>
          </div>
        </div>

        <div className="mt-2 pt-4" style={{ borderTop: `0.5px solid ${C.border}` }}>
          <div className="text-sm mb-1" style={{ color: C.text }}>
            Sync from MT5 <span className="text-xs" style={{ color: C.amber }}>beta</span>
          </div>
          {fsSupported ? (
            <>
              <div className="text-xs mb-2" style={{ color: C.textFaint }}>
                Point this at the folder the MT5 sync helper writes{" "}
                <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>latest.json</span> into, then Sync to pull your latest
                trades &amp; candles into your cloud journal.
              </div>
              <div className="flex gap-2 flex-wrap items-center">
                <button onClick={chooseFolder} style={btn(C.panelAlt, C.text, `0.5px solid ${C.border}`)}>
                  <FolderOpen size={14} /> {folder ? "Change folder" : "Choose sync folder"}
                </button>
                <button
                  onClick={syncNow}
                  disabled={!folder || sync.status === "busy"}
                  style={{ ...btn(C.amber, "#2A1A02"), opacity: !folder || sync.status === "busy" ? 0.5 : 1, cursor: !folder || sync.status === "busy" ? "not-allowed" : "pointer" }}
                >
                  <RefreshCw size={14} /> {sync.status === "busy" ? "Syncing…" : "Sync now"}
                </button>
              </div>
              {folder && (
                <div className="text-xs mt-2" style={{ color: C.textFaint }}>
                  Folder: <span style={{ fontFamily: "'JetBrains Mono', monospace", color: C.textMuted }}>{folderName}</span>
                </div>
              )}
              {sync.status === "done" && (
                <div className="text-xs mt-1" style={{ color: C.emerald }}>
                  Synced ✓ {sync.stats.positions} trades · {sync.stats.candleGroups} candle set{sync.stats.candleGroups === 1 ? "" : "s"}
                  {sync.stats.skipped ? ` · ${sync.stats.skipped} skipped` : ""}.
                </div>
              )}
              {sync.status === "error" && (
                <div className="text-xs mt-1" style={{ color: C.rose }}>{sync.message}</div>
              )}
            </>
          ) : (
            <div className="text-xs mb-2" style={{ color: C.textFaint }}>
              One-click folder sync needs <span style={{ color: C.amber }}>Chrome or Edge</span>. On other browsers, run the helper
              and load its <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>latest.json</span> via <strong>Import JSON</strong> above.
            </div>
          )}
        </div>

        <div className="mt-2 pt-4" style={{ borderTop: `0.5px solid ${C.border}` }}>
          <div className="text-sm mb-1" style={{ color: C.text }}>
            Signals agent <span className="text-xs" style={{ color: C.amber }}>P8</span>
          </div>
          <div className="text-xs mb-2" style={{ color: C.textFaint }}>
            The background helper (<span style={{ fontFamily: "'JetBrains Mono', monospace" }}>tools/mt5-sync/agent.py</span>) pushes
            trades &amp; candles to your cloud journal continuously. Generate a key, put it in the helper's{" "}
            <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>config.json</span>, and run the agent while MT5 is open.
          </div>
          <div className="text-xs mb-2" style={{ color: agentLive ? C.emerald : C.textFaint }}>
            {agentKeys === null ? "Checking agent status…" : `Agent last seen: ${agoLabel(lastSeen)}${agentLive ? " · connected" : ""}`}
          </div>
          {agentKeys && agentKeys.length > 0 && (
            <div className="mb-2">
              {agentKeys.map((k) => (
                <div key={k.id} className="flex items-center justify-between gap-2 text-xs py-1" style={{ color: C.textMuted, borderBottom: `0.5px solid ${C.borderSoft}` }}>
                  <span>{k.label || "Agent key"} · created {new Date(k.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })} · seen {agoLabel(k.last_seen)}</span>
                  <button
                    onClick={() => revokeKey(k.id)}
                    aria-label={`Revoke ${k.label || "agent key"}`}
                    title="Revoke this key"
                    style={{ background: "transparent", border: "none", color: C.rose, cursor: "pointer", padding: 2 }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <button onClick={generateKey} style={btn(C.panelAlt, C.text, `0.5px solid ${C.border}`)}>
            <KeyRound size={14} /> Generate agent key
          </button>
          {freshKey && (
            <div className="text-xs mt-2 p-2 rounded-lg" style={{ background: C.panelAlt, border: `0.5px solid ${C.amberDim}` }}>
              <div style={{ color: C.amber, marginBottom: 4 }}>Copy this key now — it is shown only once.</div>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", color: C.text, wordBreak: "break-all", userSelect: "all" }}>{freshKey}</div>
              <div style={{ color: C.textFaint, marginTop: 6 }}>
                In <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>tools/mt5-sync/config.json</span> set{" "}
                <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>"agentKey"</span> to it and{" "}
                <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>"ingestUrl"</span> to{" "}
                <span style={{ fontFamily: "'JetBrains Mono', monospace", color: C.textMuted, wordBreak: "break-all" }}>{ingestUrl}</span>
              </div>
            </div>
          )}
          {agentErr && <div className="text-xs mt-2" style={{ color: C.rose }}>{agentErr}</div>}
        </div>

        <div className="flex items-center justify-between mt-5">
          <button onClick={() => setDraft({ ...DEFAULT_SETTINGS })} style={{ background: "transparent", border: "none", color: C.textFaint, fontSize: 13, cursor: "pointer" }}>Reset to defaults</button>
          <div className="flex gap-2">
            <button onClick={onClose} style={btn("transparent", C.textMuted, `0.5px solid ${C.border}`)}>Cancel</button>
            <button onClick={save} style={btn(C.amber, "#2A1A02")}>Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}

