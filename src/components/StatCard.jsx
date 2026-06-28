import { C } from "../theme";

export function StatCard({ icon: Icon, label, value, sub, tone }) {
  const toneColor = tone === "good" ? C.emerald : tone === "bad" ? C.rose : C.text;
  return (
    <div
      className="rounded-xl p-3"
      style={{ background: C.panel, border: `0.5px solid ${C.border}` }}
    >
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon size={13} style={{ color: C.textFaint }} />
        <span className="text-xs" style={{ color: C.textMuted }}>{label}</span>
      </div>
      <div
        className="text-xl"
        style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 500, color: toneColor }}
      >
        {value}
      </div>
      {sub && <div className="text-xs mt-0.5" style={{ color: C.textFaint }}>{sub}</div>}
    </div>
  );
}

