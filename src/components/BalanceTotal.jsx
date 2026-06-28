import { C } from "../theme";
import { fmtMoney } from "../lib/format";

export function BalanceTotal({ label, value, tone }) {
  const color =
    tone === "good" ? C.emerald : tone === "bad" ? C.rose : tone === "amber" ? C.amber : C.text;
  return (
    <div className="rounded-lg p-3" style={{ background: C.panelAlt, border: `0.5px solid ${C.border}` }}>
      <div className="text-xs mb-1" style={{ color: C.textMuted }}>{label}</div>
      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 16, fontWeight: 500, color }}>
        {fmtMoney(value)}
      </div>
    </div>
  );
}

