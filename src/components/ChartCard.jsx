import { ResponsiveContainer } from "recharts";
import { C } from "../theme";

export function ChartCard({ title, height = 240, children }) {
  return (
    <div className="rounded-xl p-4" style={{ background: C.panel, border: `0.5px solid ${C.border}` }}>
      <div className="text-sm mb-3" style={{ color: C.textMuted, fontWeight: 500 }}>{title}</div>
      <div style={{ width: "100%", height }}>
        <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>
      </div>
    </div>
  );
}

