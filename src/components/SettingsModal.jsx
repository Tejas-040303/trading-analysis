import { useState } from "react";
import { Download, Upload, X } from "lucide-react";
import { C } from "../theme";
import { DEFAULT_SETTINGS } from "../lib/analytics";
import { estimateUsageBytes } from "../lib/storage";

export function SettingsModal({ settings, onSave, onClose, onExport, onImportClick }) {
  const [draft, setDraft] = useState(settings);
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
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
        onClick={(e) => e.stopPropagation()}
        className="rounded-2xl"
        style={{ background: C.panel, border: `0.5px solid ${C.border}`, width: "100%", maxWidth: 460, marginTop: 32, marginBottom: 32, padding: 20 }}
      >
        <div className="flex items-center justify-between mb-4">
          <span style={{ color: C.text, fontWeight: 600, fontSize: 17, fontFamily: "'Space Grotesk', sans-serif" }}>Settings</span>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: C.textMuted, cursor: "pointer" }} title="Close"><X size={18} /></button>
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
          <div className="text-xs mb-2" style={{ color: C.textFaint }}>Your data lives only in this browser. Export a JSON backup, or import one to restore it after a cache clear or on another device.</div>
          <div className="flex gap-2">
            <button onClick={onExport} style={btn(C.panelAlt, C.text, `0.5px solid ${C.border}`)}><Download size={14} /> Export JSON</button>
            <button onClick={onImportClick} style={btn(C.panelAlt, C.text, `0.5px solid ${C.border}`)}><Upload size={14} /> Import JSON</button>
          </div>
          {(() => {
            const mb = estimateUsageBytes() / (1024 * 1024);
            // Browsers cap localStorage near 5 MB; warn as the journal + candles approach it.
            const tone = mb >= 4.5 ? C.rose : mb >= 3.5 ? C.amber : C.textFaint;
            return (
              <div className="text-xs mt-2" style={{ color: tone }}>
                Storage in use: ~{mb.toFixed(2)} MB of ~5 MB.
                {mb >= 3.5 && " Approaching the browser limit — export a backup and consider resetting candle data."}
              </div>
            );
          })()}
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

